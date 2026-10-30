import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PmtilesReader } from '../../src/lib/pmtiles.mjs';
import { fixtureManifestPath, fixturePath } from '../helpers/temp.mjs';

let manifest;
let reader;

function isIsoDate(value) {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

beforeAll(async () => {
  manifest = JSON.parse(await readFile(fixtureManifestPath, 'utf8'));
  reader = new PmtilesReader(fixturePath);
  await reader.open();
});

afterAll(async () => {
  await reader?.close();
});

describe('POI fixture', () => {
  it('matches the recorded SHA-256 and byte size', async () => {
    const contents = await readFile(fixturePath);
    const digest = createHash('sha256').update(contents).digest('hex');

    expect(digest).toBe(manifest.sha256);
    expect((await stat(fixturePath)).size).toBe(manifest.bytes);
  });

  it('records its provenance and ODbL licence', () => {
    const { extractDate, generatedAt } = manifest.provenance;

    expect(manifest.provenance.licence).toBe('ODbL-1.0');
    expect(manifest.provenance.upstream).toContain('Geofabrik');
    expect(manifest.provenance.generator).toContain('Planetiler');
    expect(manifest.provenance.generationCommand).toBeTypeOf('string');

    for (const value of [extractDate, generatedAt]) {
      expect(value === 'unknown' || isIsoDate(value)).toBe(true);
    }

    if (isIsoDate(extractDate) && isIsoDate(generatedAt)) {
      expect(Date.parse(generatedAt)).toBeGreaterThanOrEqual(Date.parse(extractDate));
    }
  });

  it('matches the recorded archive zoom range', () => {
    const header = reader.getHeader();

    expect(header.specVersion).toBe(manifest.archive.specVersion);
    expect(header.minZoom).toBe(manifest.archive.minZoom);
    expect(header.maxZoom).toBe(manifest.archive.maxZoom);
  });

  it('serves the recorded non-empty tile', async () => {
    const { z, x, y, layer, features } = manifest.knownTiles.nonEmpty;
    const tile = await reader.getTile(z, x, y);
    const data = tile.compression === 'gzip' ? gunzipSync(tile.data) : tile.data;
    const vectorTile = new VectorTile(new PbfReader(data));

    expect(tile).not.toBeNull();
    expect(vectorTile.layers[layer].length).toBe(features);
  });

  it('returns null for the recorded empty tile', async () => {
    const { z, x, y } = manifest.knownTiles.empty;

    expect(await reader.getTile(z, x, y)).toBeNull();
  });
});
