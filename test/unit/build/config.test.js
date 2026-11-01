import { describe, expect, it } from 'vitest';

import {
  loadBuildConfig,
  resolveSizeFloor,
  validateBuildConfig,
} from '../../../src/build/config.mjs';
import { sourceExpressionUnion } from '../../../src/build/expressions.mjs';
import { BuildConfigError } from '../../../src/build/errors.mjs';
import { validateConfig } from '../../../src/lib/config.mjs';

const SHA = 'a'.repeat(64);

function makeBuildConfig() {
  return {
    version: 1,
    server: { host: '127.0.0.1', port: 11010 },
    build: {
      planet: {
        date: '',
        url: 'https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf',
        sha256: '',
        md5: '',
      },
      tools: {
        planetiler: {
          version: '0.10.2',
          url: 'https://example.com/planetiler.jar',
          sha256: SHA,
        },
        pmtiles: '1.31.2',
      },
      outputDir: 'dist',
    },
    sources: {
      pois: {
        kind: 'pmtiles',
        title: 'Outdoor POIs',
        description: 'Points of interest.',
        attribution: [{ title: 'OpenStreetMap', href: 'https://www.openstreetmap.org/copyright' }],
        archiveDir: 'data/pois',
        minzoom: 12,
        maxzoom: 16,
        build: {
          profile: 'pois',
          minzoom: 0,
          maxzoom: 16,
          expressions: ['nwr/tourism=viewpoint', 'nwr/amenity=shelter'],
          sampleTiles: [{ z: 13, x: 1471, y: 2739 }],
          verification: {
            layer: 'outdoor_pois',
            requiredAttributes: ['kind', 'name'],
          },
          sizeFloor: { fixture: 4096, planet: 104857600 },
        },
      },
    },
  };
}

describe('validateBuildConfig', () => {
  it('normalises the build section and source profiles', () => {
    const config = validateBuildConfig(makeBuildConfig());

    expect(config.build.outputDir).toBe('dist');
    expect(config.build.tools.planetiler.version).toBe('0.10.2');
    expect(config.sources.pois).toEqual({
      archiveDir: 'data/pois',
      profile: 'pois',
      minzoom: 0,
      maxzoom: 16,
      expressions: ['nwr/tourism=viewpoint', 'nwr/amenity=shelter'],
      sampleTiles: [{ z: 13, x: 1471, y: 2739 }],
      verification: {
        layer: 'outdoor_pois',
        requiredAttributes: ['kind', 'name'],
      },
      sizeFloor: { fixture: 4096, planet: 104857600 },
    });
  });

  it('requires a build section', () => {
    const raw = makeBuildConfig();
    delete raw.build;

    expect(() => validateBuildConfig(raw)).toThrow(/build must be an object/i);
  });

  it('accepts a planet MD5 and defaults it to empty when missing', () => {
    const raw = makeBuildConfig();
    raw.build.planet.md5 = 'b'.repeat(32);

    expect(validateBuildConfig(raw).build.planet.md5).toBe('b'.repeat(32));

    delete raw.build.planet.md5;
    expect(validateBuildConfig(raw).build.planet.md5).toBe('');
  });

  it.each([
    ['an unknown build key', (raw) => (raw.build.extra = true)],
    ['an invalid planet URL', (raw) => (raw.build.planet.url = 'ftp://example.com/planet')],
    ['an invalid planet SHA', (raw) => (raw.build.planet.sha256 = 'abc')],
    ['an invalid planet MD5', (raw) => (raw.build.planet.md5 = 'abc')],
    ['an invalid planet date', (raw) => (raw.build.planet.date = '30-10-2026')],
    ['an impossible planet date', (raw) => (raw.build.planet.date = '2026-02-31')],
    ['an uppercase planet SHA', (raw) => (raw.build.planet.sha256 = 'A'.repeat(64))],
    ['an uppercase planet MD5', (raw) => (raw.build.planet.md5 = 'A'.repeat(32))],
    ['a non-hex planet MD5', (raw) => (raw.build.planet.md5 = 'g'.repeat(32))],
    ['an unknown tool', (raw) => (raw.build.tools.osmium = '1.0.0')],
    ['an invalid Planetiler SHA', (raw) => (raw.build.tools.planetiler.sha256 = 'abc')],
    ['a Planetiler URL without a SHA', (raw) => (raw.build.tools.planetiler.sha256 = '')],
    ['an unsafe Planetiler version', (raw) => (raw.build.tools.planetiler.version = '../jar')],
    ['an absolute output directory', (raw) => (raw.build.outputDir = '/tmp/dist')],
    ['a traversing output directory', (raw) => (raw.build.outputDir = '../dist')],
    ['an empty output directory', (raw) => (raw.build.outputDir = '')],
    ['the repository root as output directory', (raw) => (raw.build.outputDir = '.')],
  ])('rejects %s', (_label, mutate) => {
    const raw = makeBuildConfig();
    mutate(raw);

    expect(() => validateBuildConfig(raw)).toThrow(BuildConfigError);
  });

  it.each([
    ['an unknown source build key', (build) => (build.extra = true)],
    ['an invalid profile', (build) => (build.profile = 'Po Is')],
    ['minzoom above maxzoom', (build) => Object.assign(build, { minzoom: 17, maxzoom: 16 })],
    ['a maxzoom above 26', (build) => (build.maxzoom = 27)],
    ['an empty expression list', (build) => (build.expressions = [])],
    ['an expression without a selector', (build) => (build.expressions = ['tourism=viewpoint'])],
    ['an expression with a trailing newline', (build) => (build.expressions = ['nwr/a=b\n'])],
    ['an expression with CRLF', (build) => (build.expressions = ['nwr/a=b\r\n'])],
    ['a duplicate expression', (build) => (build.expressions = ['nwr/a=b', 'nwr/a=b'])],
    ['an empty sample list', (build) => (build.sampleTiles = [])],
    ['an out-of-range sample tile', (build) => (build.sampleTiles = [{ z: 2, x: 4, y: 0 }])],
    ['a non-positive size floor', (build) => (build.sizeFloor = 0)],
    ['an invalid floor mode', (build) => (build.sizeFloor = { Fixture: 1 })],
    ['a floor missing a known mode', (build) => (build.sizeFloor = { fixture: 1 })],
    ['a missing verification block', (build) => delete build.verification],
    [
      'a verification without a layer',
      (build) => (build.verification = { requiredAttributes: ['kind'] }),
    ],
    [
      'a verification without attributes',
      (build) => (build.verification = { layer: 'outdoor_pois' }),
    ],
    ['an invalid layers list', (build) => (build.verification = { layers: [] })],
    ['an unknown profile kind', (build) => (build.profileKind = 'kotlin')],
    ['an absolute profile file', (build) => (build.profileFile = '/srv/routes.java')],
    ['a traversing profile file', (build) => (build.profileFile = '../routes.java')],
    ['a non-profile file', (build) => (build.profileFile = 'build/profiles/routes.txt')],
    ['an invalid heap size', (build) => (build.heap = 'lots')],
    ['an invalid planet heap size', (build) => (build.heapPlanet = 'lots')],
    ['an unknown verification geometry', (build) => (build.verification.geometry = 'circle')],
  ])('rejects %s', (_label, mutate) => {
    const raw = makeBuildConfig();
    mutate(raw.sources.pois.build);

    expect(() => validateBuildConfig(raw)).toThrow(BuildConfigError);
  });

  it.each([
    ['an absolute archive directory', (source) => (source.archiveDir = '/srv/data/pois')],
    ['a traversing archive directory', (source) => (source.archiveDir = '../data/pois')],
    ['an empty archive directory', (source) => (source.archiveDir = '')],
    ['the repository root', (source) => (source.archiveDir = '.')],
  ])('rejects %s', (_label, mutate) => {
    const raw = makeBuildConfig();
    mutate(raw.sources.pois);

    expect(() => validateBuildConfig(raw)).toThrow(BuildConfigError);
  });

  it('accepts a layers verification list', () => {
    const raw = makeBuildConfig();
    raw.sources.pois.build.verification = {
      layers: [
        { layer: 'outdoor_pois', requiredAttributes: ['kind', 'name'] },
        { layer: 'labels', requiredAttributes: ['text'] },
      ],
    };

    expect(validateBuildConfig(raw).sources.pois.verification).toEqual({
      layers: [
        { layer: 'outdoor_pois', requiredAttributes: ['kind', 'name'] },
        { layer: 'labels', requiredAttributes: ['text'] },
      ],
    });
  });

  it('rejects a build block on a contour source', () => {
    const raw = makeBuildConfig();
    raw.sources.contours = {
      kind: 'contour',
      title: 'Contours',
      description: 'Contours.',
      attribution: [{ title: 'Mapterhorn', href: 'https://mapterhorn.com/attribution' }],
      minzoom: 1,
      maxzoom: 15,
      demUrl: 'https://example.com/{z}/{x}/{y}.webp',
      encoding: 'terrarium',
      thresholds: { 12: [20, 100] },
      build: { profile: 'pois' },
    };

    expect(() => validateBuildConfig(raw)).toThrow(/only supported on pmtiles/i);
  });

  it('rejects a configuration with no build profiles', () => {
    const raw = makeBuildConfig();
    delete raw.sources.pois.build;

    expect(() => validateBuildConfig(raw)).toThrow(/declares a build profile/i);
  });

  it('rejects two sources that resolve to the same archive directory', () => {
    const raw = makeBuildConfig();
    raw.sources.routes = {
      ...raw.sources.pois,
      archiveDir: 'data/./pois',
      title: 'Outdoor routes',
      description: 'Routes.',
    };

    expect(() => validateBuildConfig(raw)).toThrow(/same directory/i);
  });

  it('accepts a single size floor for every mode', () => {
    const raw = makeBuildConfig();
    raw.sources.pois.build.sizeFloor = 1024;

    expect(validateBuildConfig(raw).sources.pois.sizeFloor).toEqual({ default: 1024 });
  });

  it('normalises a Java source-file profile with geometry verification', () => {
    const raw = makeBuildConfig();
    raw.sources.routes = {
      ...raw.sources.pois,
      archiveDir: 'data/routes',
      title: 'Outdoor routes',
      description: 'Routes.',
      minzoom: 8,
      maxzoom: 14,
      build: {
        profile: 'routes',
        profileKind: 'java',
        profileFile: 'build/profiles/routes.java',
        heap: '2g',
        heapPlanet: '8g',
        minzoom: 8,
        maxzoom: 14,
        expressions: ['r/route=*hiking*'],
        sampleTiles: [{ z: 13, x: 1465, y: 2735 }],
        verification: {
          layer: 'outdoor_routes',
          geometry: 'line',
          requiredAttributes: ['activity', 'activities'],
        },
        sizeFloor: { fixture: 65536, planet: 104857600 },
      },
    };

    expect(validateBuildConfig(raw).sources.routes).toMatchObject({
      archiveDir: 'data/routes',
      profile: 'routes',
      profileKind: 'java',
      profileFile: 'build/profiles/routes.java',
      heap: '2g',
      heapPlanet: '8g',
      verification: {
        layer: 'outdoor_routes',
        geometry: 'line',
        requiredAttributes: ['activity', 'activities'],
      },
    });
  });
});

describe('resolveSizeFloor', () => {
  it('prefers the mode floor and falls back to the default', () => {
    expect(resolveSizeFloor({ fixture: 1, planet: 2 }, 'fixture')).toBe(1);
    expect(resolveSizeFloor({ default: 3 }, 'planet')).toBe(3);
    expect(resolveSizeFloor(4, 'fixture')).toBe(4);
  });

  it('rejects a missing floor', () => {
    expect(() => resolveSizeFloor({ fixture: 1 }, 'planet')).toThrow(/size floor/i);
  });
});

describe('loadBuildConfig', () => {
  it('loads the shipped manifest', () => {
    const config = loadBuildConfig('config/layers.json');

    expect(config.sources.pois.profile).toBe('pois');
    expect(config.sources.pois.expressions).toHaveLength(18);
    expect(config.sources.pois.verification).toEqual({
      layer: 'outdoor_pois',
      requiredAttributes: ['kind', 'name'],
    });
    expect(config.build.planet).toEqual({
      date: '2026-10-26',
      url: 'https://planet.openstreetmap.org/pbf/planet-261026.osm.pbf',
      sha256: '63dfb50285e0b20e369963c49ce324ae38d5f0152337a7f7ad7ea66b914f8344',
      md5: '77397f0ffeb2dae22e56fda30b1f36aa',
    });
    expect(config.build.tools.planetiler.version).toBe('0.10.2');
  });

  it('loads the Java route and path profiles', () => {
    const config = loadBuildConfig('config/layers.json');

    expect(config.sources.routes).toMatchObject({
      profile: 'routes',
      profileKind: 'java',
      profileFile: 'build/profiles/routes.java',
      heap: '2g',
      heapPlanet: '8g',
      minzoom: 8,
      maxzoom: 14,
    });
    expect(config.sources.paths).toMatchObject({
      profile: 'paths',
      profileKind: 'java',
      profileFile: 'build/profiles/paths.java',
      heap: '2g',
      heapPlanet: '8g',
      minzoom: 9,
      maxzoom: 13,
    });
  });

  it('builds one osmium filter union across every source', () => {
    const config = loadBuildConfig('config/layers.json');
    const expressions = sourceExpressionUnion(config.sources);

    expect(expressions).toHaveLength(25);
    expect(expressions).toEqual(
      expect.arrayContaining([
        'nwr/tourism=alpine_hut,wilderness_hut',
        'r/route=*hiking*',
        'r/route=*bicycle*',
        'r/route=*foot*',
        'r/route=*walking*',
        'w/highway=path',
        'w/highway=footway',
        'w/highway=track',
      ]),
    );
    expect(new Set(expressions).size).toBe(expressions.length);
  });
});

describe('server configuration', () => {
  it('accepts and ignores build-only fields', () => {
    const raw = makeBuildConfig();
    raw.sources.pois.title = 'Outdoor POIs';
    raw.sources.pois.description = 'Points of interest.';

    const config = validateConfig(raw, { repoRoot: '/srv/tiles' });

    expect(config.build).toBeUndefined();
    expect(config.sources.pois.build).toBeUndefined();
    expect(config.sources.pois.kind).toBe('pmtiles');
  });
});
