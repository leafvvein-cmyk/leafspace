import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const envPath = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

const developmentImageRoot = fileURLToPath(new URL('../.private-assets/', import.meta.url));
const developmentExportRoot = fileURLToPath(new URL('../.private-exports/', import.meta.url));

export function createConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const imageStorageRoot = env.DIARY_ASSET_STORAGE_PATH ?? (production ? undefined : developmentImageRoot);
  const exportStorageRoot = env.DIARY_EXPORT_STORAGE_PATH ?? (production ? undefined : developmentExportRoot);
  if (production && (
    !env.DATABASE_URL
    || (env.APP_SECRET?.length ?? 0) < 64
    || !env.WEB_ORIGIN?.startsWith('https://')
    || !imageStorageRoot || !isAbsolute(imageStorageRoot)
    || !exportStorageRoot || !isAbsolute(exportStorageRoot)
  )) {
    throw new Error('Production requires DATABASE_URL, a random APP_SECRET of at least 64 characters, HTTPS WEB_ORIGIN, and absolute DIARY_ASSET_STORAGE_PATH and DIARY_EXPORT_STORAGE_PATH values.');
  }
  return {
    production,
    databaseUrl: env.DATABASE_URL ?? 'postgresql://diary:diary_local_development_only@127.0.0.1:54329/diary_dev',
    host: env.API_HOST ?? '127.0.0.1',
    port: Number(env.API_PORT ?? 8787),
    webOrigin: env.WEB_ORIGIN ?? 'http://127.0.0.1:4173',
    secret: env.APP_SECRET ?? 'diary-development-only-secret-never-use-on-a-public-server',
    imageStorageRoot,
    exportStorageRoot,
    accessSeconds: 900,
    sessionDays: 30,
  };
}

export const config = createConfig();
