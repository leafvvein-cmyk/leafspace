import { defineConfig } from 'vite';
import { diaryPwa } from './pwa/plugin.js';

const apiProxy = { '/api': 'http://127.0.0.1:8787' };

export default defineConfig(({ mode }) => ({
  plugins: [diaryPwa({ native: mode === 'native' })],
  envDir: '../..',
  server: { proxy: apiProxy },
  preview: { proxy: apiProxy },
  build: { target: 'es2022' },
}));
