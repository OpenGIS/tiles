import { describe, expect, it } from 'vitest';

import { BuildError } from '../../../src/build/errors.mjs';
import { repairHeader, serialiseHeader } from '../../../src/build/header.mjs';

const HEADER = {
  tile_compression: 'gzip',
  tile_type: 'mvt',
  minzoom: 12,
  maxzoom: 16,
  bounds: [-115.65, 50.95, -115.05, 51.35],
  center: [-115.35, 51.15, 12],
};

describe('repairHeader', () => {
  it('preserves a valid existing centre', () => {
    const repaired = repairHeader(HEADER);

    expect(repaired.center).toEqual([-115.35, 51.15, 12]);
    expect(repaired).not.toBe(HEADER);
    expect(HEADER.center).toEqual([-115.35, 51.15, 12]);
  });

  it('preserves every other header field', () => {
    const repaired = repairHeader(HEADER);

    expect(repaired).toMatchObject({
      tile_compression: 'gzip',
      tile_type: 'mvt',
      minzoom: 12,
      maxzoom: 16,
      bounds: [-115.65, 50.95, -115.05, 51.35],
    });
  });

  it('derives the centre from the bounds midpoint when the centre is missing', () => {
    const { center: _center, ...header } = HEADER;

    const repairedCenter = repairHeader(header).center;

    expect(repairedCenter[0]).toBeCloseTo(-115.35);
    expect(repairedCenter[1]).toBeCloseTo(51.15);
    expect(repairedCenter[2]).toBe(12);
  });

  it('falls back to the origin when neither centre nor bounds are valid', () => {
    const { center, bounds, ...header } = HEADER;

    expect(repairHeader(header).center).toEqual([0, 0, 12]);
  });

  it('clamps an explicit centre zoom to the archive zoom range', () => {
    expect(repairHeader(HEADER, { centerZoom: 0 }).center).toEqual([-115.35, 51.15, 12]);
    expect(repairHeader(HEADER, { centerZoom: 40 }).center).toEqual([-115.35, 51.15, 16]);
  });

  it('clamps a stale existing centre zoom to the archive zoom range', () => {
    const repaired = repairHeader({ ...HEADER, center: [-115.35, 51.15, 20] });

    expect(repaired.center).toEqual([-115.35, 51.15, 16]);
  });

  it('repairs a stale minzoom from the profile contents', () => {
    const repaired = repairHeader({ ...HEADER, minzoom: 0 }, { minzoom: 12 });

    expect(repaired.minzoom).toBe(12);
    expect(repaired.center).toEqual([-115.35, 51.15, 12]);
  });

  it('rejects a minzoom above maxzoom', () => {
    expect(() => repairHeader(HEADER, { minzoom: 17 })).toThrow(BuildError);
  });

  it.each([
    ['a non-object header', null],
    ['a missing minzoom', { maxzoom: 16 }],
    ['an out-of-range minzoom', { minzoom: 27, maxzoom: 28 }],
    ['malformed bounds', { minzoom: 0, maxzoom: 16, bounds: [1, 2] }],
    ['non-numeric bounds', { minzoom: 0, maxzoom: 16, bounds: [1, 2, 3, 'x'] }],
    ['impossible bounds', { minzoom: 0, maxzoom: 16, bounds: [999, 999, -999, -999] }],
    [
      'inverted longitude bounds',
      { minzoom: 0, maxzoom: 16, bounds: [-115.05, 50.95, -115.65, 51.35] },
    ],
    [
      'inverted latitude bounds',
      { minzoom: 0, maxzoom: 16, bounds: [-115.65, 51.35, -115.05, 50.95] },
    ],
    [
      'out-of-range longitude bounds',
      { minzoom: 0, maxzoom: 16, bounds: [-181, 50.95, -115.05, 51.35] },
    ],
    [
      'out-of-range latitude bounds',
      { minzoom: 0, maxzoom: 16, bounds: [-115.65, -91, -115.05, 51.35] },
    ],
    ['malformed centre', { minzoom: 0, maxzoom: 16, center: [1, 2] }],
    ['non-numeric centre', { minzoom: 0, maxzoom: 16, center: [1, 2, 'x'] }],
    ['a centre outside its bounds', { ...HEADER, center: [-100, 51.15, 12] }],
    ['an out-of-range centre longitude', { ...HEADER, center: [200, 51.15, 12] }],
    ['an out-of-range centre latitude', { ...HEADER, center: [-115.35, 95, 12] }],
  ])('rejects %s', (_label, header) => {
    expect(() => repairHeader(header)).toThrow(BuildError);
  });

  it('rejects a negative or non-integer explicit centre zoom', () => {
    expect(() => repairHeader(HEADER, { centerZoom: -1 })).toThrow(BuildError);
    expect(() => repairHeader(HEADER, { centerZoom: 1.5 })).toThrow(BuildError);
  });
});

describe('serialiseHeader', () => {
  it('writes stable, indented JSON with a trailing newline', () => {
    const output = serialiseHeader({ a: 1, center: [0, 0, 12] });

    expect(output).toBe('{\n  "a": 1,\n  "center": [\n    0,\n    0,\n    12\n  ]\n}\n');
  });
});
