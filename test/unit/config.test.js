import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ConfigError, loadConfig, validateConfig } from '../../src/lib/config.mjs';
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
