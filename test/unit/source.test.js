import { copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { PmtilesReader } from '../../src/lib/pmtiles.mjs';
import { createPmtilesSource } from '../../src/sources/pmtiles.mjs';
import { writeSyntheticArchive } from '../helpers/archive.mjs';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp.mjs';

const createdDirectories = [];
const createdSources = [];

afterEach(async () => {
  await Promise.all(createdSources.splice(0).map((source) => source.close()));
  await Promise.all(
    createdDirectories.splice(0).map((directory) => removeTempDirectory(directory)),
  );
});

function sourceConfig(directory, overrides = {}) {
  return {
    kind: 'pmtiles',
    title: 'Outdoor POIs',
    description: 'Points of interest.',
    attribution: [{ title: 'OpenStreetMap', href: 'https://www.openstreetmap.org/copyright' }],
    archiveDir: directory,
    minzoom: 8,
    maxzoom: 20,
    ...overrides,
  };
}

async function makeSource(archiveOptions = {}, sourceOverrides = {}) {
  const directory = await createTempDirectory('tiles-source-');
  createdDirectories.push(directory);
  await writeSyntheticArchive(directory, archiveOptions);

  const source = await createPmtilesSource('pois', sourceConfig(directory, sourceOverrides));
  createdSources.push(source);

  return source;
}

describe('createPmtilesSource', () => {
  it('marks non-MVT archives as unavailable', async () => {
    const source = await makeSource({ tileType: 2 });

    expect(source.available).toBe(false);
    expect(source.buildId).toBeNull();
  });

  it('accepts MVT archives and clamps TileJSON zooms to the archive header', async () => {
    const source = await makeSource({ tileType: 1, minZoom: 0, maxZoom: 16 });
    const tileJson = source.getTileJson('https://tiles.example');

    expect(source.available).toBe(true);
    expect(source.minzoom).toBe(8);
    expect(source.maxzoom).toBe(16);
    expect(tileJson.minzoom).toBe(8);
    expect(tileJson.maxzoom).toBe(16);
  });

  it('marks a source unavailable and clears zooms when the ranges do not intersect', async () => {
    const source = await makeSource(
      { tileType: 1, minZoom: 0, maxZoom: 16 },
      { minzoom: 20, maxzoom: 26 },
    );
    const tileJson = source.getTileJson('https://tiles.example');
    const catalogue = source.getCatalogueEntry();

    expect(source.available).toBe(false);
    expect(source.minzoom).toBeNull();
    expect(source.maxzoom).toBeNull();
    expect(tileJson.minzoom).toBeNull();
    expect(tileJson.maxzoom).toBeNull();
    expect(catalogue.minzoom).toBeNull();
    expect(catalogue.maxzoom).toBeNull();
  });

  it('closes opened readers when source construction fails afterwards', async () => {
    const directory = await createTempDirectory('tiles-source-');
    createdDirectories.push(directory);
    await writeSyntheticArchive(directory);
    await copyFile(
      path.join(directory, 'current.pmtiles'),
      path.join(directory, 'previous.pmtiles'),
    );
    await writeFile(
      path.join(directory, 'previous.json'),
      JSON.stringify({ buildId: 'previous-build' }),
      'utf8',
    );

    const config = sourceConfig(directory);
    Object.defineProperty(config, 'attribution', {
      get() {
        throw new Error('attribution failure');
      },
    });

    const closeSpy = vi.spyOn(PmtilesReader.prototype, 'close');

    try {
      await expect(createPmtilesSource('pois', config)).rejects.toThrow('attribution failure');
      expect(closeSpy).toHaveBeenCalledTimes(2);
    } finally {
      closeSpy.mockRestore();
    }
  });

  it('survives null metadata and exposes an empty vector layer list', async () => {
    const source = await makeSource({ metadata: 'null' });

    expect(source.available).toBe(true);
    expect(source.getTileJson('https://tiles.example').vector_layers).toEqual([]);
  });

  it('escapes attribution HTML', async () => {
    const source = await makeSource(
      {},
      {
        attribution: [
          {
            title: 'Outdoor <POIs> & "friends"',
            href: 'https://example.com/?a=1&b=2',
          },
        ],
      },
    );

    const attribution = source.getTileJson('https://tiles.example').attribution;

    expect(attribution).toBe(
      '<a href="https://example.com/?a=1&amp;b=2">Outdoor &lt;POIs&gt; &amp; &quot;friends&quot;</a>',
    );
  });
});
