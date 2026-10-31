import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { describe, expect, it } from 'vitest';

import { validateConfig } from '../../src/lib/config.mjs';
import { DemDecodeError, SourceUnavailableError } from '../../src/lib/errors.mjs';
import {
  contourBuildId,
  createContourSource,
  getOptionsForZoom,
} from '../../src/sources/contour.mjs';
import { demFixtureDir } from '../helpers/dem-server.mjs';

const FIXTURE = path.join(demFixtureDir, '12', '735', '1368.webp');

function rawConfig(overrides = {}) {
  return {
    kind: 'contour',
    title: 'Terrain contours',
    description: 'Contour lines generated on demand.',
    attribution: [{ title: 'Mapterhorn', href: 'https://mapterhorn.com/attribution' }],
    minzoom: 1,
    maxzoom: 15,
    demUrl: 'https://tiles.example/{z}/{x}/{y}.webp',
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
      12: [20, 100],
    },
    ...overrides,
  };
}

function contourConfig(overrides = {}) {
  return validateConfig(
    {
      version: 1,
      server: { host: '127.0.0.1', port: 11010 },
      sources: { contours: rawConfig(overrides) },
    },
    { repoRoot: '/srv/tiles' },
  ).sources.contours;
}

function responseFor(buffer, { status = 200, contentType = 'image/webp', headers = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ 'content-type': contentType, ...headers }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(buffer));
        controller.close();
      },
    }),
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
  };
}

function streamingResponse(createStream, { status = 200, headers = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ 'content-type': 'image/webp', ...headers }),
    body: new ReadableStream(createStream),
  };
}

async function makeSource({ overrides = {}, fetch: fetchImpl } = {}) {
  return createContourSource('contours', contourConfig(overrides), {
    fetch: fetchImpl,
  });
}

describe('contourBuildId', () => {
  it('produces a stable twelve-character hexadecimal hash', () => {
    const config = contourConfig();
    const buildId = contourBuildId(config);

    expect(buildId).toMatch(/^[0-9a-f]{12}$/);
    expect(contourBuildId(config)).toBe(buildId);
  });

  it('ignores threshold object key order', () => {
    const first = contourConfig({
      thresholds: {
        4: [300, 1500],
        12: [20, 100],
      },
    });
    const second = contourConfig({
      thresholds: {
        12: [20, 100],
        4: [300, 1500],
      },
    });

    expect(contourBuildId(first)).toBe(contourBuildId(second));
  });

  it('changes when a hashed config field changes', () => {
    const base = contourConfig();

    expect(contourBuildId(contourConfig({ buffer: 2 }))).not.toBe(contourBuildId(base));
    expect(contourBuildId(contourConfig({ minzoom: 2 }))).not.toBe(contourBuildId(base));
    expect(contourBuildId(contourConfig({ thresholds: { 12: [10, 50] } }))).not.toBe(
      contourBuildId(base),
    );
  });

  it('changes when demTileSize changes', () => {
    const base = contourConfig();

    expect(contourBuildId(contourConfig({ demTileSize: 1024 }))).not.toBe(contourBuildId(base));
  });
});

describe('getOptionsForZoom', () => {
  const options = {
    extent: 4096,
    thresholds: {
      1: [600, 3000],
      4: [300, 1500],
      8: [150, 750],
      12: [20, 100],
    },
  };

  it('selects the highest threshold at or below the requested zoom', () => {
    expect(getOptionsForZoom(options, 8).levels).toEqual([150, 750]);
    expect(getOptionsForZoom(options, 9).levels).toEqual([150, 750]);
    expect(getOptionsForZoom(options, 12).levels).toEqual([20, 100]);
    expect(getOptionsForZoom(options, 20).levels).toEqual([20, 100]);
  });

  it('falls back to the lowest threshold below the first entry', () => {
    expect(getOptionsForZoom(options, 0).levels).toEqual([600, 3000]);
  });

  it('removes thresholds and preserves the remaining options', () => {
    const result = getOptionsForZoom(options, 12);

    expect(result).toEqual({ levels: [20, 100], extent: 4096 });
    expect(result).not.toHaveProperty('thresholds');
  });

  it('returns options untouched when no thresholds are configured', () => {
    const plain = { extent: 4096 };

    expect(getOptionsForZoom(plain, 5)).toBe(plain);
  });
});

describe('createContourSource', () => {
  it('constructs an available source with the config hash', async () => {
    const source = await makeSource();

    expect(source.available).toBe(true);
    expect(source.kind).toBe('contour');
    expect(source.name).toBe('contours');
    expect(source.buildId).toBe(contourBuildId(contourConfig()));
    expect(source.cacheMaxAge).toBe(86400);
  });

  it('returns an empty tile outside the configured zoom range without fetching', async () => {
    let calls = 0;
    const source = await makeSource({
      fetch: async () => {
        calls += 1;
        throw new Error('should not fetch');
      },
    });

    expect(await source.getTile(0, 0, 0)).toEqual({
      empty: true,
      buildId: source.buildId,
    });
    expect(await source.getTile(16, 0, 0)).toEqual({
      empty: true,
      buildId: source.buildId,
    });
    expect(calls).toBe(0);
  });

  it('returns notFound for a mismatched build id', async () => {
    const source = await makeSource();

    expect(await source.getTile(12, 735, 1368, 'other-build')).toEqual({ notFound: true });
  });

  it('gzip-compresses a generated contour tile', async () => {
    const buffer = await readFile(FIXTURE);
    const source = await makeSource({ fetch: async () => responseFor(buffer) });

    const tile = await source.getTile(12, 735, 1368);

    expect(tile.notFound).toBeUndefined();
    expect(tile.empty).toBeUndefined();
    expect(tile.compression).toBe('gzip');
    expect(tile.buildId).toBe(source.buildId);

    const decoded = new VectorTile(new PbfReader(gunzipSync(tile.data)));
    const layer = decoded.layers.contours;

    expect(layer).toBeDefined();
    expect(layer.length).toBeGreaterThanOrEqual(50);
    expect(layer.length).toBeLessThanOrEqual(100);

    let minimum = Infinity;
    let maximum = -Infinity;

    for (let index = 0; index < layer.length; index += 1) {
      const feature = layer.feature(index);
      minimum = Math.min(minimum, feature.properties.ele);
      maximum = Math.max(maximum, feature.properties.ele);
      expect([0, 1]).toContain(feature.properties.level);
      expect(feature.type).toBe(2);
    }

    expect(minimum).toBeGreaterThanOrEqual(1000);
    expect(maximum).toBeLessThanOrEqual(3000);
  });

  it('returns an empty tile when a DEM neighbour has no coverage', async () => {
    const source = await makeSource({
      fetch: async () => responseFor(Buffer.alloc(0), { status: 404 }),
    });

    expect(await source.getTile(12, 735, 1368)).toEqual({
      empty: true,
      buildId: source.buildId,
    });
  });

  it('maps an upstream 5xx to SourceUnavailableError', async () => {
    const source = await makeSource({
      fetch: async () => responseFor(Buffer.alloc(0), { status: 503 }),
    });

    const error = await source.getTile(12, 735, 1368).catch((reason) => reason);

    expect(error).toBeInstanceOf(SourceUnavailableError);
    expect(error.retryAfter).toBe(60);
  });

  it('uses the upstream Retry-After header on 429 and 5xx responses', async () => {
    for (const status of [429, 503]) {
      const source = await makeSource({
        fetch: async () =>
          responseFor(Buffer.alloc(0), { status, headers: { 'retry-after': '120' } }),
      });

      const error = await source.getTile(12, 735, 1368).catch((reason) => reason);

      expect(error).toBeInstanceOf(SourceUnavailableError);
      expect(error.retryAfter).toBe(120);
    }
  });

  it('falls back to 60 when Retry-After is invalid', async () => {
    const source = await makeSource({
      fetch: async () =>
        responseFor(Buffer.alloc(0), { status: 503, headers: { 'retry-after': 'soon' } }),
    });

    const error = await source.getTile(12, 735, 1368).catch((reason) => reason);

    expect(error).toBeInstanceOf(SourceUnavailableError);
    expect(error.retryAfter).toBe(60);
  });

  it('cancels the body of a failed DEM response', async () => {
    let cancelled = false;
    const source = await makeSource({
      fetch: async () =>
        streamingResponse(
          {
            cancel() {
              cancelled = true;
            },
          },
          { status: 503 },
        ),
    });

    const error = await source.getTile(12, 735, 1368).catch((reason) => reason);

    expect(error).toBeInstanceOf(SourceUnavailableError);
    expect(cancelled).toBe(true);
  });

  it('rejects a DEM response with an oversized Content-Length', async () => {
    const source = await makeSource({
      fetch: async () =>
        responseFor(Buffer.alloc(0), {
          headers: { 'content-length': String(5 * 1024 * 1024 + 1) },
        }),
    });

    await expect(source.getTile(12, 735, 1368)).rejects.toBeInstanceOf(DemDecodeError);
  });

  it('rejects a DEM response whose body exceeds the cap', async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    const source = await makeSource({
      fetch: async () =>
        streamingResponse({
          pull(controller) {
            if (sent >= 6) {
              controller.close();
              return;
            }

            sent += 1;
            controller.enqueue(chunk);
          },
        }),
    });

    await expect(source.getTile(12, 735, 1368)).rejects.toBeInstanceOf(DemDecodeError);
  });

  it('maps a network failure to SourceUnavailableError', async () => {
    const source = await makeSource({
      fetch: async () => {
        throw new Error('connection refused');
      },
    });

    await expect(source.getTile(12, 735, 1368)).rejects.toBeInstanceOf(SourceUnavailableError);
  });

  it('maps a corrupt DEM image to DemDecodeError', async () => {
    const source = await makeSource({
      fetch: async () => responseFor(Buffer.from('not an image')),
    });

    await expect(source.getTile(12, 735, 1368)).rejects.toBeInstanceOf(DemDecodeError);
  });

  it('maps a DEM timeout to SourceUnavailableError', async () => {
    const source = await createContourSource(
      'contours',
      { ...contourConfig(), timeoutMs: 20 },
      {
        fetch: async (url, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          }),
      },
    );

    const error = await source.getTile(12, 735, 1368).catch((reason) => reason);

    expect(error).toBeInstanceOf(SourceUnavailableError);
  });

  it('builds TileJSON with an unversioned tile URL and contour vector layer', async () => {
    const source = await makeSource();
    const tileJson = source.getTileJson('https://tiles.example');

    expect(tileJson).toEqual({
      tilejson: '3.0.0',
      name: 'Terrain contours',
      description: 'Contour lines generated on demand.',
      attribution: '<a href="https://mapterhorn.com/attribution">Mapterhorn</a>',
      scheme: 'xyz',
      tiles: ['https://tiles.example/contours/{z}/{x}/{y}.pbf'],
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
  });

  it('builds a catalogue entry with an unversioned tile URL', async () => {
    const source = await makeSource();

    expect(source.getCatalogueEntry()).toEqual({
      name: 'contours',
      kind: 'contour',
      title: 'Terrain contours',
      description: 'Contour lines generated on demand.',
      attribution: [{ title: 'Mapterhorn', href: 'https://mapterhorn.com/attribution' }],
      minzoom: 1,
      maxzoom: 15,
      available: true,
      buildId: source.buildId,
      tilejson: '/contours.json',
      tiles: ['/contours/{z}/{x}/{y}.pbf'],
    });
  });

  it('closes without holding file handles', async () => {
    const source = await makeSource();

    await expect(source.close()).resolves.toBeUndefined();
  });
});
