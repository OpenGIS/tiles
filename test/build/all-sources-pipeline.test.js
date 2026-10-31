import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { beforeAll, describe, expect, it } from 'vitest';

import { sourceExpressionUnion, hashExpressions } from '../../src/build/expressions.mjs';
import { validateBuildManifest } from '../../src/build/manifest.mjs';
import { PmtilesReader } from '../../src/lib/pmtiles.mjs';
import { repoRoot } from '../helpers/temp.mjs';

const execFile = promisify(execFileCallback);

const fixturePath = path.join(repoRoot, 'test', 'fixtures', 'alberta-canmore.osm.pbf');
const fixtureManifestPath = path.join(
  repoRoot,
  'test',
  'fixtures',
  'alberta-canmore.manifest.json',
);
const configPath = path.join(repoRoot, 'config', 'layers.json');
const outputRoot = path.join(repoRoot, 'tmp', 'build');

const EXPECTED = {
  pois: {
    minzoom: 0,
    maxzoom: 16,
    layer: 'outdoor_pois',
    profile: 'build/profiles/pois.yml',
    geometry: [1],
    sizeFloor: 4096,
    requiredAttributes: ['kind', 'name'],
  },
  routes: {
    minzoom: 8,
    maxzoom: 14,
    layer: 'outdoor_routes',
    profile: 'build/profiles/routes.java',
    geometry: [2],
    sizeFloor: 65536,
    requiredAttributes: ['activity', 'activities'],
  },
  paths: {
    minzoom: 9,
    maxzoom: 13,
    layer: 'outdoor_paths',
    profile: 'build/profiles/paths.java',
    geometry: [2],
    sizeFloor: 131072,
    requiredAttributes: ['class', 'network'],
  },
};

const NETWORKS = {
  hiking: new Set(['iwn', 'nwn', 'rwn', 'lwn']),
  cycling: new Set(['icn', 'ncn', 'rcn', 'lcn']),
};

let config;
let fixtureManifest;
let builds;

async function decodeSample(archivePath, sample, layer) {
  const reader = new PmtilesReader(archivePath);

  try {
    await reader.open();
    const tile = await reader.getTile(sample.z, sample.x, sample.y);
    expect(tile).not.toBeNull();

    const data = tile.compression === 'gzip' ? gunzipSync(tile.data) : tile.data;
    const vectorLayer = new VectorTile(new PbfReader(data)).layers[layer];
    expect(vectorLayer).toBeDefined();

    const features = [];
    for (let index = 0; index < vectorLayer.length; index += 1) {
      const feature = vectorLayer.feature(index);
      features.push({ type: feature.type, properties: feature.properties });
    }

    return features;
  } finally {
    await reader.close();
  }
}

async function discoverBuilds(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const found = {};

  for (const buildId of directories) {
    const buildDir = path.join(root, buildId);
    const sources = (await readdir(buildDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    for (const source of sources) {
      found[source] = {
        buildId,
        dir: path.join(buildDir, source),
        archivePath: path.join(buildDir, source, 'current.pmtiles'),
        manifestPath: path.join(buildDir, source, 'build.json'),
      };
    }
  }

  return { directories, found };
}

beforeAll(async () => {
  await rm(outputRoot, { recursive: true, force: true });
  config = JSON.parse(await readFile(configPath, 'utf8'));
  fixtureManifest = JSON.parse(await readFile(fixtureManifestPath, 'utf8'));

  await execFile(
    process.execPath,
    [
      'bin/ogis.mjs',
      'build',
      `--fixture=${path.relative(repoRoot, fixturePath)}`,
      `--output-dir=${path.relative(repoRoot, outputRoot)}`,
    ],
    {
      cwd: repoRoot,
      timeout: 900000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );

  const discovered = await discoverBuilds(outputRoot);
  expect(discovered.directories).toHaveLength(3);
  expect(Object.keys(discovered.found).sort()).toEqual(['paths', 'pois', 'routes']);

  builds = discovered.found;
  for (const [source, build] of Object.entries(builds)) {
    build.manifest = JSON.parse(await readFile(build.manifestPath, 'utf8'));
    build.expected = EXPECTED[source];
  }
}, 900000);

describe('Alberta Canmore fixture build', () => {
  it('matches the committed fixture hash and size', async () => {
    const contents = await readFile(fixturePath);

    expect(createHash('sha256').update(contents).digest('hex')).toBe(fixtureManifest.sha256);
    expect((await stat(fixturePath)).size).toBe(fixtureManifest.bytes);
  });

  it('uses one osmium filter union for every source', () => {
    const expressions = sourceExpressionUnion({
      pois: { expressions: config.sources.pois.build.expressions },
      routes: { expressions: config.sources.routes.build.expressions },
      paths: { expressions: config.sources.paths.build.expressions },
    });
    const expectedHash = hashExpressions(expressions);

    expect(expressions).toHaveLength(25);

    for (const build of Object.values(builds)) {
      expect(build.manifest.filter).toMatchObject({
        expressions: 25,
        sha256: expectedHash,
        applied: true,
        skipped: false,
      });
    }
  });

  it.each(['pois', 'routes', 'paths'])('%s writes a non-empty PMTiles archive', async (source) => {
    const { archivePath, manifest, expected } = builds[source];
    const bytes = (await stat(archivePath)).size;

    expect(bytes).toBeGreaterThan(manifest.sizeFloor);
    expect(bytes).toBeGreaterThanOrEqual(expected.sizeFloor);
    expect(manifest.sizeFloor).toBe(expected.sizeFloor);
    expect(manifest.archive.bytes).toBe(bytes);
  });

  it.each(['pois', 'routes', 'paths'])('%s passes pmtiles verify', async (source) => {
    const { stderr } = await execFile('pmtiles', ['verify', builds[source].archivePath], {
      cwd: repoRoot,
      maxBuffer: 16 * 1024 * 1024,
    });

    expect(stderr).not.toMatch(/Failed to verify/i);
  });

  it.each(['pois', 'routes', 'paths'])('%s records a complete build manifest', async (source) => {
    const { manifest, archivePath, expected } = builds[source];

    expect(() => validateBuildManifest(manifest)).not.toThrow();

    expect(manifest.buildId).toBe(`fixture-${manifest.archive.sha256.slice(0, 12)}`);
    expect(manifest.buildId).toMatch(/^fixture-[a-f0-9]{12}$/);
    expect(manifest.source).toBe(source);
    expect(manifest.mode).toBe('fixture');
    expect(manifest.minzoom).toBe(expected.minzoom);
    expect(manifest.maxzoom).toBe(expected.maxzoom);
    expect(manifest.planet.date).toBe('2026-10-29');
    expect(manifest.planet.sha256).toHaveLength(64);
    expect(manifest.fixture).toMatchObject({
      path: 'test/fixtures/alberta-canmore.osm.pbf',
      extractDate: '2026-10-29',
    });
    expect(manifest.fixture.bbox).toEqual([-115.65, 50.95, -115.05, 51.35]);
    expect(manifest.profile.path).toBe(expected.profile);
    expect(manifest.profile.sha256).toHaveLength(64);
    expect(manifest.tools.planetiler.version).toBe('0.10.2');
    expect(manifest.tools.pmtiles.pinned).toBe('1.31.2');
    expect(manifest.tools.java.version).toMatch(/^\d+/);
    expect(manifest.tools.osmium.version).toMatch(/^\d+\./);
    expect(manifest.skips).toMatchObject({ build: false, verify: false });
    expect(manifest.verification).toMatchObject({
      ok: true,
      skipped: false,
      layers: [
        {
          layer: expected.layer,
          requiredAttributes: expected.requiredAttributes,
          ...(source === 'pois' ? {} : { geometry: 'line' }),
        },
      ],
    });
    expect(manifest.archive.path).toBe('current.pmtiles');
    expect(manifest.archive.bytes).toBe((await stat(archivePath)).size);
    expect(manifest.archive.tiles).toBeGreaterThan(0);
    expect(manifest.archive.compression).toBe('gzip');
    expect(manifest.archive.metadata.available).toBe(true);
    expect(manifest.samples.length).toBeGreaterThan(0);
    expect(manifest.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    for (const sample of manifest.samples) {
      expect(sample.layer).toBe(expected.layer);
      expect(sample.geometries).toEqual(expected.geometry);
      for (const attribute of expected.requiredAttributes) {
        expect(sample.attributes).toContain(attribute);
      }
    }
  });

  it('decodes POI sample tiles with points and the configured attributes', async () => {
    const { archivePath, manifest, expected } = builds.pois;

    for (const sample of manifest.samples) {
      const features = await decodeSample(archivePath, sample, expected.layer);

      expect(features.length).toBeGreaterThan(0);
      expect(features.every((feature) => feature.type === 1)).toBe(true);
      expect(features.some((feature) => typeof feature.properties.kind === 'string')).toBe(true);
      expect(features.some((feature) => typeof feature.properties.name === 'string')).toBe(true);
    }
  });

  it('decodes route sample tiles with lines, activities and valid networks', async () => {
    const { archivePath, manifest, expected } = builds.routes;
    const networks = new Set();

    for (const sample of manifest.samples) {
      const features = await decodeSample(archivePath, sample, expected.layer);

      expect(features.length).toBeGreaterThan(0);
      expect(features.every((feature) => feature.type === 2)).toBe(true);

      for (const { properties } of features) {
        expect(['hiking', 'cycling']).toContain(properties.activity);
        expect(properties.activities.split(';')).toContain(properties.activity);

        if (properties.network !== undefined) {
          expect(NETWORKS[properties.activity].has(properties.network)).toBe(true);
          networks.add(properties.network);
        }
      }
    }

    expect([...networks].sort()).toEqual(expect.arrayContaining(['lwn', 'ncn']));
  });

  it('decodes path sample tiles with lines, classes and the lwn network fix', async () => {
    const { archivePath, manifest, expected } = builds.paths;
    const classes = new Set();
    const networks = new Set();
    let stoneyLookout;

    for (const sample of manifest.samples) {
      const features = await decodeSample(archivePath, sample, expected.layer);

      expect(features.length).toBeGreaterThan(0);
      expect(features.every((feature) => feature.type === 2)).toBe(true);

      for (const { properties } of features) {
        expect(['path', 'footway', 'track']).toContain(properties.class);
        classes.add(properties.class);

        if (properties.network !== undefined) {
          expect(['iwn', 'nwn', 'rwn', 'lwn']).toContain(properties.network);
          networks.add(properties.network);
        }

        if (properties.name === 'Stoney Lookout Trail') {
          stoneyLookout = properties;
        }
      }
    }

    expect([...classes].sort()).toEqual(expect.arrayContaining(['footway', 'path', 'track']));

    // The v1 profile only attached a network when the tier lowered the minimum
    // zoom, so an lwn-only way lost its network attribute entirely.
    expect(networks.has('lwn')).toBe(true);
    expect(stoneyLookout).toMatchObject({ class: 'path', network: 'lwn' });
  });

  it('gives each source its own content-addressed build directory', () => {
    const buildIds = new Set(Object.values(builds).map((build) => build.buildId));

    expect(buildIds.size).toBe(3);

    for (const build of Object.values(builds)) {
      expect(build.dir).toBe(path.join(outputRoot, build.buildId, build.manifest.source));
      expect(build.manifest.buildId).toBe(build.buildId);
    }
  });
});
