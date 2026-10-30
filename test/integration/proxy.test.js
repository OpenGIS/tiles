import { request as httpRequest } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.mjs';
import { validateConfig } from '../../src/lib/config.mjs';
import { createTempData } from '../helpers/temp.mjs';

function makeConfig(dataDir, serverOverrides = {}) {
  return validateConfig(
    {
      version: 1,
      server: { host: '127.0.0.1', port: 11010, ...serverOverrides },
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

function request(baseUrl, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      new URL(pathname, baseUrl),
      { headers: { connection: 'close', ...headers } },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );

    req.on('error', reject);
    req.end();
  });
}

async function listen(app) {
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${app.server.address().port}`;
}

describe('TileJSON base URL selection', () => {
  let temp;
  let apps;
  let defaultBaseUrl;
  let trustedBaseUrl;
  let publicBaseUrl;

  beforeAll(async () => {
    temp = await createTempData();
    apps = await Promise.all([
      createApp(makeConfig(temp.dataDir)),
      createApp(makeConfig(temp.dataDir, { trustProxy: true })),
      createApp(
        makeConfig(temp.dataDir, {
          trustProxy: true,
          publicBaseUrl: 'https://cdn.example/tiles',
        }),
      ),
    ]);

    [defaultBaseUrl, trustedBaseUrl, publicBaseUrl] = await Promise.all(apps.map(listen));
  });

  afterAll(async () => {
    await Promise.all(apps?.map((app) => app.close()) ?? []);
    await temp?.cleanup();
  });

  it('ignores forwarded headers by default', async () => {
    const response = await request(defaultBaseUrl, '/pois.json', {
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-port': '8443',
      'x-forwarded-prefix': '/maps',
    });
    const body = JSON.parse(response.body.toString('utf8'));

    expect(body.tiles).toEqual([`${defaultBaseUrl}/pois/build-current/{z}/{x}/{y}.pbf`]);
    expect(body.tiles[0]).not.toContain('evil.example');
  });

  it('honours forwarded headers when trustProxy is enabled', async () => {
    const response = await request(trustedBaseUrl, '/pois.json', {
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'tiles.example',
      'x-forwarded-port': '8443',
      'x-forwarded-prefix': '/maps',
    });
    const body = JSON.parse(response.body.toString('utf8'));

    expect(body.tiles).toEqual([
      'https://tiles.example:8443/maps/pois/build-current/{z}/{x}/{y}.pbf',
    ]);
  });

  it('prefers a configured public base URL over forwarded headers', async () => {
    const response = await request(publicBaseUrl, '/pois.json', {
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-prefix': '/maps',
    });
    const body = JSON.parse(response.body.toString('utf8'));

    expect(body.tiles).toEqual(['https://cdn.example/tiles/pois/build-current/{z}/{x}/{y}.pbf']);
  });
});
