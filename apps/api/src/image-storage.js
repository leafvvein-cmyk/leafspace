import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function createImageStorage(root = fileURLToPath(new URL('../.private-assets/', import.meta.url))) {
  const directory = resolve(root);
  const target = (key) => {
    if (!/^(source|original|thumbnail)\/[0-9a-f-]{36}(?:_[0-9a-f-]{36})?\.(?:bin|webp)$/i.test(key)) throw new Error('Invalid private image key');
    return resolve(directory, key.replace('/', '\\'));
  };
  const remove = async (key) => unlink(target(key)).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  return {
    read: (key) => readFile(target(key)), remove,
    async putSource(assetId, bytes) {
      if (!uuid.test(assetId)) throw new Error('Invalid asset id');
      const key = `source/${assetId}.bin`, file = target(key);
      await mkdir(resolve(directory, 'source'), { recursive: true, mode: 0o700 });
      try {
        const handle = await open(file, 'wx', 0o600);
        try { await handle.writeFile(bytes); } finally { await handle.close(); }
      } catch (error) {
        if (error.code !== 'EEXIST' || !Buffer.from(await readFile(file)).equals(bytes)) throw error;
      }
      return key;
    },
    async putVariants(assetId, token, original, thumbnail) {
      if (!uuid.test(assetId) || !uuid.test(token)) throw new Error('Invalid image variant id');
      const keys = { original: `original/${assetId}_${token}.webp`, thumbnail: `thumbnail/${assetId}_${token}.webp` };
      for (const name of ['original', 'thumbnail']) await mkdir(resolve(directory, name), { recursive: true, mode: 0o700 });
      const written = [];
      try {
        for (const [name, bytes] of [['original', original], ['thumbnail', thumbnail]]) {
          const file = target(keys[name]), temporary = `${file}.partial`;
          await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
          await rename(temporary, file); written.push(keys[name]);
        }
        return keys;
      } catch (error) {
        await Promise.all(written.map(remove));
        throw error;
      }
    },
  };
}
