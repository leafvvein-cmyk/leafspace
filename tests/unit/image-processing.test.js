import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { processImage } from '../../apps/api/src/image-processing.js';
const declaration = (buffer, mimeType = 'image/png') => ({ mimeType, size: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') });
describe('server image validation', () => {
  it('decodes and re-encodes pixels, removes metadata and creates a thumbnail', async () => {
    const input = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#b95630' } }).withExif({ IFD0: { Artist: 'private-author' } }).png().toBuffer();
    expect((await sharp(input).metadata()).exif).toBeTruthy();
    const result = await processImage(input, declaration(input));
    expect(result).toMatchObject({ width: 640, height: 480, mimeType: 'image/webp' });
    expect((await sharp(result.original).metadata()).exif).toBeUndefined();
    expect(await sharp(result.thumbnail).metadata()).toMatchObject({ width: 320, height: 240, format: 'webp' });
  });
  it('rejects mismatched MIME, checksum, size and disguised markup', async () => {
    const input = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'white' } }).png().toBuffer();
    await expect(processImage(input, declaration(input, 'image/jpeg'))).rejects.toMatchObject({ code: 'IMAGE_TYPE_MISMATCH' });
    await expect(processImage(input, { ...declaration(input), sha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'IMAGE_HASH_MISMATCH' });
    await expect(processImage(input, { ...declaration(input), size: 1 })).rejects.toMatchObject({ code: 'IMAGE_SIZE_INVALID' });
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    await expect(processImage(svg, declaration(svg))).rejects.toMatchObject({ code: 'IMAGE_TYPE_UNSUPPORTED' });
  });
});
