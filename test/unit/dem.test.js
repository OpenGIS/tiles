import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { decodeWebpDem } from '../../src/lib/dem.mjs';
import { DemDecodeError } from '../../src/lib/errors.mjs';
import { demFixtureDir } from '../helpers/dem-server.mjs';

const TILE_SIZE = 512;
const FIXTURE = path.join(demFixtureDir, '12', '735', '1368.webp');

describe('decodeWebpDem', () => {
  it('decodes a real terrarium WebP fixture', async () => {
    const buffer = await readFile(FIXTURE);
    const tile = await decodeWebpDem(buffer, 'terrarium', TILE_SIZE);

    expect(tile.width).toBe(TILE_SIZE);
    expect(tile.height).toBe(TILE_SIZE);
    expect(tile.data).toBeInstanceOf(Float32Array);
    expect(tile.data).toHaveLength(TILE_SIZE * TILE_SIZE);

    let minimum = Infinity;
    let maximum = -Infinity;

    for (const elevation of tile.data) {
      expect(Number.isFinite(elevation)).toBe(true);
      minimum = Math.min(minimum, elevation);
      maximum = Math.max(maximum, elevation);
    }

    expect(minimum).toBeGreaterThan(1000);
    expect(maximum).toBeLessThan(4000);
    expect(minimum).toBeLessThan(maximum);
  });

  it('rejects a buffer without the WebP magic bytes', async () => {
    const buffer = Buffer.from('this is not an image');

    await expect(decodeWebpDem(buffer, 'terrarium', TILE_SIZE)).rejects.toBeInstanceOf(
      DemDecodeError,
    );
  });

  it('rejects a non-WebP image format', async () => {
    const buffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00]);

    await expect(decodeWebpDem(buffer, 'terrarium', TILE_SIZE)).rejects.toBeInstanceOf(
      DemDecodeError,
    );
  });

  it('rejects a WebP whose dimensions do not match the configured tile size', async () => {
    const buffer = await readFile(FIXTURE);

    await expect(decodeWebpDem(buffer, 'terrarium', 1024)).rejects.toThrow(/1024x1024/);
  });

  it('rejects a corrupt WebP that carries the magic bytes', async () => {
    const buffer = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.from([0x10, 0x00, 0x00, 0x00]),
      Buffer.from('WEBP'),
      Buffer.from('not a real image'),
    ]);

    await expect(decodeWebpDem(buffer, 'terrarium', TILE_SIZE)).rejects.toBeInstanceOf(
      DemDecodeError,
    );
  });

  it('decodes mapbox-encoded values with the mapbox decoder', async () => {
    const buffer = await readFile(FIXTURE);
    const tile = await decodeWebpDem(buffer, 'mapbox', TILE_SIZE);

    expect(tile.width).toBe(TILE_SIZE);
    expect(tile.height).toBe(TILE_SIZE);
    expect(tile.data.every((value) => Number.isFinite(value))).toBe(true);
  });
});
