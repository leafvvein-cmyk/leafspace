import { describe, expect, it } from 'vitest';
import { isAbsolute, resolve } from 'node:path';
import { createConfig } from '../../apps/api/src/config.js';

const productionEnv = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://diary:secret@db.internal/diary',
  APP_SECRET: 'a'.repeat(64),
  WEB_ORIGIN: 'https://diary.example.com',
  DIARY_ASSET_STORAGE_PATH: resolve('test-private-assets'),
  DIARY_EXPORT_STORAGE_PATH: resolve('test-private-exports'),
};

describe('API configuration', () => {
  it('provides absolute private-storage defaults in development', () => {
    const value = createConfig({});
    expect(value.production).toBe(false);
    expect(isAbsolute(value.imageStorageRoot)).toBe(true);
    expect(isAbsolute(value.exportStorageRoot)).toBe(true);
  });

  it('requires both persistent storage roots in production', () => {
    const { DIARY_ASSET_STORAGE_PATH, ...withoutAssets } = productionEnv;
    const { DIARY_EXPORT_STORAGE_PATH, ...withoutExports } = productionEnv;
    expect(() => createConfig(withoutAssets)).toThrow(/DIARY_ASSET_STORAGE_PATH/);
    expect(() => createConfig(withoutExports)).toThrow(/DIARY_EXPORT_STORAGE_PATH/);
  });

  it('rejects relative production storage roots', () => {
    expect(() => createConfig({ ...productionEnv, DIARY_ASSET_STORAGE_PATH: '.\\assets' })).toThrow(/absolute/);
    expect(() => createConfig({ ...productionEnv, DIARY_EXPORT_STORAGE_PATH: '.\\exports' })).toThrow(/absolute/);
  });

  it('accepts complete production persistence configuration', () => {
    const value = createConfig(productionEnv);
    expect(value.production).toBe(true);
    expect(value.imageStorageRoot).toBe(productionEnv.DIARY_ASSET_STORAGE_PATH);
    expect(value.exportStorageRoot).toBe(productionEnv.DIARY_EXPORT_STORAGE_PATH);
  });
});
