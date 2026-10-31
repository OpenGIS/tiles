import { request as httpRequest } from 'node:http';
import { gunzipSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../../src/app.mjs';
import { validateConfig } from '../../src/lib/config.mjs';
import { createTempData } from '../helpers/temp.mjs';

const NON_EMPTY_PATH = '/12/2167/1454.pbf';
const EMPTY_PATH = '/12/0/0.pbf';
const EXPOSE_HEADERS = 'ETag, Content-Length, Content-Encoding, Retry-After';

function makeConfig(dataDir, serverOverrides = {}) {
  return validateConfig(
    {
      version: 1,
      server: { host: '127.0.0.1', port: 11010, ...serverOverrides },
      sources: {
        pois: {
          kind: 'pmtiles',
          title: 'Outdoor POIs',
          description: 'Huts, shelters, viewpoints and other outdoor points of interest.',
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

describe('tile server', () => {
  let temp;
  let app;
  let baseUrl;

  beforeAll(async () => {
    temp = await createTempData({ previous: true });
    app = await createApp(makeConfig(temp.dataDir));
    baseUrl = await listen(app);
  });

  afterAll(async () => {
    await app?.close();
    await temp?.cleanup();
  });

  it('serves the JSON index', async () => {
    const response = await request(baseUrl, '/');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-expose-headers']).toBe(EXPOSE_HEADERS);
    expect(json(response)).toMatchObject({
      service: 'ogis-tiles',
      version: '2.0.0',
    });
    expect(json(response).endpoints).toBeTypeOf('object');
    expect(json(response).endpoints).toHaveProperty('versionedPmtilesTiles');
    expect(json(response).endpoints).not.toHaveProperty('versionedTiles');
  });

  it('reports health as ok when every source is available', async () => {
    const response = await request(baseUrl, '/health');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(json(response)).toEqual({
      status: 'ok',
      service: 'ogis-tiles',
      version: '2.0.0',
      sources: {
        pois: { available: true, buildId: 'build-current' },
      },
    });
  });

  it('reports readiness as ready', async () => {
    const response = await request(baseUrl, '/ready');

    expect(response.status).toBe(200);
    expect(json(response)).toEqual({ status: 'ready' });
  });

  it('serves the source catalogue', async () => {
    const response = await request(baseUrl, '/sources');

    expect(response.status).toBe(200);
    const body = json(response);
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0]).toMatchObject({
      name: 'pois',
      kind: 'pmtiles',
      available: true,
      buildId: 'build-current',
      minzoom: 12,
      maxzoom: 16,
      tilejson: '/pois.json',
      tiles: ['/pois/build-current/{z}/{x}/{y}.pbf'],
    });
  });

  it('serves TileJSON with an absolute versioned tile URL', async () => {
    const response = await request(baseUrl, '/pois.json');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('public, max-age=300');

    const body = json(response);
    expect(body).toMatchObject({
      tilejson: '3.0.0',
      name: 'Outdoor POIs',
      scheme: 'xyz',
      tiles: [`${baseUrl}/pois/build-current/{z}/{x}/{y}.pbf`],
      minzoom: 12,
      maxzoom: 16,
    });
    expect(body.attribution).toContain('OpenStreetMap');
    expect(body.bounds).toEqual([10.48, 45.27, 11.78, 46.18]);
    expect(body.vector_layers).toEqual([
      {
        id: 'outdoor_pois',
        fields: { ele: 'String', kind: 'String', name: 'String' },
        minzoom: 8,
        maxzoom: 16,
      },
    ]);
  });

  it('serves the current tile as gzip when the client accepts gzip', async () => {
    const response = await request(baseUrl, `/pois${NON_EMPTY_PATH}`, {
      headers: { 'accept-encoding': 'gzip' },
    });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/x-protobuf');
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(response.headers['cache-control']).toBe('public, max-age=300');
    expect(response.headers.vary).toBe('accept-encoding');
    expect(response.headers.etag).toBe('"build-current-12-2167-1454-gzip"');
    expect(Number(response.headers['content-length'])).toBe(response.body.length);
    expect(response.headers['access-control-expose-headers']).toBe(EXPOSE_HEADERS);
    expect(response.body.length).toBeGreaterThan(0);
  });

  it('negotiates identity when the client does not accept gzip', async () => {
    const gzipResponse = await request(baseUrl, `/pois${NON_EMPTY_PATH}`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    const identityResponse = await request(baseUrl, `/pois${NON_EMPTY_PATH}`, {
      headers: { 'accept-encoding': 'identity' },
    });

    expect(identityResponse.status).toBe(200);
    expect(identityResponse.headers['content-encoding']).toBeUndefined();
    expect(identityResponse.headers.vary).toBe('accept-encoding');
    expect(identityResponse.headers.etag).toBe('"build-current-12-2167-1454-identity"');
    expect(gunzipSync(gzipResponse.body).equals(identityResponse.body)).toBe(true);
  });

  it('serves versioned current and previous tiles as immutable', async () => {
    const headers = { 'accept-encoding': 'gzip' };
    const current = await request(baseUrl, `/pois/build-current${NON_EMPTY_PATH}`, { headers });
    const previous = await request(baseUrl, `/pois/build-previous${NON_EMPTY_PATH}`, { headers });

    expect(current.status).toBe(200);
    expect(current.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(current.headers.etag).toBe('"build-current-12-2167-1454-gzip"');

    expect(previous.status).toBe(200);
    expect(previous.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(previous.headers.etag).toBe('"build-previous-12-2167-1454-gzip"');
    expect(previous.body.equals(current.body)).toBe(true);
  });

  it('returns 404 for an unknown build id', async () => {
    const response = await request(baseUrl, `/pois/unknown-build${NON_EMPTY_PATH}`);

    expect(response.status).toBe(404);
    expect(json(response)).toEqual({ error: 'not_found' });
    expect(response.headers['access-control-allow-origin']).toBe('*');
  });

  it('returns 204 for an empty tile', async () => {
    const response = await request(baseUrl, `/pois${EMPTY_PATH}`);

    expect(response.status).toBe(204);
    expect(response.headers.etag).toBe('"build-current-12-0-0-empty"');
    expect(response.headers['cache-control']).toBe('public, max-age=300');
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers.vary).toBeUndefined();
    expect(response.body).toHaveLength(0);
  });

  it('returns 304 when If-None-Match matches', async () => {
    const first = await request(baseUrl, `/pois${NON_EMPTY_PATH}`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    const response = await request(baseUrl, `/pois${NON_EMPTY_PATH}`, {
      headers: {
        'accept-encoding': 'gzip',
        'if-none-match': first.headers.etag,
      },
    });

    expect(response.status).toBe(304);
    expect(response.headers.etag).toBe(first.headers.etag);
    expect(response.headers['cache-control']).toBe('public, max-age=300');
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.headers.vary).toBe('accept-encoding');
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-expose-headers']).toBe(EXPOSE_HEADERS);
    expect(response.body).toHaveLength(0);
  });

  it.each([
    ['zoom out of range', '/pois/27/0/0.pbf'],
    ['x out of range', '/pois/12/4096/0.pbf'],
    ['y out of range', '/pois/12/0/4096.pbf'],
    ['non-integer coordinate', '/pois/12/not-a-number/0.pbf'],
    ['query string on a tile', '/pois/12/2167/1454.pbf?token=1'],
  ])('returns 400 for %s', async (_label, pathname) => {
    const response = await request(baseUrl, pathname);

    expect(response.status).toBe(400);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(json(response).error).toBeTypeOf('string');
  });

  it('returns 400 for an invalid build id', async () => {
    const response = await request(
      baseUrl,
      `/pois/${encodeURIComponent('bad build')}${NON_EMPTY_PATH}`,
    );

    expect(response.status).toBe(400);
    expect(json(response)).toEqual({ error: 'invalid_build_id' });
  });

  it.each([
    ['unknown source', '/unknown/12/0/0.pbf'],
    ['unknown TileJSON', '/unknown.json'],
    ['unknown route', '/not-a-route'],
    ['prototype tile source', '/toString/12/0/0.pbf'],
    ['constructor tile source', '/constructor/12/0/0.pbf'],
    ['proto tile source', '/__proto__/12/0/0.pbf'],
    ['prototype TileJSON source', '/toString.json'],
    ['constructor TileJSON source', '/constructor.json'],
    ['proto TileJSON source', '/__proto__.json'],
  ])('returns 404 for %s', async (_label, pathname) => {
    const response = await request(baseUrl, pathname);

    expect(response.status).toBe(404);
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(json(response)).toEqual({ error: 'not_found' });
  });

  it('supports HEAD without a body', async () => {
    const health = await request(baseUrl, '/health', { method: 'HEAD' });
    const tile = await request(baseUrl, `/pois${NON_EMPTY_PATH}`, {
      method: 'HEAD',
      headers: { 'accept-encoding': 'gzip' },
    });

    expect(health.status).toBe(200);
    expect(health.body).toHaveLength(0);
    expect(Number(health.headers['content-length'])).toBeGreaterThan(0);

    expect(tile.status).toBe(200);
    expect(tile.body).toHaveLength(0);
    expect(tile.headers['content-encoding']).toBe('gzip');
    expect(Number(tile.headers['content-length'])).toBeGreaterThan(0);
  });

  it('supports OPTIONS on known routes with CORS and an Allow header', async () => {
    const response = await request(baseUrl, `/pois${NON_EMPTY_PATH}`, { method: 'OPTIONS' });

    expect(response.status).toBe(204);
    expect(response.headers.allow).toBe('GET, HEAD, OPTIONS');
    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['access-control-allow-methods']).toBe('GET, HEAD, OPTIONS');
    expect(response.headers['access-control-allow-headers']).toBe('If-None-Match');
    expect(response.headers['access-control-expose-headers']).toBe(EXPOSE_HEADERS);
    expect(response.body).toHaveLength(0);
  });

  it('returns 404 for OPTIONS on an unknown route', async () => {
    const response = await request(baseUrl, '/not-a-route', { method: 'OPTIONS' });

    expect(response.status).toBe(404);
    expect(json(response)).toEqual({ error: 'not_found' });
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('returns 405 for %s', async (method) => {
    const response = await request(baseUrl, '/health', { method });

    expect(response.status).toBe(405);
    expect(response.headers.allow).toBe('GET, HEAD, OPTIONS');
    expect(json(response)).toEqual({ error: 'method_not_allowed' });
  });

  it('returns 404 for unsupported methods on unknown routes', async () => {
    const response = await request(baseUrl, '/not-a-route', { method: 'POST' });

    expect(response.status).toBe(404);
  });
});

describe('tile server with a missing archive', () => {
  let temp;
  let app;
  let baseUrl;

  beforeAll(async () => {
    temp = await createTempData({ current: false });
    app = await createApp(makeConfig(temp.dataDir));
    baseUrl = await listen(app);
  });

  afterAll(async () => {
    await app?.close();
    await temp?.cleanup();
  });

  it('reports degraded health', async () => {
    const response = await request(baseUrl, '/health');

    expect(response.status).toBe(200);
    expect(json(response)).toMatchObject({
      status: 'degraded',
      sources: { pois: { available: false, buildId: null } },
    });
  });

  it('reports not ready', async () => {
    const response = await request(baseUrl, '/ready');

    expect(response.status).toBe(503);
    expect(json(response)).toEqual({ status: 'not_ready', unavailable: ['pois'] });
  });

  it('reports the source as unavailable in the catalogue', async () => {
    const response = await request(baseUrl, '/sources');

    expect(response.status).toBe(200);
    expect(json(response).sources[0]).toMatchObject({
      name: 'pois',
      available: false,
      buildId: null,
    });
  });

  it('returns 503 for tiles and TileJSON of an unavailable source', async () => {
    const tile = await request(baseUrl, `/pois${NON_EMPTY_PATH}`);
    const tileJson = await request(baseUrl, '/pois.json');

    expect(tile.status).toBe(503);
    expect(tileJson.status).toBe(503);
    expect(json(tile)).toEqual({ error: 'source_unavailable' });
    expect(json(tileJson)).toEqual({ error: 'source_unavailable' });
    expect(tile.headers['access-control-allow-origin']).toBe('*');
  });
});
