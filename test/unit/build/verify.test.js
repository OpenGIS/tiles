import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { BuildError } from '../../../src/build/errors.mjs';
import {
  assertVerifyCommandOutput,
  decodeSampleTile,
  parseTileCompression,
  parseTileCount,
  verificationLayers,
} from '../../../src/build/verify.mjs';

const fixtureArchive = path.resolve('test/fixtures/pois.pmtiles');

describe('parseTileCount', () => {
  it('reads the addressed tile count from pmtiles show', () => {
    const output = [
      'pmtiles spec version: 3',
      'tile type: mvt',
      'addressed tiles count: 42',
      'tile entries count: 42',
    ].join('\n');

    expect(parseTileCount(output)).toBe(42);
  });

  it('rejects output without a tile count', () => {
    expect(() => parseTileCount('pmtiles spec version: 3')).toThrow(BuildError);
  });
});

describe('parseTileCompression', () => {
  it('reads the tile compression from pmtiles show', () => {
    expect(parseTileCompression('tile type: mvt\ntile compression: gzip\n')).toBe('gzip');
  });

  it('rejects output without tile compression', () => {
    expect(() => parseTileCompression('tile type: mvt')).toThrow(BuildError);
  });
});

describe('pmtiles verify output', () => {
  it('accepts a completed verification', () => {
    expect(() =>
      assertVerifyCommandOutput('verify.go:169: Completed verify in 1.2ms.'),
    ).not.toThrow();
  });

  it('rejects a verification failure even when the exit code was zero', () => {
    expect(() =>
      assertVerifyCommandOutput('main.go:239: Failed to verify archive, invalid: bad header'),
    ).toThrow(/Failed to verify archive/);
  });

  it('rejects output without a success marker', () => {
    expect(() => assertVerifyCommandOutput('')).toThrow(/did not report a successful/);
  });
});

describe('verification layers', () => {
  it('normalises a single layer block', () => {
    expect(
      verificationLayers({ layer: 'outdoor_pois', requiredAttributes: ['kind', 'name'] }),
    ).toEqual([{ layer: 'outdoor_pois', requiredAttributes: ['kind', 'name'] }]);
  });

  it('passes through a layers list', () => {
    const layers = [
      { layer: 'outdoor_pois', requiredAttributes: ['kind'] },
      { layer: 'labels', requiredAttributes: ['text'] },
    ];

    expect(verificationLayers({ layers })).toEqual(layers);
  });
});

describe('decodeSampleTile', () => {
  it('rejects an empty tile', async () => {
    const execFileImpl = vi.fn().mockResolvedValue({ stdout: Buffer.alloc(0), stderr: '' });

    await expect(
      decodeSampleTile({
        archivePath: 'current.pmtiles',
        sample: { z: 13, x: 1471, y: 2739 },
        layer: 'outdoor_pois',
        execFileImpl,
      }),
    ).rejects.toThrow(/is empty/i);
  });

  it('decodes the fixture POI layer and the configured attributes', async () => {
    const sample = await decodeSampleTile({
      archivePath: fixtureArchive,
      sample: { z: 12, x: 2167, y: 1454 },
      verification: {
        layer: 'outdoor_pois',
        requiredAttributes: ['kind', 'name'],
      },
    });

    expect(sample.layer).toBe('outdoor_pois');
    expect(sample.features).toBeGreaterThan(0);
    expect(sample.attributes).toEqual(expect.arrayContaining(['kind', 'name']));
  });

  it('rejects a decoded layer without a configured attribute', async () => {
    await expect(
      decodeSampleTile({
        archivePath: fixtureArchive,
        sample: { z: 12, x: 2167, y: 1454 },
        verification: {
          layer: 'outdoor_pois',
          requiredAttributes: ['kind', 'not_a_real_attribute'],
        },
      }),
    ).rejects.toThrow(/not_a_real_attribute/);
  });
});
