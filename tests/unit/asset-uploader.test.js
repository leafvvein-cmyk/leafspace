import { describe, it, expect, vi } from 'vitest';
import { createAssetUploader } from '../../apps/client/src/services/asset-uploader.js';

const id = '11111111-1111-4111-8111-111111111111';
const asset = { id, mimeType: 'image/webp', size: 3, sha256: 'a'.repeat(64), bytes: new Uint8Array([1, 2, 3]),
  uploadRequestId: '22222222-2222-4222-8222-222222222222', completeRequestId: '33333333-3333-4333-8333-333333333333' };
const credentials = () => ({ assetId: id, uploadUrl: `/api/v1/assets/${id}/source?ticket=safe.ticket`, headers: { 'Content-Type': 'image/webp' }, expiresAt: new Date(Date.now() + 60000).toISOString() });

describe('local image uploader', () => {
  it('checks ownership, registers, uploads exact bytes, completes and acknowledges locally', async () => {
    const complete = vi.fn(async () => {}), upload = vi.fn(async () => ({ received: true }));
    const request = vi.fn(async (path) => {
      if (path === `/assets/${id}`) throw Object.assign(new Error('missing'), { status: 404 });
      if (path === '/assets/uploads') return credentials();
      return { assetId: id, status: 'ready', width: 2, height: 2 };
    });
    const uploader = createAssetUploader({ assets: { nextAssetUpload: async () => asset, completeAssetUpload: complete }, request, upload, isCurrent: () => true });
    expect(await uploader.step()).toEqual({ status: 'asset-ready' });
    expect(upload).toHaveBeenCalledWith(`/assets/${id}/source?ticket=safe.ticket`, { mimeType: 'image/webp', bytes: asset.bytes });
    expect(complete).toHaveBeenCalledWith(id, { assetId: id, status: 'ready', width: 2, height: 2 });
  });

  it('repairs a lost completion response from remote status without uploading bytes twice', async () => {
    const complete = vi.fn(async () => {}), upload = vi.fn();
    const uploader = createAssetUploader({ assets: { nextAssetUpload: async () => asset, completeAssetUpload: complete },
      request: async () => ({ assetId: id, status: 'ready', width: 2, height: 2 }), upload, isCurrent: () => true });
    expect(await uploader.step()).toEqual({ status: 'asset-ready' });
    expect(upload).not.toHaveBeenCalled(); expect(complete).toHaveBeenCalledOnce();
  });

  it('records an upload failure locally but never records an account-context cancellation', async () => {
    const record = vi.fn(async () => {});
    const uploader = createAssetUploader({ assets: { nextAssetUpload: async () => asset, recordAssetUploadFailure: record },
      request: async () => { throw Object.assign(new Error('offline'), { code: 'NETWORK_UNAVAILABLE' }); }, upload: vi.fn(), isCurrent: () => true });
    await expect(uploader.step()).rejects.toMatchObject({ code: 'NETWORK_UNAVAILABLE' });
    expect(record).toHaveBeenCalledWith(id, expect.objectContaining({ code: 'NETWORK_UNAVAILABLE' }));

    record.mockClear();
    const cancelled = createAssetUploader({ assets: { nextAssetUpload: async () => asset, recordAssetUploadFailure: record },
      request: async () => { throw Object.assign(new Error('changed'), { code: 'AUTH_CONTEXT_CHANGED' }); }, upload: vi.fn(), isCurrent: () => true });
    await expect(cancelled.step()).rejects.toMatchObject({ code: 'AUTH_CONTEXT_CHANGED' });
    expect(record).not.toHaveBeenCalled();
  });
});
