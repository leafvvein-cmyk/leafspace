import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { ApiError } from './errors.js';

export const IMAGE_LIMITS = { bytes: 10 * 1024 * 1024, pixels: 25_000_000 };
const invalid = (code, message) => new ApiError(422, code, message);
function sniff(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw invalid('IMAGE_TYPE_UNSUPPORTED', '仅支持 JPEG、PNG、WebP；HEIC 请先转换，SVG 不支持');
}

export async function processImage(buffer, { mimeType, size, sha256 }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > IMAGE_LIMITS.bytes || size !== buffer.length) throw invalid('IMAGE_SIZE_INVALID', '图片大小无效或超过 10 MiB');
  const actualType = sniff(buffer);
  if (mimeType !== actualType) throw invalid('IMAGE_TYPE_MISMATCH', '图片真实格式与声明不一致');
  if (!/^[a-f0-9]{64}$/.test(sha256 ?? '') || createHash('sha256').update(buffer).digest('hex') !== sha256) throw invalid('IMAGE_HASH_MISMATCH', '图片校验和不一致，请重新上传');
  try {
    const options = { failOn: 'warning', limitInputPixels: IMAGE_LIMITS.pixels, autoOrient: true };
    const metadata = await sharp(buffer, options).metadata();
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > IMAGE_LIMITS.pixels || (metadata.pages ?? 1) !== 1) throw invalid('IMAGE_DIMENSIONS_INVALID', '图片超过 2500 万像素或包含不支持的多帧内容');
    // Deliberately do not keep EXIF, XMP or source metadata in either derivative.
    const original = await sharp(buffer, options).webp({ quality: 90 }).toBuffer({ resolveWithObject: true });
    const thumbnail = await sharp(original.data).resize({ width: 320, height: 320, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    return { original: original.data, thumbnail, mimeType: 'image/webp', width: original.info.width,
      height: original.info.height, sha256: createHash('sha256').update(original.data).digest('hex') };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw invalid('IMAGE_DECODE_FAILED', '图片无法安全解码，请重新选择图片');
  }
}
