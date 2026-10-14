import preact from '@preact/preset-vite';
import { defineConfig } from 'vitest/config';

// Dev: Vite serves the page and proxies the API to the Node server (port 4400).
// Prod: the Node server serves dist/ itself.
export default defineConfig({
  plugins: [preact()],
  server: {
    host: true,
    port: 5174,
    proxy: {
      '/api': 'http://127.0.0.1:4400',
      '/ws': { target: 'ws://127.0.0.1:4400', ws: true },
    },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  test: { include: ['test/**/*.test.ts'] },
});
