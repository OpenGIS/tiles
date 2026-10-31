import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { beforeAll, describe, expect, it } from 'vitest';

import { validateBuildManifest } from '../../src/build/manifest.mjs';
import { repoRoot } from '../helpers/temp.mjs';

const execFile = promisify(execFileCallback);

const fixturePath = path.join(repoRoot, 'test', 'fixtures', 'alberta-canmore.osm.pbf');
const fixtureManifestPath = path.join(
  repoRoot,
  'test',
  'fixtures',
  'alberta-canmore.manifest.json',
);
const outputRoot = path.join(repoRoot, 'tmp', 'build');

let build;
let archivePath;
let manifestPath;
let manifest;

beforeAll(async () => {
  await rm(outputRoot, { recursive: true, force: true });

  await execFile(
    process.execPath,
    [
      'bin/ogis.mjs',
      'build',
      '--only=pois',
      `--fixture=${path.relative(repoRoot, fixturePath)}`,
      `--output-dir=${path.relative(repoRoot, outputRoot)}`,
    ],
    {
      cwd: repoRoot,
      timeout: 600000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );

  const entries = await readdir(outputRoot, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  expect(directories).toHaveLength(1);

  build = path.join(outputRoot, directories[0].name);
  archivePath = path.join(build, 'pois', 'current.pmtiles');
  manifestPath = path.join(build, 'pois', 'build.json');
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
}, 600000);

describe('POI fixture build', () => {
  it('matches the committed fixture hash and size', async () => {
    const fixtureManifest = JSON.parse(await readFile(fixtureManifestPath, 'utf8'));
    const contents = await readFile(fixturePath);

    expect(createHash('sha256').update(contents).digest('hex')).toBe(fixtureManifest.sha256);
    expect((await stat(fixturePath)).size).toBe(fixtureManifest.bytes);
  });

  it('writes a non-empty PMTiles archive', async () => {
    expect((await stat(archivePath)).size).toBeGreaterThan(manifest.sizeFloor);
  });

  it('passes pmtiles verify', async () => {
    const { stderr } = await execFile('pmtiles', ['verify', archivePath], {
      cwd: repoRoot,
      maxBuffer: 16 * 1024 * 1024,
    });

    expect(stderr).not.toMatch(/Failed to verify/i);
  });

  it('decodes a sample tile with outdoor_pois features and attributes', async () => {
    const sample = JSON.parse(await readFile(path.join(repoRoot, 'config', 'layers.json'), 'utf8'))
      .sources.pois.build.sampleTiles[0];

    const { stdout } = await execFile(
      'pmtiles',
      ['tile', archivePath, String(sample.z), String(sample.x), String(sample.y)],
      { cwd: repoRoot, encoding: null, maxBuffer: 64 * 1024 * 1024 },
    );

    expect(stdout.length).toBeGreaterThan(0);

    const tile = stdout[0] === 0x1f && stdout[1] === 0x8b ? gunzipSync(stdout) : stdout;
    const vectorTile = new VectorTile(new PbfReader(tile));
    const layer = vectorTile.layers.outdoor_pois;

    expect(layer).toBeDefined();
    expect(layer.length).toBeGreaterThan(0);

    const properties = [];
    for (let index = 0; index < layer.length; index += 1) {
      properties.push(layer.feature(index).properties);
    }

    expect(properties.some((value) => typeof value.kind === 'string')).toBe(true);
    expect(properties.some((value) => typeof value.name === 'string')).toBe(true);
  });

  it('records a complete build manifest', async () => {
    expect(() => validateBuildManifest(manifest)).not.toThrow();

    expect(manifest.buildId).toBe(`fixture-${manifest.archive.sha256.slice(0, 12)}`);
    expect(manifest.buildId).toMatch(/^fixture-[a-f0-9]{12}$/);
    expect(manifest.source).toBe('pois');
    expect(manifest.mode).toBe('fixture');
    expect(manifest.minzoom).toBe(0);
    expect(manifest.maxzoom).toBe(16);
    expect(manifest.planet.date).toBe('2026-10-29');
    expect(manifest.planet.sha256).toHaveLength(64);
    expect(manifest.fixture).toMatchObject({
      path: 'test/fixtures/alberta-canmore.osm.pbf',
      extractDate: '2026-10-29',
    });
    expect(manifest.fixture.sha256).toBe(manifest.planet.sha256);
    expect(manifest.fixture.bbox).toEqual([-115.65, 50.95, -115.05, 51.35]);
    expect(manifest.tools.planetiler.version).toBe('0.10.2');
    expect(manifest.tools.planetiler.sha256).toHaveLength(64);
    expect(manifest.tools.pmtiles.version).toBeTypeOf('string');
    expect(manifest.tools.pmtiles.version.length).toBeGreaterThan(0);
    expect(manifest.tools.pmtiles.sha256).toHaveLength(64);
    expect(manifest.tools.pmtiles.pinned).toBe('1.31.2');
    expect(manifest.tools.java.version).toMatch(/^\d+/);
    expect(manifest.tools.java.path).toBeTypeOf('string');
    expect(manifest.tools.java.sha256).toHaveLength(64);
    expect(manifest.tools.osmium.version).toMatch(/^\d+\./);
    expect(manifest.tools.osmium.path).toBeTypeOf('string');
    expect(manifest.tools.osmium.sha256).toHaveLength(64);
    expect(manifest.profile.sha256).toHaveLength(64);
    expect(manifest.filter.sha256).toHaveLength(64);
    expect(manifest.filter.expressions).toBe(18);
    expect(manifest.filter).toMatchObject({ applied: true, skipped: false });
    expect(manifest.skips).toMatchObject({ build: false, verify: false });
    expect(manifest.verification).toMatchObject({
      ok: true,
      skipped: false,
      layers: [{ layer: 'outdoor_pois', requiredAttributes: ['kind', 'name'] }],
    });
    expect(manifest.archive.path).toBe('current.pmtiles');
    expect(manifest.archive.bytes).toBe((await stat(archivePath)).size);
    expect(manifest.archive.tiles).toBeGreaterThan(0);
    expect(manifest.archive.compression).toBe('gzip');
    expect(manifest.archive.metadata.available).toBe(true);
    expect(manifest.samples.length).toBeGreaterThan(0);
    expect(manifest.samples[0]).toMatchObject({ layer: 'outdoor_pois' });
    expect(manifest.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('records the actual pmtiles CLI version and binary hash', async () => {
    const { stdout } = await execFile('pmtiles', ['version'], { cwd: repoRoot });
    const reported = /^pmtiles\s+(.+)$/m.exec(stdout)?.[1]?.trim();

    expect(reported).toBeTypeOf('string');
    expect(manifest.tools.pmtiles.version).toBe(reported);

    const { stdout: executableOutput } = await execFile('which', ['pmtiles'], { cwd: repoRoot });
    const executable = executableOutput.trim();
    const binaryHash = createHash('sha256')
      .update(await readFile(executable))
      .digest('hex');

    expect(manifest.tools.pmtiles.sha256).toBe(binaryHash);
    expect(manifest.tools.pmtiles.pinned).toBe('1.31.2');
  });

  it('records the archive SHA-256 in the manifest', async () => {
    const contents = await readFile(archivePath);

    expect(createHash('sha256').update(contents).digest('hex')).toBe(manifest.archive.sha256);
  });
});
