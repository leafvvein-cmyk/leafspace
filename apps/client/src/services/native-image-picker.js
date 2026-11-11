import { requireNativePlugin } from './platform.js';
import { LOCAL_IMAGE_LIMITS } from './local-assets.js';

const mime = (format) => ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' })[String(format ?? '').toLowerCase()];

export async function pickNativeImage(source, { loadPlugin = async () => import('@capacitor/camera'), requirePlugin = requireNativePlugin, fetcher = fetch } = {}) {
  if (!['camera', 'photos'].includes(source)) throw new Error('图片来源无效');
  requirePlugin('Camera');
  const { Camera, MediaType, MediaTypeSelection } = await loadPlugin();
  let result;
  try {
    if (source === 'camera') result = await Camera.takePhoto({ quality: 92, targetWidth: 2560, targetHeight: 2560,
      correctOrientation: true, saveToGallery: false, editable: 'no', includeMetadata: true });
    else result = (await Camera.chooseFromGallery({ mediaType: MediaTypeSelection.Photo, allowMultipleSelection: false, limit: 1,
      quality: 92, targetWidth: 2560, targetHeight: 2560, correctOrientation: true, editable: 'no', includeMetadata: true })).results[0];
  } catch (error) {
    if (/cancel/i.test(`${error?.code ?? ''} ${error?.message ?? ''}`)) return null;
    throw new Error(source === 'camera' ? '无法打开相机，请检查系统相机权限。' : '无法打开相册，请检查系统照片权限。');
  }
  if (!result?.webPath || result.type !== MediaType.Photo) throw new Error('没有取得可读取的照片');
  const type = mime(result.metadata?.format);
  if (!type) throw new Error('这张照片的格式暂不支持，请选择 JPEG、PNG 或 WebP');
  const response = await fetcher(result.webPath, { cache: 'no-store' });
  if (!response.ok) throw new Error('无法读取系统返回的照片');
  const blob = await response.blob();
  if (!blob.size || blob.size > LOCAL_IMAGE_LIMITS.inputBytes) throw new Error('照片不能超过 10 MB，请在系统相册中缩小后重试');
  return new File([blob], `diary-photo.${type.split('/')[1]}`, { type, lastModified: Date.now() });
}
