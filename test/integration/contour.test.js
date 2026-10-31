import { request as httpRequest } from 'node:http';
import { gunzipSync } from 'node:zlib';

import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.mjs';
import { validateConfig } from '../../src/lib/config.mjs';
import { createDemServer } from '../helpers/dem-server.mjs';

const EXPOSE_HEADERS = 'ETag, Content-Length, Content-Encoding, Retry-After';
const TILE_PATH = '/12/735/1368.pbf';
const CACHE_CONTROL = 'public, max-age=86400';

function makeConfig(demUrl) {
  return validateConfig(
    {
      version: 1,
      server: { host: '127.0.0.1', port: 11010 },
      sources: {
        contours: {
          kind: 'contour',
          title: 'Terrain contours',
          description: 'Contour lines generated on demand from a worldwide elevation model.',
          attribution: [{ title: 'Mapterhorn', href: 'https://mapterhorn.com/attribution' }],
          minzoom: 1,
          maxzoom: 15,
          demUrl,
          encoding: 'terrarium',
          demMaxzoom: 12,
          demTileSize: 512,
          cacheSize: 100,
          timeoutMs: 10000,
          buffer: 1,
          extent: 4096,
          contourLayer: 'contours',
          elevationKey: 'ele',
          levelKey: 'level',
          cacheMaxAge: 86400,
          thresholds: {
            1: [600, 3000],
            4: [300, 1500],
            8: [150, 750],
            9: [80, 400],
            10: [20, 100],
            11: [20, 100],
            12: [20, 100],
            13: [10, 50],
            14: [5, 25],
          },
        },
      },
    },
    { repoRoot: '/srv/tiles' },
  );
}

function request(baseUrl, pathname, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      new URL(pathname, baseUrl),
      { method, headers: { connection: 'close', ...headers } },
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

function json(response) {
  return JSON.parse(response.body.toString('utf8'));
}

async function listen(app) {
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${app.server.address().port}`;
}

function decodeMvt(buffer) {
  return new VectorTile(new PbfReader(gunzipSync(buffer)));
}

describe('contour tile server', () => {
  let dem;
  let app;
  let baseUrl;
  let buildId;

  beforeAll(async () => {
    dem = await createDemServer();
    app = await createApp(makeConfig(`${dem.baseUrl}/{z}/{x}/{y}.webp`));
    baseUrl = await listen(app);
    buildId = app.sources.contours.buildId;
  });

  afterAll(async () => {
    await app?.close();
    await dem?.close();
  });

  it('serves TileJSON with an unversioned tile URL and contour layer', async () => {
    const response = await request(baseUrl, '/contours.json');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=300');
    expect(response.headers['access-control-allow-origin']).toBe('*');

    expect(json(response)).toMatchObject({
      tilejson: '3.0.0',
      name: 'Terrain contours',
      scheme: 'xyz',
      tiles: [`${baseUrl}/contours/{z}/{x}/{y}.pbf`],
      minzoom: 1,
      maxzoom: 15,
      vector_layers: [
        {
          id: 'contours',
          fields: { ele: 'Number', level: 'Number' },
          minzoom: 1,
          maxzoom: 15,
        },
      ],
    });
    expect(json(response).attribution).toContain('Mapterhorn');
  });

  it('serves a gzip contour tile with line features', async () => {
    const response = await request(baseUrl, `/contours${TILE_PATH}`, {
      headers: { 'accept-encoding': 'gzip' },
    });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/x-protobuf');
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(response.headers.vary).toBe('accept-encoding');
    expect(response.headers['cache-control']).toBe(CACHE_CONTROL);
    expect(response.headers['cache-control']).not.toContain('immutable');
    expect(response.headers.etag).toBe(`"${buildId}-12-735-1368-gzip"`);
    expect(Number(response.headers['content-length'])).toBe(response.body.length);
    expect(response.headers['access-control-expose-headers']).toBe(EXPOSE_HEADERS);

    const vectorTile = decodeMvt(response.body);
    const layer = vectorTile.layers.contours;

    expect(layer).toBeDefined();
    expect(layer.length).toBeGreaterThanOrEqual(50);
    expect(layer.length).toBeLessThanOrEqual(100);

    for (let index = 0; index < layer.length; index += 1) {
      const feature = layer.feature(index);
      expect(feature.properties.ele).toBeGreaterThanOrEqual(1000);
      expect(feature.properties.ele).toBeLessThanOrEqual(3000);
      expect([0, 1]).toContain(feature.properties.level);
      expect(feature.type).toBe(2);
      expect(feature.loadGeometry().length).toBeGreaterThan(0);
    }
  });

  it('negotiates identity and decompresses to the same MVT', async () => {
    const gzipResponse = await request(baseUrl, `/contours${TILE_PATH}`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    const identityResponse = await request(baseUrl, `/contours${TILE_PATH}`, {
      headers: { 'accept-encoding': 'identity' },
    });

    expect(identityResponse.status).toBe(200);
    expect(identityResponse.headers['content-encoding']).toBeUndefined();
    expect(identityResponse.headers.vary).toBe('accept-encoding');
    expect(identityResponse.headers.etag).toBe(`"${buildId}-12-735-1368-identity"`);
    expect(gunzipSync(gzipResponse.body).equals(identityResponse.body)).toBe(true);
  });

  it('returns 304 when If-None-Match matches', async () => {
    const first = await request(baseUrl, `/contours${TILE_PATH}`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    const response = await request(baseUrl, `/contours${TILE_PATH}`, {
      headers: {
        'accept-encoding': 'gzip',
        'if-none-match': first.headers.etag,
      },
    });

    expect(response.status).toBe(304);
    expect(response.headers.etag).toBe(first.headers.etag);
    expect(response.headers['cache-control']).toBe(CACHE_CONTROL);
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers.vary).toBe('accept-encoding');
    expect(response.body).toHaveLength(0);
  });

  it.each([
    ['below the minimum zoom', '/contours/0/0/0.pbf', '0-0-0'],
    ['above the maximum zoom', '/contours/16/0/0.pbf', '16-0-0'],
  ])('returns 204 for a request %s', async (_label, pathname, coordinates) => {
    const response = await request(baseUrl, pathname);

    expect(response.status).toBe(204);
    expect(response.headers.etag).toBe(`"${buildId}-${coordinates}-empty"`);
    expect(response.headers['cache-control']).toBe(CACHE_CONTROL);
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.body).toHaveLength(0);
  });

  it('returns 204 when a neighbouring DEM tile has no coverage', async () => {
    const response = await request(baseUrl, '/contours/12/734/1368.pbf');

    expect(response.status).toBe(204);
    expect(response.headers.etag).toBe(`"${buildId}-12-734-1368-empty"`);
    expect(response.body).toHaveLength(0);
  });

  it('returns 404 for a versioned contour tile URL', async () => {
    const response = await request(baseUrl, `/contours/${buildId}${TILE_PATH}`);

    expect(response.status).toBe(404);
    expect(json(response)).toEqual({ error: 'not_found' });
    expect(response.headers['access-control-allow-origin']).toBe('*');
  });

  it('supports HEAD on a tile', async () => {
    const response = await request(baseUrl, `/contours${TILE_PATH}`, {
      method: 'HEAD',
      headers: { 'accept-encoding': 'gzip' },
    });

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(0);
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(Number(response.headers['content-length'])).toBeGreaterThan(0);
  });

  it('supports OPTIONS on a tile route', async () => {
    const response = await request(baseUrl, `/contours${TILE_PATH}`, { method: 'OPTIONS' });

    expect(response.status).toBe(204);
    expect(response.headers.allow).toBe('GET, HEAD, OPTIONS');
    expect(response.headers['access-control-allow-methods']).toBe('GET, HEAD, OPTIONS');
    expect(response.body).toHaveLength(0);
  });

  it('reports health, readiness and the catalogue', async () => {
    const health = await request(baseUrl, '/health');
    const ready = await request(baseUrl, '/ready');
    const sources = await request(baseUrl, '/sources');

    expect(health.status).toBe(200);
    expect(json(health)).toMatchObject({
      status: 'ok',
      sources: { contours: { available: true, buildId } },
    });

    expect(ready.status).toBe(200);
    expect(json(ready)).toEqual({ status: 'ready' });

    expect(sources.status).toBe(200);
    expect(json(sources).sources).toEqual([
      expect.objectContaining({
        name: 'contours',
        kind: 'contour',
        available: true,
        buildId,
        minzoom: 1,
        maxzoom: 15,
        tilejson: '/contours.json',
        tiles: ['/contours/{z}/{x}/{y}.pbf'],
      }),
    ]);
  });
});

describe('contour tile server with an unavailable upstream', () => {
  let dem;
  let app;
  let baseUrl;

  beforeAll(async () => {
    dem = await createDemServer({
      respond({ response }) {
        response.writeHead(503, { 'content-type': 'text/plain' });
        response.end('upstream down');
        return true;
      },
    });
    app = await createApp(makeConfig(`${dem.baseUrl}/{z}/{x}/{y}.webp`));
    baseUrl = await listen(app);
  });

  afterAll(async () => {
    await app?.close();
    await dem?.close();
  });

  it('returns 503 with Retry-After when the DEM source fails', async () => {
    const response = await request(baseUrl, `/contours${TILE_PATH}`);

    expect(response.status).toBe(503);
    expect(json(response)).toEqual({ error: 'upstream_unavailable' });
    expect(response.headers['retry-after']).toBe('60');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-expose-headers']).toBe(EXPOSE_HEADERS);
  });
});

describe('contour tile server with a corrupt DEM image', () => {
  let dem;
  let app;
  let baseUrl;

  beforeAll(async () => {
    const corrupt = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x10, 0x00, 0x00, 0x00]),
      Buffer.from('WEBP'),
      Buffer.from('not a real image'),
    ]);

    dem = await createDemServer({
      respond({ response }) {
        response.writeHead(200, { 'content-type': 'image/webp' });
        response.end(corrupt);
        return true;
      },
    });
    app = await createApp(makeConfig(`${dem.baseUrl}/{z}/{x}/{y}.webp`));
    baseUrl = await listen(app);
  });

  afterAll(async () => {
    await app?.close();
    await dem?.close();
  });

  it('returns 500 for an undecodable DEM image', async () => {
    const response = await request(baseUrl, `/contours${TILE_PATH}`);

    expect(response.status).toBe(500);
    expect(json(response)).toEqual({ error: 'internal_error' });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['access-control-allow-origin']).toBe('*');
  });
});

describe('contour tile server when the client disconnects', () => {
  let dem;
  let app;
  let baseUrl;
  let demRequestStarted;
  let demRequestClosed;
  let clientRequest;
  let clientDisconnected = false;

  beforeAll(async () => {
    let resolveStarted;
    let resolveClosed;

    demRequestStarted = new Promise((resolve) => {
      resolveStarted = resolve;
    });
    demRequestClosed = new Promise((resolve) => {
      resolveClosed = resolve;
    });

    dem = await createDemServer({
      respond({ response }) {
        resolveStarted();
        response.on('close', () => {
          if (!clientDisconnected) {
            return;
          }

          resolveClosed({
            writableEnded: response.writableEnded,
            destroyed: response.destroyed,
            url: response.req?.url,
          });
        });
        return true;
      },
    });
    app = await createApp(makeConfig(`${dem.baseUrl}/{z}/{x}/{y}.webp`));
    baseUrl = await listen(app);
  });

  afterAll(async () => {
    dem?.server.closeAllConnections?.();
    await app?.close();
    await dem?.close();
  });

  it('aborts the upstream DEM request without crashing the server', async () => {
    const clientFinished = new Promise((resolve) => {
      clientRequest = httpRequest(new URL(`/contours${TILE_PATH}`, baseUrl), (response) => {
        response.resume();
        response.on('end', () => resolve('ended'));
      });
      clientRequest.on('error', (error) => resolve(error));
      clientRequest.end();
    });

    await demRequestStarted;
    clientDisconnected = true;
    clientRequest.destroy();

    expect(await clientFinished).toBeInstanceOf(Error);
    await expect(demRequestClosed).resolves.toMatchObject({
      writableEnded: false,
      destroyed: true,
    });

    const health = await request(baseUrl, '/health');

    expect(health.status).toBe(200);
    expect(json(health).sources.contours.available).toBe(true);
  }, 10000);
});
