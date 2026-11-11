const UPLOAD_PATH = /^\/api\/v1\/assets\/([0-9a-f-]{36})\/source\?ticket=[A-Za-z0-9%._-]+$/i;

export function createAssetUploader({ assets, request, upload, isCurrent }) {
  let running;
  const check = () => { if (!isCurrent()) throw Object.assign(new Error('账号已切换，图片上传已停止'), { code: 'SYNC_CONTEXT_CHANGED' }); };
  async function step() {
    check(); const asset = await assets.nextAssetUpload(); check();
    if (!asset) return { status: 'no-asset-work' };
    try {
      try {
        const remote = await request(`/assets/${asset.id}`); check();
        if (remote?.status === 'ready') { await assets.completeAssetUpload(asset.id, remote); return { status: 'asset-ready' }; }
      } catch (error) { if (error.status !== 404) throw error; }
      let registered = await request('/assets/uploads', { method: 'POST', body: { requestId: asset.uploadRequestId, assetId: asset.id,
        mimeType: asset.mimeType, size: asset.size, sha256: asset.sha256 } });
      check();
      if (registered?.assetId !== asset.id || !UPLOAD_PATH.test(registered?.uploadUrl ?? '') || registered.headers?.['Content-Type'] !== asset.mimeType) throw new Error('图片上传凭据格式无效');
      if (Date.parse(registered.expiresAt) <= Date.now() + 5000) {
        registered = await request(`/assets/${asset.id}/upload-credentials`, { method: 'POST', body: { requestId: crypto.randomUUID(), size: asset.size, sha256: asset.sha256 } });
        check();
      }
      try { await upload(registered.uploadUrl.replace(/^\/api\/v1/, ''), { mimeType: asset.mimeType, bytes: asset.bytes }); }
      catch (error) {
        if (error.code !== 'ASSET_UPLOAD_LINK_INVALID') throw error;
        const renewed = await request(`/assets/${asset.id}/upload-credentials`, { method: 'POST', body: { requestId: crypto.randomUUID(), size: asset.size, sha256: asset.sha256 } });
        check(); await upload(renewed.uploadUrl.replace(/^\/api\/v1/, ''), { mimeType: asset.mimeType, bytes: asset.bytes });
      }
      check();
      const completed = await request(`/assets/${asset.id}/complete`, { method: 'POST', body: { requestId: asset.completeRequestId } });
      check();
      if (completed?.assetId !== asset.id || completed.status !== 'ready') throw new Error('图片处理结果无效');
      await assets.completeAssetUpload(asset.id, completed); check();
      return { status: 'asset-ready' };
    } catch (error) {
      if (!['SYNC_CONTEXT_CHANGED', 'AUTH_CONTEXT_CHANGED'].includes(error?.code)) await assets.recordAssetUploadFailure?.(asset.id, error);
      throw error;
    }
  }
  return { step: () => running ??= step().finally(() => { running = undefined; }) };
}
