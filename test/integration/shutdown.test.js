import { request as httpRequest } from 'node:http';

import { describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.mjs';
import { validateConfig } from '../../src/lib/config.mjs';
import { createTempData } from '../helpers/temp.mjs';

function makeConfig(dataDir) {
  return validateConfig(
    {
      version: 1,
      server: { host: '127.0.0.1', port: 11010 },
      sources: {
        pois: {
          kind: 'pmtiles',
          title: 'Outdoor POIs',
          description: 'Points of interest.',
          attribution: [
            { title: 'OpenStreetMap', href: 'https://www.openstreetmap.org/copyright' },
          ],
          archiveDir: dataDir,
          minzoom: 12,
          maxzoom: 16,
        },
      },
    },
    { repoRoot: dataDir },
  );
}

async function listen(app) {
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${app.server.address().port}`;
}

function startHangingRequest(baseUrl) {
  return new Promise((resolve) => {
    const request = httpRequest(
      new URL('/pois/12/2167/1454.pbf', baseUrl),
      { headers: { connection: 'close' } },
      (response) => {
        response.resume();
        response.on('end', () => resolve('ended'));
      },
    );

    request.on('error', (error) => resolve(error));
    request.end();
  });
}

describe('shutdown', () => {
  it('closes active connections after the grace period', async () => {
    const temp = await createTempData();

    try {
      const app = await createApp(makeConfig(temp.dataDir));
      const baseUrl = await listen(app);

      app.sources.pois.getTile = () => new Promise(() => {});
      const pending = startHangingRequest(baseUrl);
      await new Promise((resolve) => setTimeout(resolve, 100));

      const startedAt = Date.now();
      await app.close({ graceMs: 50 });
      const elapsed = Date.now() - startedAt;
      const outcome = await pending;

      expect(outcome).toBeInstanceOf(Error);
      expect(elapsed).toBeGreaterThanOrEqual(40);
    } finally {
      await temp.cleanup();
    }
  });
});
