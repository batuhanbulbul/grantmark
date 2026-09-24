import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API runs separately (npm run dev at the repository root).
const api = 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/v1': api, '/olp': api, '/registry': api, '/.well-known': api },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
