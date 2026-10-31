import { describe, expect, it } from 'vitest';

import {
  assertBuildId,
  buildIdPayload,
  canonicalJson,
  compactDate,
  computeBuildId,
  computeRunId,
  isBuildId,
  shortHash,
} from '../../../src/build/build-id.mjs';
import { BuildError } from '../../../src/build/errors.mjs';
import { isRealCalendarDate } from '../../../src/build/dates.mjs';

const ARCHIVE_SHA = 'a'.repeat(64);

const BASE = {
  source: 'pois',
  planetDate: '2026-10-29',
  planetSha256: 'b'.repeat(64),
  minzoom: 0,
  maxzoom: 16,
  filterApplied: true,
  filterSkipped: false,
  profileHash: 'c'.repeat(64),
  filterHash: 'd'.repeat(64),
  skips: { download: false, filter: false, build: false, verify: false },
  tools: {
    planetiler: { version: '0.10.2', sha256: 'e'.repeat(64) },
    pmtiles: { version: '1.31.2', sha256: 'f'.repeat(64) },
    java: { version: '26.0.2', sha256: '1'.repeat(64) },
    osmium: { version: '1.19.1', sha256: '2'.repeat(64) },
  },
};

describe('canonicalJson', () => {
  it('sorts object keys at every depth', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
    );
  });

  it('keeps array order', () => {
    expect(canonicalJson([2, 1])).toBe('[2,1]');
  });
});

describe('build IDs', () => {
  it('are content-addressed for fixture builds', () => {
    const first = computeBuildId({
      mode: 'fixture',
      planetDate: BASE.planetDate,
      archiveSha256: ARCHIVE_SHA,
    });
    const second = computeBuildId({
      mode: 'fixture',
      planetDate: BASE.planetDate,
      archiveSha256: ARCHIVE_SHA,
    });

    expect(first).toBe(second);
    expect(first).toBe('fixture-aaaaaaaaaaaa');
  });

  it.each([
    ['a fixture build ID', 'fixture-0123456789ab', true],
    ['a planet build ID', '20261029-0123456789ab', true],
    ['a dot', '.', false],
    ['a parent segment', '..', false],
    ['a path separator', 'fixture/0123456789ab', false],
    ['a backslash', 'fixture\\0123456789ab', false],
    ['an uppercase hash', 'fixture-0123456789AB', false],
    ['a short hash', 'fixture-0123456789a', false],
    ['a long hash', 'fixture-0123456789abc', false],
    ['a non-hex hash', 'fixture-0123456789ag', false],
    ['an impossible date', '20261332-0123456789ab', false],
    ['a seven-digit date', '2026102-0123456789ab', false],
  ])('validate %s', (_label, value, expected) => {
    expect(isBuildId(value)).toBe(expected);
  });

  it('rejects an unsafe build ID with the allowed forms in the error', () => {
    expect(() => assertBuildId('.')).toThrow(/"fixture-<12 lowercase hex>"/);
  });

  it('accepts a valid build ID', () => {
    expect(assertBuildId('fixture-0123456789ab')).toBe('fixture-0123456789ab');
  });

  it('use the compact planet date for production builds', () => {
    const buildId = computeBuildId({
      mode: 'planet',
      planetDate: BASE.planetDate,
      archiveSha256: ARCHIVE_SHA,
    });

    expect(buildId).toBe('20261029-aaaaaaaaaaaa');
  });

  it('change when the archive SHA changes', () => {
    const original = computeBuildId({
      mode: 'fixture',
      planetDate: BASE.planetDate,
      archiveSha256: ARCHIVE_SHA,
    });
    const changed = computeBuildId({
      mode: 'fixture',
      planetDate: BASE.planetDate,
      archiveSha256: 'b'.repeat(64),
    });

    expect(changed).not.toBe(original);
    expect(changed).toBe('fixture-bbbbbbbbbbbb');
  });

  it('require a real planet date for planet builds', () => {
    expect(() =>
      computeBuildId({ mode: 'planet', planetDate: '', archiveSha256: ARCHIVE_SHA }),
    ).toThrow(/YYYY-MM-DD/);
  });

  it('reject unknown modes and invalid archive hashes', () => {
    expect(() =>
      computeBuildId({ mode: 'alps', planetDate: BASE.planetDate, archiveSha256: ARCHIVE_SHA }),
    ).toThrow(BuildError);
    expect(() =>
      computeBuildId({ mode: 'fixture', planetDate: BASE.planetDate, archiveSha256: 'abc' }),
    ).toThrow(BuildError);
  });
});

describe('run IDs', () => {
  it('are stable for identical inputs', () => {
    expect(computeRunId({ mode: 'fixture', ...BASE })).toBe(
      computeRunId({ mode: 'fixture', ...BASE }),
    );
  });

  it.each([
    ['source name', { source: 'routes' }],
    ['planet date', { planetDate: '2026-10-28' }],
    ['planet SHA', { planetSha256: '9'.repeat(64) }],
    ['minzoom', { minzoom: 1 }],
    ['maxzoom', { maxzoom: 15 }],
    ['filter applied', { filterApplied: false }],
    ['filter skipped', { filterSkipped: true }],
    ['profile hash', { profileHash: '9'.repeat(64) }],
    ['filter hash', { filterHash: '9'.repeat(64) }],
    ['skip flags', { skips: { ...BASE.skips, verify: true } }],
    ['Planetiler version', { tools: { ...BASE.tools, planetiler: { version: '0.10.3' } } }],
    ['pmtiles version', { tools: { ...BASE.tools, pmtiles: { version: '1.31.3' } } }],
  ])('change when the %s changes', (_label, override) => {
    const original = computeRunId({ mode: 'fixture', ...BASE });
    const changed = computeRunId({ mode: 'fixture', ...BASE, ...override });

    expect(changed).not.toBe(original);
  });

  it('separate fixture and planet runs', () => {
    expect(computeRunId({ mode: 'fixture', ...BASE })).not.toBe(
      computeRunId({ mode: 'planet', ...BASE }),
    );
  });

  it('reject unknown modes', () => {
    expect(() => computeRunId({ mode: 'alps', ...BASE })).toThrow(BuildError);
  });
});

describe('calendar dates', () => {
  it.each([
    ['0000-01-01', true],
    ['0000-02-29', true],
    ['0099-01-01', true],
    ['0099-12-31', true],
    ['0099-02-29', false],
    ['0100-02-29', false],
    ['0000-00-01', false],
  ])('handles the ISO year in %s', (value, expected) => {
    expect(isRealCalendarDate(value)).toBe(expected);
  });
});

describe('helpers', () => {
  it('compactDate removes dashes', () => {
    expect(compactDate('2026-10-29')).toBe('20261029');
    expect(() => compactDate('29/10/2026')).toThrow(/YYYY-MM-DD/);
  });

  it.each(['2026-02-31', '2026-13-01', '2026-00-10', 'not-a-date', '', 20261029])(
    'rejects the invalid date %s',
    (date) => {
      expect(() => compactDate(date)).toThrow(/YYYY-MM-DD/);
    },
  );

  it('shortHash supports custom lengths', () => {
    expect(shortHash({ a: 1 }, 8)).toHaveLength(8);
  });

  it('buildIdPayload records source, zooms, filters, skips, planet and tools', () => {
    expect(buildIdPayload({ mode: 'fixture', ...BASE })).toEqual({
      mode: 'fixture',
      source: BASE.source,
      planetDate: BASE.planetDate,
      planetSha256: BASE.planetSha256,
      minzoom: BASE.minzoom,
      maxzoom: BASE.maxzoom,
      filterApplied: true,
      filterSkipped: false,
      profileHash: BASE.profileHash,
      filterHash: BASE.filterHash,
      skips: BASE.skips,
      tools: BASE.tools,
    });
  });
});
