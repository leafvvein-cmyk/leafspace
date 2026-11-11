const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const SAFE_ERROR_CODE = /^[A-Z0-9_]{1,64}$/;
export const LOCAL_IMAGE_LIMITS = Object.freeze({ inputBytes: 10 * 1024 * 1024, pixels: 25_000_000, longestEdge: 2560 });
export const ASSET_UPLOAD_RETRY_LIMIT = 3;
export const ASSET_UPLOAD_ERROR_MESSAGE = '图片上传未完成，请检查网络后重试。';

export function assetUploadFailure(asset, error) {
  const uploadAttempts = Math.min(Number.isInteger(asset?.uploadAttempts) && asset.uploadAttempts >= 0 ? asset.uploadAttempts + 1 : 1, ASSET_UPLOAD_RETRY_LIMIT);
  const code = SAFE_ERROR_CODE.test(error?.code ?? '') ? error.code : 'UPLOAD_FAILED';
  return { ...asset, status: uploadAttempts >= ASSET_UPLOAD_RETRY_LIMIT ? 'error' : 'local-only', uploadAttempts,
    error: { code, message: ASSET_UPLOAD_ERROR_MESSAGE }, updatedAt: new Date().toISOString() };
}

export function assetProblem(asset) {
  const { bytes: _bytes, sourceBase64: _sourceBase64, ...metadata } = asset;
  return structuredClone(metadata);
}

export function contentAssetIds(content) {
  const ids = [];
  const visit = (node) => {
    if (node?.type === 'image' && UUID.test(node.attrs?.assetId ?? '')) ids.push(node.attrs.assetId);
    if (Array.isArray(node?.content)) node.content.forEach(visit);
  };
  visit(content); return [...new Set(ids)];
}

export function remapContentAssetIds(content, mapping) {
  const copy = structuredClone(content);
  const visit = (node) => {
    if (node?.type === 'image' && mapping.has(node.attrs?.assetId)) node.attrs.assetId = mapping.get(node.attrs.assetId);
    if (Array.isArray(node?.content)) node.content.forEach(visit);
  };
  visit(copy); return copy;
}

export function withoutContentAssets(content, assetIds) {
  const omitted = assetIds instanceof Set ? assetIds : new Set(assetIds);
  const nonEmptyContainers = new Set(['blockquote', 'bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem']);
  const visit = (node) => {
    if (node?.type === 'image' && omitted.has(node.attrs?.assetId)) return null;
    if (!node || typeof node !== 'object') return node;
    const copy = { ...node };
    if (Array.isArray(node.content)) {
      copy.content = node.content.map(visit).filter(Boolean);
      if (!copy.content.length && nonEmptyContainers.has(copy.type)) return null;
      if (!copy.content.length && copy.type === 'doc') copy.content = [{ type: 'paragraph' }];
    }
    return copy;
  };
  return visit(content) ?? { type: 'doc', content: [] };
}

export function imageBytes(value) {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new Error('图片数据无法读取');
}

export function validateLocalAsset(record) {
  const bytes = imageBytes(record?.bytes);
  if (!UUID.test(record?.id ?? '') || !UUID.test(record?.entryId ?? '')) throw new Error('图片标识无效');
  if (!IMAGE_TYPES.has(record?.mimeType)) throw new Error('只支持 JPEG、PNG 或 WebP 图片');
  if (!Number.isInteger(record?.size) || record.size !== bytes.byteLength || record.size < 1 || record.size > LOCAL_IMAGE_LIMITS.inputBytes) throw new Error('图片大小无效或超过 10 MB');
  if (!SHA256.test(record?.sha256 ?? '')) throw new Error('图片校验值无效');
  if (!Number.isInteger(record?.width) || !Number.isInteger(record?.height) || record.width < 1 || record.height < 1 || record.width * record.height > LOCAL_IMAGE_LIMITS.pixels) throw new Error('图片尺寸无效或像素过大');
  return { ...record, status: record.status ?? 'local-only', bytes };
}

export function bytesToBase64(value) {
  const bytes = imageBytes(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

export function base64ToBytes(value) {
  if (typeof value !== 'string' || !value.length) throw new Error('本机图片数据不完整');
  const binary = atob(value), bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function canvasBlob(canvas, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('图片压缩失败')), 'image/webp', quality));
}

/** Decode, orient, resize and re-encode before the bytes enter durable storage. */
export async function prepareLocalImage(file, entryId, { createBitmap = globalThis.createImageBitmap } = {}) {
  if (!(file instanceof Blob) || !IMAGE_TYPES.has(file.type)) throw new Error('请选择 JPEG、PNG 或 WebP 图片');
  if (!file.size || file.size > LOCAL_IMAGE_LIMITS.inputBytes) throw new Error('图片不能超过 10 MB');
  if (typeof createBitmap !== 'function') throw new Error('当前设备无法安全处理图片，请更新浏览器或 App');
  const bitmap = await createBitmap(file, { imageOrientation: 'from-image' });
  try {
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > LOCAL_IMAGE_LIMITS.pixels) throw new Error('图片像素过大，请选择不超过 2500 万像素的图片');
    const scale = Math.min(1, LOCAL_IMAGE_LIMITS.longestEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale)), height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('当前设备无法处理图片');
    context.drawImage(bitmap, 0, 0, width, height);
    let blob;
    for (const quality of [0.88, 0.76, 0.64]) {
      blob = await canvasBlob(canvas, quality);
      if (blob.size <= LOCAL_IMAGE_LIMITS.inputBytes) break;
    }
    if (!blob || blob.size > LOCAL_IMAGE_LIMITS.inputBytes) throw new Error('图片压缩后仍超过 10 MB');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return validateLocalAsset({ id: crypto.randomUUID(), entryId, mimeType: 'image/webp', size: bytes.byteLength,
      sha256: Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join(''), width, height,
      status: 'local-only', createdAt: new Date().toISOString(), bytes });
  } finally { bitmap.close?.(); }
}
