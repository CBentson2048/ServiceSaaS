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
  },
  preview: {
    port: 5173,
  },
});
