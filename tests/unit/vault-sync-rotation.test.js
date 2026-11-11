import { describe, expect, it, vi } from 'vitest';
import { createVaultSync } from '../../apps/client/src/services/vault-sync.js';

const id = (index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
function rotationJob(status = 'rotation-ready', count = 51) {
  return { id: 'vault-key-rotation', status, startRequestId: id(9001), commitRequestId: id(9002),
    batchRequestIds: [id(9101), id(9102)], baseConfigRevision: '7', rotationId: null,
    config: { kdf: { algorithm: 'argon2id', memoryKiB: 19456, iterations: 2, parallelism: 1, hashLength: 32 },
      salt: 'A'.repeat(22), wrappedKey: 'B'.repeat(64), wrapNonce: 'C'.repeat(16), cryptoVersion: 1,
      recoveryWrappedKey: 'D'.repeat(64), recoveryNonce: 'E'.repeat(16), recoveryVersion: 1 },
    items: Array.from({ length: count }, (_, index) => ({ id: id(index + 1), revision: String(index + 1),
      ciphertext: 'F'.repeat(64), nonce: 'G'.repeat(16), cryptoVersion: 1 })) };
}
function harness(initialJob, { loseFirstCommit = false } = {}) {
  let job = structuredClone(initialJob), lost = false;
  const store = {
    getVaultKeyRotationJob: vi.fn(async () => structuredClone(job)),
    bindVaultKeyRotation: vi.fn(async (rotationId) => { job.rotationId = rotationId; }),
    completeVaultKeyRotation: vi.fn(async () => { job = null; }),
    vaultSyncSummary: vi.fn(async () => ({ waiting: job?.status === 'rotation-ready' ? 1 : 0, conflicts: 0 })),
    getVaultConfig: vi.fn(async () => null), nextVaultSyncJob: vi.fn(async () => null),
    applyVaultCloudConfig: vi.fn(), applyVaultCloudItems: vi.fn(),
  };
  const calls = [];
  const request = vi.fn(async (path, options = {}) => {
    calls.push({ path, body: structuredClone(options.body) });
    if (path === '/vault/key-rotations') return { rotation: { id: id(9999) } };
    if (path.endsWith('/items') && path.startsWith('/vault/key-rotations/')) return { rotation: { id: id(9999) } };
    if (path.endsWith('/commit')) {
      if (loseFirstCommit && !lost) { lost = true; throw new Error('提交响应丢失'); }
      return { rotation: { id: id(9999), status: 'completed' }, config: { revision: '8', updatedAt: new Date().toISOString() },
        items: initialJob.items.map((item) => ({ ...item, revision: String(BigInt(item.revision) + 1n), updatedAt: new Date().toISOString(), deletedAt: null })) };
    }
    if (path === '/vault/config') return { config: null };
    if (path.startsWith('/vault/items')) return { items: [], nextCursor: null };
    throw new Error(`Unexpected request ${path}`);
  });
  return { store, request, calls, sync: createVaultSync({ store, request }) };
}

describe('vault data-key rotation sync journal', () => {
  it('does not upload a prepared rotation before the recovery key acknowledgement', async () => {
    const { sync, request, store } = harness(rotationJob('rotation-prepared', 1));
    await expect(sync.run()).resolves.toEqual({ waiting: 0, conflicts: 0 });
    expect(request).not.toHaveBeenCalled(); expect(store.completeVaultKeyRotation).not.toHaveBeenCalled();
  });

  it('uses fixed requests for staged batches and resumes safely after a lost commit response', async () => {
    const original = rotationJob(), { sync, calls, store } = harness(original, { loseFirstCommit: true });
    await expect(sync.run()).rejects.toThrow('提交响应丢失');
    await expect(sync.run()).resolves.toEqual({ waiting: 0, conflicts: 0 });
    expect(store.bindVaultKeyRotation).toHaveBeenCalledTimes(1); expect(store.completeVaultKeyRotation).toHaveBeenCalledTimes(1);
    expect(calls.filter((call) => call.path === '/vault/key-rotations')).toHaveLength(1);
    const batches = calls.filter((call) => call.path.endsWith('/items'));
    expect(batches).toHaveLength(4); expect(batches.map((call) => call.body.items.length)).toEqual([50, 1, 50, 1]);
    expect(batches.map((call) => call.body.requestId)).toEqual([id(9101), id(9102), id(9101), id(9102)]);
    const commits = calls.filter((call) => call.path.endsWith('/commit'));
    expect(commits).toHaveLength(2); expect(commits.every((call) => call.body.requestId === id(9002))).toBe(true);
  });
});
