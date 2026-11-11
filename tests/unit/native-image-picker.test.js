import { describe, expect, it, vi } from 'vitest';
import { pickNativeImage } from '../../apps/client/src/services/native-image-picker.js';

function harness(result = { type: 0, webPath: 'capacitor://photo/1', metadata: { format: 'jpeg' } }) {
  const Camera = { takePhoto: vi.fn(async () => result), chooseFromGallery: vi.fn(async () => ({ results: [result] })) };
  const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/jpeg' } }));
  return { Camera, fetcher, options: { loadPlugin: async () => ({ Camera, MediaType: { Photo: 0 }, MediaTypeSelection: { Photo: 0 } }), requirePlugin: vi.fn(), fetcher } };
}

describe('native image picker', () => {
  it('opens the camera only after an explicit source choice and returns a bounded file', async () => {
    const h = harness(), file = await pickNativeImage('camera', h.options);
    expect(h.options.requirePlugin).toHaveBeenCalledWith('Camera'); expect(h.Camera.takePhoto).toHaveBeenCalledTimes(1);
    expect(h.Camera.chooseFromGallery).not.toHaveBeenCalled(); expect(h.Camera.takePhoto.mock.calls[0][0]).toMatchObject({ saveToGallery: false, correctOrientation: true, targetWidth: 2560 });
    expect(file).toBeInstanceOf(File); expect(file.type).toBe('image/jpeg'); expect(file.size).toBe(3);
  });
  it('uses the system photo picker for one photo without asking for broad access itself', async () => {
    const h = harness(), file = await pickNativeImage('photos', h.options);
    expect(h.Camera.chooseFromGallery.mock.calls[0][0]).toMatchObject({ mediaType: 0, allowMultipleSelection: false, limit: 1 });
    expect(h.Camera).not.toHaveProperty('requestPermissions'); expect(file.name).toBe('diary-photo.jpeg');
  });
  it('treats user cancellation as no selection but preserves permission failures as errors', async () => {
    const cancelled = harness(); cancelled.Camera.takePhoto.mockRejectedValueOnce(Object.assign(new Error('User cancelled'), { code: 'USER_CANCELLED' }));
    await expect(pickNativeImage('camera', cancelled.options)).resolves.toBeNull();
    const denied = harness(); denied.Camera.takePhoto.mockRejectedValueOnce(new Error('permission denied'));
    await expect(pickNativeImage('camera', denied.options)).rejects.toThrow('检查系统相机权限');
  });
  it('rejects video, unsupported image formats, unreadable URIs and oversized bytes', async () => {
    await expect(pickNativeImage('photos', harness({ type: 1, webPath: 'x', metadata: { format: 'mp4' } }).options)).rejects.toThrow('没有取得');
    await expect(pickNativeImage('photos', harness({ type: 0, webPath: 'x', metadata: { format: 'heic' } }).options)).rejects.toThrow('格式暂不支持');
    const unreadable = harness(); unreadable.fetcher.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(pickNativeImage('photos', unreadable.options)).rejects.toThrow('无法读取');
    const oversized = harness(); oversized.fetcher.mockResolvedValueOnce({ ok: true, blob: async () => ({ size: 10 * 1024 * 1024 + 1 }) });
    await expect(pickNativeImage('photos', oversized.options)).rejects.toThrow('不能超过 10 MB');
  });
  it('rejects invented sources before loading any native plugin', async () => {
    const h = harness(); await expect(pickNativeImage('files', h.options)).rejects.toThrow('来源无效');
    expect(h.options.requirePlugin).not.toHaveBeenCalled();
  });
});
