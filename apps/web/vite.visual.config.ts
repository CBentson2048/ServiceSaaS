import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * Vite config for the visual harness only (apps/web/visual). Swaps the auth and
 * location-scope hooks for stubs so the real Product Management page can be
 * rendered and inspected at production viewport sizes without a backend.
 */
export default defineConfig({
  plugins: [react()],
  root: fileURLToPath(new URL('./visual', import.meta.url)),
  resolve: {
    alias: [
      { find: /^(\.\.\/)+auth\/AuthProvider$/, replacement: fileURLToPath(new URL('./visual/authStub.tsx', import.meta.url)) },
      { find: /^(\.\.\/)+components\/LocationScopeContext$/, replacement: fileURLToPath(new URL('./visual/locationStub.tsx', import.meta.url)) },
      { find: '@sheer/design-tokens', replacement: fileURLToPath(new URL('../../packages/design-tokens/src/index.ts', import.meta.url)) },
      { find: '@sheer/utils', replacement: fileURLToPath(new URL('../../packages/utils/src/index.ts', import.meta.url)) },
      { find: '@sheer/domain', replacement: fileURLToPath(new URL('../../packages/domain/src/index.ts', import.meta.url)) },
    ],
  },
  server: { port: 5199 },
});
