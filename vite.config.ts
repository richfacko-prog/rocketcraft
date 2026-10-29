import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true,
    port: 5173,
    // during development the multiplayer API runs in `wrangler dev` on port 8787
    proxy: { '/api': { target: 'http://127.0.0.1:8787', ws: true } },
  },
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
  // pre-bundle everything up front so the dev server never re-optimizes mid-session
  optimizeDeps: {
    include: ['three', '@dimforge/rapier3d-compat', 'three/examples/jsm/environments/RoomEnvironment.js', 'three/examples/jsm/utils/BufferGeometryUtils.js'],
  },
});
