function sameConfig(local, remote) {
  const kdfKeys = ['algorithm','memoryKiB','iterations','parallelism','hashLength'];
  return ['salt','wrappedKey','wrapNonce','cryptoVersion','recoveryWrappedKey','recoveryNonce','recoveryVersion'].every((key) => JSON.stringify(local?.[key]) === JSON.stringify(remote?.[key]))
    && kdfKeys.every((key) => local?.kdf?.[key] === remote?.kdf?.[key]);
}

export function createVaultSync({ store, request, isCurrent = () => true }) {
  let running = null;
  const configFields = (value) => ({ kdf: value.kdf, salt: value.salt, wrappedKey: value.wrappedKey, wrapNonce: value.wrapNonce,
    cryptoVersion: value.cryptoVersion, recoveryWrappedKey: value.recoveryWrappedKey, recoveryNonce: value.recoveryNonce,
    recoveryVersion: value.recoveryVersion });
  async function processKeyRotation() {
    let job = await store.getVaultKeyRotationJob?.();
    if (!job) return 'none';
    if (job.status === 'rotation-prepared') return 'awaiting-confirmation';
    if (job.status !== 'rotation-ready') throw new Error('密码本数据密钥轮换状态无效');
    if (!isCurrent()) throw new Error('登录账号已变化，密码本同步已停止');
    if (!job.rotationId) {
      const started = await request('/vault/key-rotations', { method: 'POST', body: { requestId: job.startRequestId,
        baseConfigRevision: job.baseConfigRevision, itemCount: job.items.length, ...configFields(job.config) } });
      await store.bindVaultKeyRotation(started.rotation.id); job = { ...job, rotationId: started.rotation.id };
    }
    for (let offset = 0, batch = 0; offset < job.items.length; offset += 50, batch += 1) {
      if (!isCurrent()) throw new Error('登录账号已变化，密码本同步已停止');
      const items = job.items.slice(offset, offset + 50).map((item) => ({ id: item.id, baseRevision: item.revision,
        ciphertext: item.ciphertext, nonce: item.nonce, cryptoVersion: item.cryptoVersion }));
      await request(`/vault/key-rotations/${job.rotationId}/items`, { method: 'PUT', body: { requestId: job.batchRequestIds[batch], items } });
    }
    if (!isCurrent()) throw new Error('登录账号已变化，密码本同步已停止');
    const committed = await request(`/vault/key-rotations/${job.rotationId}/commit`, { method: 'POST', body: { requestId: job.commitRequestId } });
    await store.completeVaultKeyRotation(committed); return 'completed';
  }
  async function pullItems() {
    let cursor = null;
    do {
      if (!isCurrent()) throw new Error('登录账号已变化，密码本同步已停止');
      const page = await request(`/vault/items?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      await store.applyVaultCloudItems(page.items); cursor = page.nextCursor;
    } while (cursor);
  }
  async function execute() {
    const rotation = await processKeyRotation();
    if (rotation === 'awaiting-confirmation') return store.vaultSyncSummary();
    const initialRemote = (await request('/vault/config')).config;
    let local = await store.getVaultConfig();
    if (!local && initialRemote) { await store.applyVaultCloudConfig(initialRemote); local = await store.getVaultConfig(); }
    else if (local && initialRemote && sameConfig(local, initialRemote)) await store.applyVaultCloudConfig(initialRemote);

    for (let count = 0; count < 500; count++) {
      if (!isCurrent()) throw new Error('登录账号已变化，密码本同步已停止');
      const job = await store.nextVaultSyncJob(); if (!job) break;
      try {
        if (job.itemId === 'config') {
          const value = job.payload;
          const result = await request('/vault/config', { method: 'PUT', body: { requestId: job.requestId, baseRevision: value.revision ?? '0',
            kdf: value.kdf, salt: value.salt, wrappedKey: value.wrappedKey, wrapNonce: value.wrapNonce, cryptoVersion: value.cryptoVersion,
            ...(value.recoveryVersion ? { recoveryWrappedKey: value.recoveryWrappedKey, recoveryNonce: value.recoveryNonce, recoveryVersion: value.recoveryVersion } : {}) } });
          await store.completeVaultSyncJob(job.id, result.config);
        } else if (job.payload.deletedAt) {
          const result = await request(`/vault/items/${job.itemId}?baseRevision=${encodeURIComponent(job.payload.revision ?? '0')}`,
            { method: 'DELETE', idempotencyKey: job.requestId });
          await store.completeVaultSyncJob(job.id, result.item);
        } else {
          const value = job.payload;
          const result = await request(`/vault/items/${job.itemId}`, { method: 'PUT', body: { requestId: job.requestId,
            baseRevision: value.revision ?? '0', ciphertext: value.ciphertext, nonce: value.nonce, cryptoVersion: value.cryptoVersion } });
          await store.completeVaultSyncJob(job.id, result.item);
        }
      } catch (error) {
        if (error.code === 'REVISION_CONFLICT') {
          await store.failVaultSyncJob(job.id, error.details?.currentConfig ?? error.details?.currentItem ?? null); continue;
        }
        throw error;
      }
    }
    const remoteConfig = (await request('/vault/config')).config;
    local = await store.getVaultConfig();
    if (remoteConfig) await store.applyVaultCloudConfig(remoteConfig);
    if (remoteConfig && local && !sameConfig(local, remoteConfig)) return store.vaultSyncSummary();
    await pullItems(); return store.vaultSyncSummary();
  }
  return {
    run() { if (!running) running = execute().finally(() => { running = null; }); return running; },
    summary: () => store.vaultSyncSummary(),
  };
}
