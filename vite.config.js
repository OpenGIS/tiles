import { defineConfig } from 'vite';

import { pmtilesPlugin } from './dev/vite-plugin-pmtiles.mjs';

const TILE_SERVER = 'http://127.0.0.1:11010';

export default defineConfig({
  root: 'dev',
  publicDir: 'basemap',
  plugins: [pmtilesPlugin()],
  server: {
    host: '127.0.0.1',
    port: 11011,
    strictPort: true,
    proxy: {
      '/health': TILE_SERVER,
      '/ready': TILE_SERVER,
      '/sources': TILE_SERVER,
      '/pois': TILE_SERVER,
      '/routes': TILE_SERVER,
      '/paths': TILE_SERVER,
    },
  },
});
