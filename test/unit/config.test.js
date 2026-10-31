import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ConfigError,
  loadConfig,
  resolveArchiveDir,
  validateConfig,
} from '../../src/lib/config.mjs';
import { createTempDirectory, removeTempDirectory } from '../helpers/temp.mjs';

const createdDirectories = [];

function makeConfig() {
  return {
    version: 1,
    server: { host: '127.0.0.1', port: 11010 },
    sources: {
      pois: {
        kind: 'pmtiles',
        title: 'Outdoor POIs',
        description: 'Points of interest.',
        attribution: [{ title: 'OpenStreetMap', href: 'https://www.openstreetmap.org/copyright' }],
        archiveDir: 'data/pois',
        minzoom: 12,
        maxzoom: 16,
      },
    },
  };
}

async function makeDirectory() {
  const directory = await createTempDirectory('tiles-config-');
  createdDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    createdDirectories.splice(0).map((directory) => removeTempDirectory(directory)),
  );
});

describe('validateConfig', () => {
  it('returns a normalised config with an absolute archive directory', () => {
    const config = validateConfig(makeConfig(), { repoRoot: '/srv/tiles' });

    expect(config).toEqual({
      version: 1,
      server: {
        host: '127.0.0.1',
        port: 11010,
        publicBaseUrl: null,
        trustProxy: false,
      },
      sources: {
        pois: {
          kind: 'pmtiles',
          title: 'Outdoor POIs',
          description: 'Points of interest.',
          attribution: [
            { title: 'OpenStreetMap', href: 'https://www.openstreetmap.org/copyright' },
          ],
          archiveDir: path.resolve('/srv/tiles', 'data/pois'),
          minzoom: 12,
          maxzoom: 16,
        },
      },
    });
  });

  it('requires an explicit repository root', () => {
    expect(() => validateConfig(makeConfig())).toThrow(ConfigError);
    expect(() => validateConfig(makeConfig())).toThrow(/repoRoot/);
  });

  it('normalises a public base URL and accepts trustProxy', () => {
    const raw = makeConfig();
    raw.server.publicBaseUrl = 'https://tiles.example/base/';
    raw.server.trustProxy = true;

    const config = validateConfig(raw, { repoRoot: '/srv/tiles' });

    expect(config.server.publicBaseUrl).toBe('https://tiles.example/base');
    expect(config.server.trustProxy).toBe(true);
  });

  it.each([
    ['a non-http protocol', 'ftp://tiles.example'],
    ['a relative URL', '/tiles'],
    ['a query string', 'https://tiles.example/base?token=1'],
    ['a fragment', 'https://tiles.example/base#top'],
  ])('rejects a public base URL with %s', (_label, publicBaseUrl) => {
    const raw = makeConfig();
    raw.server.publicBaseUrl = publicBaseUrl;

    expect(() => validateConfig(raw, { repoRoot: '/srv/tiles' })).toThrow(ConfigError);
  });

  it('rejects a non-boolean trustProxy value', () => {
    const raw = makeConfig();
    raw.server.trustProxy = 'yes';

    expect(() => validateConfig(raw, { repoRoot: '/srv/tiles' })).toThrow(/trustProxy/);
  });

  it('keeps an absolute archive directory unchanged', () => {
    const raw = makeConfig();
    raw.sources.pois.archiveDir = '/srv/tiles/data/pois';

    const config = validateConfig(raw, { repoRoot: '/srv/tiles' });

    expect(config.sources.pois.archiveDir).toBe('/srv/tiles/data/pois');
  });

  it('rejects a relative archive directory that escapes the repository root', () => {
    const raw = makeConfig();
    raw.sources.pois.archiveDir = '../outside';

    expect(() => validateConfig(raw, { repoRoot: '/srv/tiles' })).toThrow(/must not contain/i);
  });

  it('rejects a relative archive directory with an interior traversal', () => {
    const raw = makeConfig();
    raw.sources.pois.archiveDir = 'data/../../outside';

    expect(() => validateConfig(raw, { repoRoot: '/srv/tiles' })).toThrow(/must not contain/i);
  });

  it('rejects an unknown source kind', () => {
    const raw = makeConfig();
    raw.sources.pois.kind = 'mbtiles';

    expect(() => validateConfig(raw, { repoRoot: '/srv/tiles' })).toThrow(/unknown kind/i);
  });

  it('rejects an invalid source name', () => {
    const raw = makeConfig();
    raw.sources.Bad_Name = raw.sources.pois;

    expect(() => validateConfig(raw, { repoRoot: '/srv/tiles' })).toThrow(/invalid/i);
  });

  it.each([
    ['minzoom above maxzoom', { minzoom: 17, maxzoom: 16 }],
    ['maxzoom out of range', { maxzoom: 27 }],
    ['minzoom out of range', { minzoom: -1 }],
    ['fractional zoom', { minzoom: 10.5 }],
  ])('rejects bad zoom values: %s', (_label, overrides) => {
    const raw = makeConfig();
    Object.assign(raw.sources.pois, overrides);

    expect(() => validateConfig(raw, { repoRoot: '/srv/tiles' })).toThrow(ConfigError);
  });

  it.each(['kind', 'title', 'description', 'attribution', 'archiveDir', 'minzoom', 'maxzoom'])(
    'rejects a source missing %s',
    (field) => {
      const raw = makeConfig();
      delete raw.sources.pois[field];

      expect(() => validateConfig(raw, { repoRoot: '/srv/tiles' })).toThrow(ConfigError);
    },
  );

  it.each(['host', 'port'])('rejects a server missing %s', (field) => {
    const raw = makeConfig();
    delete raw.server[field];

    expect(() => validateConfig(raw, { repoRoot: '/srv/tiles' })).toThrow(ConfigError);
  });

  it('rejects a config with no sources', () => {
    const raw = makeConfig();
    raw.sources = {};

    expect(() => validateConfig(raw, { repoRoot: '/srv/tiles' })).toThrow(/non-empty/i);
  });

  it('rejects an unsupported config version', () => {
    const raw = makeConfig();
    raw.version = 2;

    expect(() => validateConfig(raw, { repoRoot: '/srv/tiles' })).toThrow(/version/i);
  });

  it('rejects unknown top-level keys', () => {
    const raw = makeConfig();
    raw.extra = true;

    expect(() => validateConfig(raw, { repoRoot: '/srv/tiles' })).toThrow(/unknown key/i);
  });

  it('rejects unknown server keys', () => {
    const raw = makeConfig();
    raw.server.proxy = true;

    expect(() => validateConfig(raw, { repoRoot: '/srv/tiles' })).toThrow(/unknown key "proxy"/i);
  });

  it.each(['maxZoom', 'archive_dir'])('rejects an unknown source key: %s', (key) => {
    const raw = makeConfig();
    raw.sources.pois[key] = 'typo';

    expect(() => validateConfig(raw, { repoRoot: '/srv/tiles' })).toThrow(
      new RegExp(`unknown key "${key}"`, 'i'),
    );
  });

  it('rejects an unknown attribution key', () => {
    const raw = makeConfig();
    raw.sources.pois.attribution[0].url = 'https://example.com';

    expect(() => validateConfig(raw, { repoRoot: '/srv/tiles' })).toThrow(/unknown key/i);
  });

  it('rejects a javascript attribution URL', () => {
    const raw = makeConfig();
    raw.sources.pois.attribution[0].href = 'javascript:alert(1)';

    expect(() => validateConfig(raw, { repoRoot: '/srv/tiles' })).toThrow(/http or https/i);
  });

  it('rejects an attribution URL without a protocol', () => {
    const raw = makeConfig();
    raw.sources.pois.attribution[0].href = 'www.openstreetmap.org';

    expect(() => validateConfig(raw, { repoRoot: '/srv/tiles' })).toThrow(/http or https/i);
  });
});

describe('resolveArchiveDir', () => {
  const root = '/srv/tiles';

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['the repository root', '.'],
    ['a dot-prefixed root', './'],
    ['parent traversal', '..'],
    ['nested traversal', 'data/../outside'],
    ['an interior dot segment', 'data/./pois'],
    ['an escaping path', '../outside'],
  ])('rejects %s', (_label, value) => {
    expect(() => resolveArchiveDir(value, 'archiveDir', root)).toThrow(ConfigError);
  });

  it('explains an interior dot segment instead of calling it the repository root', () => {
    expect(() => resolveArchiveDir('data/./pois', 'archiveDir', root)).toThrow(
      /must not contain "\." path segments/,
    );
  });

  it('accepts a name beginning with two dots', () => {
    expect(resolveArchiveDir('..data/pois', 'archiveDir', root)).toBe(
      path.join(root, '..data', 'pois'),
    );
  });

  it('accepts a nested relative directory', () => {
    expect(resolveArchiveDir('data/pois', 'archiveDir', root)).toBe(
      path.join(root, 'data', 'pois'),
    );
  });

  it('rejects absolute directories when they are not allowed', () => {
    expect(() =>
      resolveArchiveDir('/srv/data/pois', 'archiveDir', root, { allowAbsolute: false }),
    ).toThrow(/relative directory/);
  });

  it('keeps absolute directories when they are allowed', () => {
    expect(resolveArchiveDir('/srv/data/pois', 'archiveDir', root)).toBe('/srv/data/pois');
  });
});

describe('loadConfig', () => {
  it('resolves archive directories against the supplied repository root, not the config path', async () => {
    const root = await makeDirectory();
    const configPath = path.join(root, 'custom', 'nested', 'layers.json');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify(makeConfig()), 'utf8');

    const config = loadConfig(configPath, { repoRoot: root });

    expect(config.sources.pois.archiveDir).toBe(path.join(root, 'data', 'pois'));
  });

  it('requires an explicit repository root', async () => {
    const root = await makeDirectory();
    const configPath = path.join(root, 'layers.json');
    await writeFile(configPath, JSON.stringify(makeConfig()), 'utf8');

    expect(() => loadConfig(configPath)).toThrow(/repoRoot/);
  });

  it('reports invalid JSON with a ConfigError', async () => {
    const root = await makeDirectory();
    const configPath = path.join(root, 'layers.json');
    await writeFile(configPath, '{ not json', 'utf8');

    expect(() => loadConfig(configPath, { repoRoot: root })).toThrow(ConfigError);
    expect(() => loadConfig(configPath, { repoRoot: root })).toThrow(/not valid JSON/i);
  });

  it('reports a missing file with a ConfigError', async () => {
    const root = await makeDirectory();

    expect(() => loadConfig(path.join(root, 'missing.json'), { repoRoot: root })).toThrow(
      ConfigError,
    );
  });
});

function makeContourSource(overrides = {}) {
  return {
    kind: 'contour',
    title: 'Terrain contours',
    description: 'Contour lines generated on demand.',
    attribution: [{ title: 'Mapterhorn', href: 'https://mapterhorn.com/attribution' }],
    minzoom: 1,
    maxzoom: 15,
    demUrl: 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp',
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
      4: [300, 1500],
      12: [20, 100],
    },
    ...overrides,
  };
}

function makeContourConfig(overrides = {}) {
  return {
    version: 1,
    server: { host: '127.0.0.1', port: 11010 },
    sources: { contours: makeContourSource(overrides) },
  };
}

describe('validateConfig contour sources', () => {
  it('normalises a contour source and sorts its thresholds', () => {
    const config = validateConfig(makeContourConfig(), { repoRoot: '/srv/tiles' });

    expect(config.sources.contours).toEqual({
      kind: 'contour',
      title: 'Terrain contours',
      description: 'Contour lines generated on demand.',
      attribution: [{ title: 'Mapterhorn', href: 'https://mapterhorn.com/attribution' }],
      minzoom: 1,
      maxzoom: 15,
      demUrl: 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp',
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
      thresholds: {
        4: [300, 1500],
        12: [20, 100],
      },
      cacheMaxAge: 86400,
    });
  });

  it('applies contour defaults for optional fields', () => {
    const source = makeContourSource();
    for (const key of [
      'demMaxzoom',
      'demTileSize',
      'cacheSize',
      'timeoutMs',
      'buffer',
      'extent',
      'contourLayer',
      'elevationKey',
      'levelKey',
      'cacheMaxAge',
    ]) {
      delete source[key];
    }

    const config = validateConfig(
      { ...makeContourConfig(), sources: { contours: source } },
      { repoRoot: '/srv/tiles' },
    );

    expect(config.sources.contours).toMatchObject({
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
    });
  });

  it('rejects archiveDir on a contour source', () => {
    const raw = makeContourConfig({ archiveDir: 'data/contours' });

    expect(() => validateConfig(raw, { repoRoot: '/srv/tiles' })).toThrow(
      /unknown key "archiveDir"/,
    );
  });

  it.each([
    ['demUrl', {}],
    ['thresholds', {}],
    ['encoding', {}],
    ['cacheMaxAge', {}],
  ])('rejects the contour-only key %s on a PMTiles source', (key) => {
    const raw = makeConfig();
    raw.sources.pois[key] = makeContourSource()[key];

    expect(() => validateConfig(raw, { repoRoot: '/srv/tiles' })).toThrow(
      new RegExp(`unknown key "${key}"`),
    );
  });

  it.each([
    ['minzoom below one', { minzoom: 0 }],
    ['maxzoom above fifteen', { maxzoom: 16 }],
    ['minzoom above maxzoom', { minzoom: 10, maxzoom: 9 }],
    ['fractional zoom', { minzoom: 1.5 }],
  ])('rejects bad contour zooms: %s', (_label, overrides) => {
    expect(() => validateConfig(makeContourConfig(overrides), { repoRoot: '/srv/tiles' })).toThrow(
      ConfigError,
    );
  });

  it.each([
    ['relative URL', '/dem/{z}/{x}/{y}.webp'],
    ['ftp URL', 'ftp://tiles.example/{z}/{x}/{y}.webp'],
    ['missing z placeholder', 'https://tiles.example/{x}/{y}.webp'],
    ['missing x placeholder', 'https://tiles.example/{z}/{y}.webp'],
    ['missing y placeholder', 'https://tiles.example/{z}/{x}.webp'],
  ])('rejects a DEM URL with %s', (_label, demUrl) => {
    expect(() => validateConfig(makeContourConfig({ demUrl }), { repoRoot: '/srv/tiles' })).toThrow(
      ConfigError,
    );
  });

  it.each(['png', 'lerc', 'TERRARIUM'])('rejects the encoding %s', (encoding) => {
    expect(() =>
      validateConfig(makeContourConfig({ encoding }), { repoRoot: '/srv/tiles' }),
    ).toThrow(/encoding/);
  });

  it.each([
    ['demMaxzoom above seventeen', { demMaxzoom: 18 }],
    ['negative demMaxzoom', { demMaxzoom: -1 }],
    ['demMaxzoom above maxzoom', { demMaxzoom: 16 }],
    ['zero demTileSize', { demTileSize: 0 }],
    ['demTileSize below its minimum', { demTileSize: 255 }],
    ['demTileSize above its maximum', { demTileSize: 2049 }],
    ['zero cacheSize', { cacheSize: 0 }],
    ['cacheSize above its maximum', { cacheSize: 1001 }],
    ['timeoutMs below its minimum', { timeoutMs: 999 }],
    ['timeoutMs above its maximum', { timeoutMs: 60001 }],
    ['zero extent', { extent: 0 }],
    ['extent below its minimum', { extent: 255 }],
    ['extent above its maximum', { extent: 8193 }],
    ['zero cacheMaxAge', { cacheMaxAge: 0 }],
    ['cacheMaxAge below its minimum', { cacheMaxAge: 59 }],
    ['cacheMaxAge above its maximum', { cacheMaxAge: 86401 }],
    ['a negative buffer', { buffer: -1 }],
    ['a buffer above its maximum', { buffer: 65 }],
    ['a fractional buffer', { buffer: 1.5 }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => validateConfig(makeContourConfig(overrides), { repoRoot: '/srv/tiles' })).toThrow(
      ConfigError,
    );
  });

  it('accepts contour fields at their lower bounds', () => {
    const config = validateConfig(
      makeContourConfig({
        demMaxzoom: 0,
        demTileSize: 256,
        cacheSize: 1,
        timeoutMs: 1000,
        buffer: 0,
        extent: 256,
        cacheMaxAge: 60,
      }),
      { repoRoot: '/srv/tiles' },
    );

    expect(config.sources.contours).toMatchObject({
      demMaxzoom: 0,
      demTileSize: 256,
      cacheSize: 1,
      timeoutMs: 1000,
      buffer: 0,
      extent: 256,
      cacheMaxAge: 60,
    });
  });

  it('accepts contour fields at their upper bounds', () => {
    const config = validateConfig(
      makeContourConfig({
        demMaxzoom: 15,
        demTileSize: 2048,
        cacheSize: 1000,
        timeoutMs: 60000,
        buffer: 64,
        extent: 8192,
        cacheMaxAge: 86400,
      }),
      { repoRoot: '/srv/tiles' },
    );

    expect(config.sources.contours).toMatchObject({
      demMaxzoom: 15,
      demTileSize: 2048,
      cacheSize: 1000,
      timeoutMs: 60000,
      buffer: 64,
      extent: 8192,
      cacheMaxAge: 86400,
    });
  });

  it('rejects a non-numeric buffer', () => {
    expect(() =>
      validateConfig(makeContourConfig({ buffer: '1' }), { repoRoot: '/srv/tiles' }),
    ).toThrow(/buffer/);
  });

  it('rejects an empty threshold table', () => {
    expect(() =>
      validateConfig(makeContourConfig({ thresholds: {} }), { repoRoot: '/srv/tiles' }),
    ).toThrow(/at least one/);
  });

  it.each([
    ['a zoom above twenty-six', { 27: [1, 2] }],
    ['a non-integer zoom', { 1.5: [1, 2] }],
    ['a padded zoom string', { '01': [1, 2] }],
  ])('rejects a threshold with %s', (_label, thresholds) => {
    expect(() =>
      validateConfig(makeContourConfig({ thresholds }), { repoRoot: '/srv/tiles' }),
    ).toThrow(/zoom level/);
  });

  it.each([
    ['a bare number', { 12: 20 }],
    ['one interval', { 12: [20] }],
    ['three intervals', { 12: [20, 100, 200] }],
    ['non-numeric intervals', { 12: ['20', '100'] }],
    ['minor equal to major', { 12: [20, 20] }],
    ['minor above major', { 12: [100, 20] }],
    ['a negative minor interval', { 12: [-20, 100] }],
    ['two negative intervals', { 12: [-100, -10] }],
    ['a zero minor interval', { 12: [0, 100] }],
    ['a sub-one minor interval', { 12: [0.5, 100] }],
    ['a fractional major interval', { 12: [20, 100.5] }],
  ])('rejects a threshold with %s', (_label, thresholds) => {
    expect(() =>
      validateConfig(makeContourConfig({ thresholds }), { repoRoot: '/srv/tiles' }),
    ).toThrow(ConfigError);
  });

  it('rejects an empty contour layer name', () => {
    expect(() =>
      validateConfig(makeContourConfig({ contourLayer: ' ' }), { repoRoot: '/srv/tiles' }),
    ).toThrow(/contourLayer/);
  });
});
