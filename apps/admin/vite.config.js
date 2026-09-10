import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5180 },
  // @wantok/core is a workspace package of plain ESM source, not a built
  // artefact, so Vite has to be told it is safe to serve from outside the app
  // root and must not try to pre-bundle it as a CommonJS dependency.
  optimizeDeps: { exclude: ['@wantok/core'] },
  resolve: { preserveSymlinks: false },
});
