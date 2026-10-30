import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { zxyToTileId as oracleZxyToTileId } from 'pmtiles';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PmtilesReader, zxyToTileId } from '../../src/lib/pmtiles.mjs';
import { writeArchiveFile, writeSyntheticArchive } from '../helpers/archive.mjs';
import { createOracle } from '../helpers/oracle.mjs';
import { createTempDirectory, fixturePath, removeTempDirectory } from '../helpers/temp.mjs';

const NON_EMPTY_TILE = { z: 12, x: 2167, y: 1454 };
const EMPTY_TILE = { z: 12, x: 0, y: 0 };
const createdDirectories = [];

let reader;
let oracle;

beforeAll(async () => {
  reader = new PmtilesReader(fixturePath);
  await reader.open();
  oracle = await createOracle(fixturePath);
});

afterAll(async () => {
  await reader?.close();
  await oracle?.close();
  await Promise.all(
    createdDirectories.splice(0).map((directory) => removeTempDirectory(directory)),
  );
});

async function makeDirectory() {
  const directory = await createTempDirectory('tiles-pmtiles-');
  createdDirectories.push(directory);
  return directory;
}

async function makeArchive(options = {}) {
  const directory = await makeDirectory();
  const filePath = path.join(directory, 'archive.pmtiles');
  await writeArchiveFile(filePath, options);
  return filePath;
}

function decompressTile(tile) {
  return tile.compression === 'gzip' ? gunzipSync(tile.data) : tile.data;
}

function encodeVarint(value) {
  const bytes = [];
  let remaining = value;

  do {
    let byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) {
      byte += 128;
    }
    bytes.push(byte);
  } while (remaining > 0);

  return Buffer.from(bytes);
}

describe('PmtilesReader', () => {
  it('parses the header identically to the reference implementation', async () => {
    const { etag, ...expected } = await oracle.archive.getHeader();

    expect(etag).toBeUndefined();
    expect(reader.getHeader()).toEqual(expected);
  });

  it('parses metadata identically to the reference implementation', async () => {
    expect(await reader.getMetadata()).toEqual(await oracle.archive.getMetadata());
  });

  it('reads a known non-empty tile as raw compressed bytes', async () => {
    const tile = await reader.getTile(NON_EMPTY_TILE.z, NON_EMPTY_TILE.x, NON_EMPTY_TILE.y);
    const oracleTile = await oracle.archive.getZxy(
      NON_EMPTY_TILE.z,
      NON_EMPTY_TILE.x,
      NON_EMPTY_TILE.y,
    );

    expect(tile).not.toBeNull();
    expect(tile.compression).toBe('gzip');
    expect(oracleTile).toBeDefined();
    expect(decompressTile(tile).equals(Buffer.from(oracleTile.data))).toBe(true);
  });

  it('returns null for a known empty tile', async () => {
    expect(await reader.getTile(EMPTY_TILE.z, EMPTY_TILE.x, EMPTY_TILE.y)).toBeNull();
    expect(await oracle.archive.getZxy(EMPTY_TILE.z, EMPTY_TILE.x, EMPTY_TILE.y)).toBeUndefined();
  });

  it('matches the reference implementation for a spread of tiles', async () => {
    const tiles = [
      [12, 2167, 1454],
      [12, 2167, 1455],
      [13, 4334, 2908],
      [16, 34675, 23275],
      [9, 272, 181],
      [12, 0, 0],
      [16, 0, 0],
    ];

    for (const [z, x, y] of tiles) {
      const tile = await reader.getTile(z, x, y);
      const oracleTile = await oracle.archive.getZxy(z, x, y);

      if (!oracleTile) {
        expect(tile).toBeNull();
        continue;
      }

      expect(tile).not.toBeNull();
      expect(decompressTile(tile).equals(Buffer.from(oracleTile.data))).toBe(true);
    }
  });

  it('decodes a non-empty tile as Mapbox Vector Tile', async () => {
    const tile = await reader.getTile(NON_EMPTY_TILE.z, NON_EMPTY_TILE.x, NON_EMPTY_TILE.y);
    const vectorTile = new VectorTile(new PbfReader(decompressTile(tile)));

    expect(Object.keys(vectorTile.layers)).toEqual(['outdoor_pois']);
    expect(vectorTile.layers.outdoor_pois.length).toBe(29);
  });

  it('normalises non-object metadata to an empty object', async () => {
    const directory = await makeDirectory();
    await writeSyntheticArchive(directory, { metadata: 'null' });

    const synthetic = new PmtilesReader(path.join(directory, 'current.pmtiles'));
    await synthetic.open();

    expect(await synthetic.getMetadata()).toEqual({});
    await synthetic.close();
  });

  it('shares one open operation between concurrent callers', async () => {
    const concurrent = new PmtilesReader(fixturePath);
    const [first, second] = await Promise.all([concurrent.open(), concurrent.open()]);
    const handle = concurrent.handle;

    expect(second).toBe(first);
    expect(handle).not.toBeNull();

    const [third] = await Promise.all([concurrent.open(), concurrent.open()]);

    expect(third).toBe(first);
    expect(concurrent.handle).toBe(handle);

    await concurrent.close();
    expect(concurrent.handle).toBeNull();
  });

  it('does not expose a partially initialised reader while open is in flight', async () => {
    const pending = new PmtilesReader(fixturePath);
    const readDirectory = pending.readDirectory.bind(pending);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });

    pending.readDirectory = async (...args) => {
      await gate;
      return readDirectory(...args);
    };

    let first;

    try {
      first = pending.open();

      for (let attempt = 0; attempt < 100 && !pending.handle; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      expect(pending.handle).not.toBeNull();
      expect(pending.rootDirectory).toBeNull();

      const second = pending.open();

      expect(second).toBe(first);
      await expect(pending.getTile(12, 2167, 1454)).rejects.toThrow(/not open/i);

      release();
      await first;

      expect(pending.rootDirectory).not.toBeNull();
    } finally {
      release();
      await first?.catch(() => {});
      await pending.close();
    }
  });

  it('rejects a missing archive with a clear error', async () => {
    const directory = await makeDirectory();
    const missing = new PmtilesReader(path.join(directory, 'does-not-exist.pmtiles'));

    await expect(missing.open()).rejects.toThrow(/not found/i);
  });

  it('rejects an invalid magic number', async () => {
    const filePath = await makeArchive({ header: { magic: 'NOPE123' } });

    await expect(new PmtilesReader(filePath).open()).rejects.toThrow(/magic/i);
  });

  it('rejects an unsupported spec version', async () => {
    const filePath = await makeArchive({ header: { version: 4 } });

    await expect(new PmtilesReader(filePath).open()).rejects.toThrow(/version/i);
  });

  it('rejects unsupported internal compression', async () => {
    const filePath = await makeArchive({
      header: { internalCompression: 3, rootDirectoryLength: 1 },
      body: Buffer.from([0]),
    });

    await expect(new PmtilesReader(filePath).open()).rejects.toThrow(/compression/i);
  });

  it('rejects a corrupt directory', async () => {
    const filePath = await makeArchive({
      header: { rootDirectoryLength: 4 },
      body: Buffer.from([5, 0, 0, 0]),
    });

    await expect(new PmtilesReader(filePath).open()).rejects.toThrow(/corrupt|unexpected end/i);
  });

  it('rejects a truncated header', async () => {
    const directory = await makeDirectory();
    const filePath = path.join(directory, 'short.pmtiles');
    await writeFile(filePath, Buffer.alloc(50));

    await expect(new PmtilesReader(filePath).open()).rejects.toThrow(/exceeds|too short/i);
  });

  it('rejects an oversized declared directory length before allocating', async () => {
    const filePath = await makeArchive({
      header: { rootDirectoryLength: 64 * 1024 * 1024 + 1 },
    });

    await expect(new PmtilesReader(filePath).open()).rejects.toThrow(/limit/i);
  });

  it('rejects an oversized declared metadata length', async () => {
    const filePath = await makeArchive({
      header: {
        rootDirectoryLength: 1,
        jsonMetadataOffset: 128,
        jsonMetadataLength: 16 * 1024 * 1024 + 1,
      },
      body: Buffer.from([0]),
    });

    await expect(new PmtilesReader(filePath).open()).rejects.toThrow(/metadata.*limit/i);
  });

  it('rejects a tile larger than the tile size limit', async () => {
    const directory = await makeDirectory();
    const root = Buffer.concat([
      encodeVarint(1),
      encodeVarint(0),
      encodeVarint(1),
      encodeVarint(32 * 1024 * 1024 + 1),
      encodeVarint(1),
    ]);
    const filePath = path.join(directory, 'archive.pmtiles');
    await writeArchiveFile(filePath, {
      header: {
        rootDirectoryLength: root.length,
        minZoom: 0,
        maxZoom: 0,
      },
      body: root,
    });

    const synthetic = new PmtilesReader(filePath);
    await synthetic.open();

    await expect(synthetic.getTile(0, 0, 0)).rejects.toThrow(/tile length|too large/i);
    await synthetic.close();
  });
});

describe('zxyToTileId', () => {
  it('matches the reference implementation exhaustively at low zooms', () => {
    for (let z = 0; z <= 5; z += 1) {
      const size = 2 ** z;

      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          expect(zxyToTileId(z, x, y)).toBe(oracleZxyToTileId(z, x, y));
        }
      }
    }
  });

  it('matches the reference implementation for a sample at higher zooms', () => {
    const tiles = [
      [6, 0, 0],
      [6, 63, 63],
      [10, 512, 512],
      [14, 9000, 6000],
      [16, 34675, 23275],
      [20, 524288, 349525],
      [26, 0, 67108863],
      [26, 67108863, 0],
      [26, 67108863, 67108863],
    ];

    for (const [z, x, y] of tiles) {
      expect(zxyToTileId(z, x, y)).toBe(oracleZxyToTileId(z, x, y));
    }
  });

  it('rejects coordinates outside the zoom level', () => {
    expect(() => zxyToTileId(2, 4, 0)).toThrow(RangeError);
    expect(() => zxyToTileId(2, 0, 4)).toThrow(RangeError);
    expect(() => zxyToTileId(27, 0, 0)).toThrow(RangeError);
  });
});
