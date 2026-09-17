import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@sheer/design-tokens': fileURLToPath(
        new URL('../../packages/design-tokens/src/index.ts', import.meta.url),
      ),
      '@sheer/utils': fileURLToPath(new URL('../../packages/utils/src/index.ts', import.meta.url)),
      // Bundle domain from SOURCE like the other workspace packages. Without
      // this, vite falls through to packages/domain/dist — whatever was last
      // built — and a stale build silently ships old money logic (found when
      // the first new runtime value export crashed rollup against an Aug-7 dist).
      '@sheer/domain': fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: true,
      // Proxy the API through the dev server so the browser only ever talks to
      // the Vite origin. Without this the bundle fetches the API host directly,
      // which fails whenever the browser is not on the same machine as the dev
      // server (VS Code Remote / SSH: only the forwarded 5173 exists on the
      // client, so calls to localhost:3001 hit ERR_CONNECTION_REFUSED). Pair
      // with an empty VITE_API_URL locally so request paths stay relative.
      proxy: {
        '/api': {
          target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:3001',
          changeOrigin: true,
        },
      },
  },
  preview: {
    port: 5173,
  },
});
