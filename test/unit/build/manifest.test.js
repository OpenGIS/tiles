import { describe, expect, it } from 'vitest';

import { BuildError } from '../../../src/build/errors.mjs';
import {
  assertSampleTile,
  assertSizeFloor,
  assertVerification,
  createBuildManifest,
  validateBuildManifest,
} from '../../../src/build/manifest.mjs';

const SHA = 'a'.repeat(64);

function makeInput() {
  return {
    buildId: 'fixture-aaaaaaaaaaaa',
    runId: 'abcdef012345',
    source: 'pois',
    mode: 'fixture',
    minzoom: 0,
    maxzoom: 16,
    planet: {
      date: '2026-10-29',
      url: 'https://example.com/bc.osm.pbf',
      sha256: SHA,
    },
    fixture: {
      path: 'test/fixtures/alberta-canmore.osm.pbf',
      sha256: SHA,
      manifest: 'test/fixtures/alberta-canmore.manifest.json',
      sourceUrl: 'https://example.com/alberta.osm.pbf',
      extractDate: '2026-10-29',
      bbox: [-115.65, 50.95, -115.05, 51.35],
    },
    tools: {
      planetiler: {
        version: '0.10.2',
        url: 'https://example.com/planetiler.jar',
        sha256: SHA,
        path: 'tmp/tools/planetiler-0.10.2.jar',
      },
      pmtiles: {
        version: 'dev, commit none, built at unknown',
        sha256: SHA,
        pinned: '1.31.2',
      },
      java: { version: '26.0.2', path: '/usr/bin/java', sha256: SHA },
      osmium: { version: '1.19.1', path: '/usr/local/bin/osmium', sha256: SHA },
    },
    profile: { path: 'build/profiles/pois.yml', sha256: SHA },
    filter: { sha256: SHA, expressions: 18, applied: true, skipped: false },
    skips: { download: false, filter: false, build: false, verify: false },
    verification: {
      ok: true,
      skipped: false,
      layers: [{ layer: 'outdoor_pois', requiredAttributes: ['kind', 'name'] }],
    },
    archive: {
      path: 'current.pmtiles',
      sha256: SHA,
      bytes: 102400,
      tiles: 42,
      compression: 'gzip',
      metadata: { available: true, osmReplicationTime: '2026-10-29T20:21:00Z' },
    },
    samples: [
      {
        z: 13,
        x: 1471,
        y: 2739,
        layer: 'outdoor_pois',
        layers: [{ layer: 'outdoor_pois', features: 10 }],
        features: 10,
        attributes: ['ele', 'kind', 'name'],
      },
    ],
    sizeFloor: 4096,
    createdAt: '2026-10-30T12:00:00.000Z',
  };
}

function makePlanetInput() {
  const input = makeInput();
  input.mode = 'planet';
  input.buildId = `20261029-${SHA.slice(0, 12)}`;

  return input;
}

describe('createBuildManifest', () => {
  it('records the source, zooms, tools, hashes, flags, archive stats and samples', () => {
    const manifest = createBuildManifest(makeInput());

    expect(manifest).toMatchObject({
      buildId: 'fixture-aaaaaaaaaaaa',
      runId: 'abcdef012345',
      source: 'pois',
      mode: 'fixture',
      minzoom: 0,
      maxzoom: 16,
      planet: { date: '2026-10-29', sha256: SHA },
      tools: {
        planetiler: { version: '0.10.2', sha256: SHA },
        pmtiles: {
          version: 'dev, commit none, built at unknown',
          sha256: SHA,
          pinned: '1.31.2',
        },
        java: { version: '26.0.2', path: '/usr/bin/java', sha256: SHA },
        osmium: { version: '1.19.1', path: '/usr/local/bin/osmium', sha256: SHA },
      },
      profile: { path: 'build/profiles/pois.yml', sha256: SHA },
      filter: { sha256: SHA, expressions: 18, applied: true, skipped: false },
      skips: { download: false, filter: false, build: false, verify: false },
      verification: {
        ok: true,
        skipped: false,
        layers: [{ layer: 'outdoor_pois', requiredAttributes: ['kind', 'name'] }],
      },
      archive: {
        path: 'current.pmtiles',
        sha256: SHA,
        bytes: 102400,
        tiles: 42,
        compression: 'gzip',
      },
      sizeFloor: 4096,
      createdAt: '2026-10-30T12:00:00.000Z',
    });
    expect(manifest.samples).toHaveLength(1);
    expect(manifest.fixture).toMatchObject({ extractDate: '2026-10-29' });
  });

  it('records the actual PMTiles CLI version and binary hash, not the pin', () => {
    const manifest = createBuildManifest(makeInput());

    expect(manifest.tools.pmtiles.version).toBe('dev, commit none, built at unknown');
    expect(manifest.tools.pmtiles.sha256).toBe(SHA);
    expect(manifest.tools.pmtiles.pinned).toBe('1.31.2');
  });

  it('records archive metadata including the OSM replication timestamp', () => {
    const manifest = createBuildManifest(makeInput());

    expect(manifest.archive.metadata).toEqual({
      available: true,
      osmReplicationTime: '2026-10-29T20:21:00Z',
    });
  });

  it('serialises without losing required fields', () => {
    const manifest = createBuildManifest(makeInput());
    const roundTripped = JSON.parse(JSON.stringify(manifest));

    expect(() => validateBuildManifest(roundTripped)).not.toThrow();
  });

  it('rejects a malformed fixture bbox instead of coercing it to an empty array', () => {
    const input = makeInput();
    input.fixture = { ...input.fixture, bbox: 'not-an-array' };

    expect(() => createBuildManifest(input)).toThrow(/four-number array/);
  });

  it('allows an unverified manifest with no samples when verification is skipped', () => {
    const input = makeInput();
    input.verification = {
      ok: false,
      skipped: true,
      layers: [{ layer: 'outdoor_pois', requiredAttributes: ['kind', 'name'] }],
    };
    input.samples = [];
    input.skips = { ...input.skips, verify: true };
    input.filter = { ...input.filter, applied: false, skipped: true };

    const manifest = createBuildManifest(input);

    expect(manifest.verification).toMatchObject({ ok: false, skipped: true });
    expect(manifest.samples).toEqual([]);
  });
});

describe('validateBuildManifest', () => {
  it.each([
    ['a missing build ID', (manifest) => delete manifest.buildId],
    ['an invalid build ID', (manifest) => (manifest.buildId = 'bad id')],
    ['an unknown mode', (manifest) => (manifest.mode = 'alps')],
    ['inverted zooms', (manifest) => (manifest.minzoom = 17)],
    ['a missing planet', (manifest) => delete manifest.planet],
    ['an impossible planet date', (manifest) => (manifest.planet.date = '2026-02-31')],
    ['a non-string planet date', (manifest) => (manifest.planet.date = 20261029)],
    [
      'a blank planet date for a planet build',
      (manifest) => {
        manifest.mode = 'planet';
        manifest.planet.date = '';
      },
    ],
    ['an impossible fixture date', (manifest) => (manifest.fixture.extractDate = '2026-02-31')],
    ['a non-string fixture date', (manifest) => (manifest.fixture.extractDate = 20261029)],
    ['an impossible fixture bbox', (manifest) => (manifest.fixture.bbox = [999, 999, -999, -999])],
    ['a malformed fixture bbox', (manifest) => (manifest.fixture.bbox = [1, 2, 3])],
    ['a non-numeric fixture bbox', (manifest) => (manifest.fixture.bbox = [1, 2, 3, 'x'])],
    ['a missing Planetiler version', (manifest) => delete manifest.tools.planetiler.version],
    ['a missing PMTiles version', (manifest) => delete manifest.tools.pmtiles.version],
    ['an invalid PMTiles SHA', (manifest) => (manifest.tools.pmtiles.sha256 = 'abc')],
    ['a missing PMTiles pin', (manifest) => delete manifest.tools.pmtiles.pinned],
    ['an invalid Java record', (manifest) => (manifest.tools.java.sha256 = 'abc')],
    ['an invalid profile hash', (manifest) => (manifest.profile.sha256 = 'abc')],
    ['an invalid archive hash', (manifest) => (manifest.archive.sha256 = 'abc')],
    ['zero archive bytes', (manifest) => (manifest.archive.bytes = 0)],
    ['a negative tile count', (manifest) => (manifest.archive.tiles = -1)],
    ['a missing sample layer', (manifest) => delete manifest.samples[0].layer],
    ['a sample without features', (manifest) => (manifest.samples[0].features = 0)],
    ['a missing required attribute', (manifest) => (manifest.samples[0].attributes = ['name'])],
    ['a zero size floor', (manifest) => (manifest.sizeFloor = 0)],
    ['a non-boolean verification state', (manifest) => (manifest.verification.skipped = 'no')],
    ['an invalid creation time', (manifest) => (manifest.createdAt = 'not a date')],
  ])('rejects %s', (_label, mutate) => {
    const manifest = createBuildManifest(makeInput());
    mutate(manifest);

    expect(() => validateBuildManifest(manifest)).toThrow(BuildError);
  });

  it('rejects an unverified manifest that still claims verification', () => {
    const manifest = createBuildManifest(makeInput());
    manifest.verification.ok = true;
    manifest.verification.skipped = true;

    expect(() => validateBuildManifest(manifest)).toThrow(BuildError);
  });

  it('accepts a content-addressed fixture manifest', () => {
    const manifest = createBuildManifest(makeInput());

    expect(() => validateBuildManifest(manifest)).not.toThrow();
  });

  it('rejects a fixture build ID whose suffix does not match archive.sha256', () => {
    const manifest = createBuildManifest(makeInput());
    manifest.buildId = 'fixture-bbbbbbbbbbbb';

    expect(() => validateBuildManifest(manifest)).toThrow(
      /buildId hash suffix "bbbbbbbbbbbb" must match the first 12 characters of archive.sha256 \("aaaaaaaaaaaa"\)/,
    );
  });

  it.each([
    ['a wrong date', '20261332-aaaaaaaaaaaa', /buildId must be/],
    ['a wrong suffix', '20261029-bbbbbbbbbbbb', /buildId hash suffix/],
    ['a fixture prefix', 'fixture-aaaaaaaaaaaa', /must use "<YYYYMMDD>-<12 lowercase hex>"/],
  ])('rejects a planet build ID with %s', (_label, buildId, message) => {
    const manifest = createBuildManifest(makePlanetInput());
    manifest.buildId = buildId;

    expect(() => validateBuildManifest(manifest)).toThrow(message);
  });

  it('rejects a fixture build ID with a planet-style date prefix', () => {
    const manifest = createBuildManifest(makeInput());
    manifest.buildId = '20261029-aaaaaaaaaaaa';

    expect(() => validateBuildManifest(manifest)).toThrow(/must start with "fixture-"/);
  });

  it('rejects a planet manifest whose build ID date does not match planet.date', () => {
    const manifest = createBuildManifest(makePlanetInput());
    manifest.buildId = '20261028-aaaaaaaaaaaa';

    expect(() => validateBuildManifest(manifest)).toThrow(
      /buildId date prefix "20261028" must match planet.date "2026-10-29"/,
    );
  });
});

describe('size floor', () => {
  it('accepts an archive at or above the floor', () => {
    expect(assertSizeFloor({ bytes: 4096, floor: 4096 })).toBe(4096);
  });

  it('rejects an archive below the floor', () => {
    expect(() =>
      assertSizeFloor({ bytes: 4095, floor: 4096, label: 'pois/current.pmtiles' }),
    ).toThrow(/below the size floor/i);
  });
});

describe('sample tile assertions', () => {
  it('requires features, a layer and the configured attributes', () => {
    expect(
      assertSampleTile(
        {
          z: 13,
          x: 1471,
          y: 2739,
          layer: 'outdoor_pois',
          features: 2,
          attributes: ['kind', 'name'],
        },
        { requiredAttributes: ['kind', 'name'] },
      ),
    ).toEqual({ layer: 'outdoor_pois', features: 2 });
  });

  it.each([
    ['no features', { features: 0, layer: 'outdoor_pois', attributes: ['kind', 'name'] }],
    ['no layer', { features: 1, attributes: ['kind', 'name'] }],
    ['no kind attribute', { features: 1, layer: 'outdoor_pois', attributes: ['name'] }],
    ['no name attribute', { features: 1, layer: 'outdoor_pois', attributes: ['kind'] }],
  ])('rejects a sample with %s', (_label, sample) => {
    expect(() => assertSampleTile(sample, { requiredAttributes: ['kind', 'name'] })).toThrow(
      BuildError,
    );
  });
});

describe('verification assertions', () => {
  it('accepts a verified archive with passing samples', () => {
    expect(
      assertVerification({
        verification: { ok: true, skipped: false },
        samples: [{ features: 1, layer: 'outdoor_pois', attributes: ['kind', 'name'] }],
        floor: 1,
        bytes: 1,
        tiles: 1,
        requiredAttributes: ['kind', 'name'],
      }),
    ).toBe(true);
  });

  it('rejects an archive that failed verification', () => {
    expect(() =>
      assertVerification({
        verification: { ok: false, skipped: true },
        samples: [],
        floor: 1,
        bytes: 1,
      }),
    ).toThrow(/failed PMTiles verification/i);
  });

  it('rejects verification without samples', () => {
    expect(() =>
      assertVerification({
        verification: { ok: true, skipped: false },
        samples: [],
        floor: 1,
        bytes: 1,
        tiles: 1,
      }),
    ).toThrow(/sample tile/i);
  });

  it('rejects verification without any addressed tiles', () => {
    expect(() =>
      assertVerification({
        verification: { ok: true, skipped: false },
        samples: [{ features: 1, layer: 'outdoor_pois', attributes: [] }],
        floor: 1,
        bytes: 1,
        tiles: 0,
      }),
    ).toThrow(/no addressed tiles/i);
  });
});
