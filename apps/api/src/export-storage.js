import { mkdir, rename, unlink, open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function createExportStorage(root = fileURLToPath(new URL('../.private-exports/', import.meta.url))) {
  const directory = resolve(root);
  const path = (key) => {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.zip$/i.test(key)) throw new Error('Invalid private export key');
    return resolve(directory, key);
  };
  const remove = async (key) => { await unlink(path(key)).catch((error) => { if (error.code !== 'ENOENT') throw error; }); };
  return { path, remove, async write(jobId, token, stream) {
    const key = `${jobId}_${token}.zip`, target = path(key), temporary = `${target}.partial`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // Open exclusively before owning cleanup; EEXIST must not remove someone else's file.
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await pipeline(stream, handle.createWriteStream());
      await rename(temporary, target); return key;
    } catch (error) { await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error; }
  } };
}
