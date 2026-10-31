import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { pathExists, sha256Text } from '../../../src/build/fs.mjs';
import { runBuild } from '../../../src/build/pipeline.mjs';
import { createTempDirectory, removeTempDirectory, repoRoot } from '../../helpers/temp.mjs';

const created = [];
const workDirs = [];
const fakePlanetilerVersion = `test-keepwork-${process.pid}`;
const fakeJarContents = 'fake planetiler jar';
const fakeJarPath = path.join(repoRoot, 'tmp', 'tools', `planetiler-${fakePlanetilerVersion}.jar`);

async function makeTemp() {
  const root = await createTempDirectory('tiles-build-pipeline-');
  created.push(root);
  return root;
}

function relativeOutputDir(root, name = 'out') {
  return path.relative(repoRoot, path.join(root, name)).split(path.sep).join('/');
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => removeTempDirectory(directory)));
  await Promise.all(
    workDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
  await rm(fakeJarPath, { force: true });
});

async function makeArchive(root, bytes = 5000) {
  const archivePath = path.join(root, 'input', 'current.pmtiles');
  await mkdir(path.dirname(archivePath), { recursive: true });
  await writeFile(archivePath, Buffer.alloc(bytes, 1));
  return archivePath;
}

async function makeToolMocks(root, { tiles = 42 } = {}) {
  const executable = path.join(root, 'bin', 'pmtiles');
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, 'pmtiles executable', 'utf8');

  const execFileImpl = async (command, args) => {
    if (command === 'which' && args[0] === 'pmtiles') {
      return { stdout: `${executable}\n`, stderr: '' };
    }

    if (command === 'pmtiles') {
      if (args[0] === 'version') {
        return { stdout: 'pmtiles 1.31.2\n', stderr: '' };
      }

      if (args[0] === 'show' && args[1] === '--metadata') {
        return {
          stdout: JSON.stringify({
            'planetiler:osm:osmosisreplicationtime': '2026-10-29T20:21:00Z',
          }),
          stderr: '',
        };
      }

      if (args[0] === 'show') {
        return {
          stdout: `tile type: mvt\ntile compression: gzip\naddressed tiles count: ${tiles}\n`,
          stderr: '',
        };
      }

      if (args[0] === 'verify') {
        return { stdout: '', stderr: 'Completed verify in 1ms.' };
      }
    }

    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };

  return execFileImpl;
}

async function runSkipBuild({ root, archivePath, execFileImpl, ...overrides }) {
  return runBuild({
    repoRoot,
    only: 'pois',
    fixture: 'test/fixtures/alberta-canmore.osm.pbf',
    archive: archivePath,
    outputDir: relativeOutputDir(root),
    skipBuild: true,
    skipVerify: true,
    execFileImpl,
    log: () => {},
    warn: () => {},
    ...overrides,
  });
}

async function writeFailureConfig(root, { planetFloor = 104857600 } = {}) {
  const configPath = path.join(root, 'layers.json');
  const config = {
    version: 1,
    server: { host: '127.0.0.1', port: 11010 },
    build: {
      planet: { date: '', url: '', sha256: '' },
      tools: {
        planetiler: {
          version: fakePlanetilerVersion,
          url: 'https://example.invalid/planetiler.jar',
          sha256: sha256Text(fakeJarContents),
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
        archiveDir: path
          .relative(repoRoot, path.join(root, 'data', 'pois'))
          .split(path.sep)
          .join('/'),
        minzoom: 12,
        maxzoom: 16,
        build: {
          profile: 'pois',
          minzoom: 0,
          maxzoom: 16,
          expressions: ['nwr/tourism=viewpoint'],
          sampleTiles: [{ z: 13, x: 1471, y: 2739 }],
          verification: { layer: 'outdoor_pois', requiredAttributes: ['kind'] },
          sizeFloor: { fixture: 4096, planet: planetFloor },
        },
      },
    },
  };

  await writeFile(configPath, JSON.stringify(config), 'utf8');
  return configPath;
}

async function makeFailingToolchain(root) {
  const binDir = path.join(root, 'bin');
  const paths = {};

  await mkdir(binDir, { recursive: true });
  for (const name of ['java', 'osmium', 'pmtiles']) {
    const executable = path.join(binDir, name);
    await writeFile(executable, `${name} executable`, 'utf8');
    paths[name] = executable;
  }

  return async (command, args) => {
    if (command === 'which') {
      if (!paths[args[0]]) {
        throw new Error(`unexpected which ${args[0]}`);
      }

      return { stdout: `${paths[args[0]]}\n`, stderr: '' };
    }

    if (command === 'java' && args[0] === '-version') {
      return { stdout: '', stderr: 'openjdk version "26.0.2" 2026-07-21' };
    }

    if (command === 'java' && args[0] === '-jar') {
      const output = args.find((argument) => argument.startsWith('--output='));
      const outputPath = output.slice('--output='.length);
      await mkdir(path.dirname(outputPath), { recursive: true });
      await writeFile(outputPath, 'partial archive', 'utf8');
      return { stdout: 'planetiler complete', stderr: '' };
    }

    if (command === 'osmium' && args[0] === '--version') {
      return { stdout: 'osmium version 1.19.1\n', stderr: '' };
    }

    if (command === 'osmium' && args[0] === 'fileinfo') {
      return { stdout: 'file info', stderr: '' };
    }

    if (command === 'osmium' && (args[0] === 'tags-filter' || args[0] === 'cat')) {
      await writeFile(args[args.length - 1], 'pbf', 'utf8');
      return { stdout: '', stderr: '' };
    }

    if (command === 'pmtiles' && args[0] === 'version') {
      return { stdout: 'pmtiles 1.31.2\n', stderr: '' };
    }

    if (command === 'pmtiles' && args[0] === 'show' && args[1] === '--header-json') {
      return {
        stdout: JSON.stringify({
          tile_type: 'mvt',
          tile_compression: 'gzip',
          minzoom: 0,
          maxzoom: 16,
          bounds: [-115.65, 50.95, -115.05, 51.35],
        }),
        stderr: '',
      };
    }

    if (command === 'pmtiles' && args[0] === 'edit') {
      return { stdout: '', stderr: '' };
    }

    if (command === 'pmtiles' && args[0] === 'verify') {
      const error = new Error('Command failed');
      error.code = 1;
      error.stderr = 'main.go:239: Failed to verify archive, invalid: simulated failure';
      throw error;
    }

    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  };
}

async function runFailingBuild(keepWork) {
  const root = await makeTemp();
  await mkdir(path.dirname(fakeJarPath), { recursive: true });
  await writeFile(fakeJarPath, fakeJarContents, 'utf8');

  const configPath = await writeFailureConfig(root);
  const execFileImpl = await makeFailingToolchain(root);
  const outputDir = path.join(root, 'out');
  const relativeOutput = path.relative(repoRoot, outputDir).split(path.sep).join('/');
  let runId = '';

  await expect(
    runBuild({
      repoRoot,
      configPath,
      only: 'pois',
      fixture: 'test/fixtures/alberta-canmore.osm.pbf',
      outputDir: relativeOutput,
      keepWork,
      execFileImpl,
      log: (line) => {
        const match = /^Build run ([a-f0-9]+)$/.exec(line);
        if (match) {
          runId = match[1];
        }
      },
      warn: () => {},
    }),
  ).rejects.toThrow(/Failed to verify archive/);

  expect(runId).toMatch(/^[a-f0-9]+$/);
  const workDir = path.join(repoRoot, 'tmp', 'work', runId, 'pois');
  workDirs.push(path.dirname(workDir));

  return { outputDir, runId, workDir };
}

describe('runBuild failure cleanup', () => {
  it('removes partial archives and the work directory by default', async () => {
    const { outputDir, runId, workDir } = await runFailingBuild(false);
    const stagingDir = path.join(outputDir, '.staging', runId, 'pois');

    expect(await pathExists(path.join(stagingDir, 'current.partial.pmtiles'))).toBe(false);
    expect(await pathExists(path.join(stagingDir, 'current.pmtiles'))).toBe(false);
    expect(await readdir(outputDir)).toEqual([]);
    expect(await pathExists(workDir)).toBe(false);
  });

  it('keeps the work directory but removes partial archives with keepWork', async () => {
    const { outputDir, runId, workDir } = await runFailingBuild(true);
    const stagingDir = path.join(outputDir, '.staging', runId, 'pois');

    expect(await pathExists(path.join(stagingDir, 'current.partial.pmtiles'))).toBe(false);
    expect(await pathExists(path.join(stagingDir, 'current.pmtiles'))).toBe(false);
    expect(await readdir(outputDir)).toEqual([]);
    expect(await pathExists(workDir)).toBe(true);
  });
});

describe('runBuild validation', () => {
  it('rejects --skip-download with --force up front', async () => {
    await expect(
      runBuild({
        repoRoot,
        only: 'pois',
        skipDownload: true,
        force: true,
        log: () => {},
        warn: () => {},
      }),
    ).rejects.toThrow(/--skip-download cannot be combined with --force/);
  });

  it.each([
    ['an empty --only', { only: '' }, /--only/],
    ['a prototype --only', { only: '__proto__,constructor' }, /has no build profile/],
    ['an empty --fixture', { fixture: '   ' }, /--fixture/],
    ['an invalid planet URL', { planetUrl: 'ftp://example.com/planet.osm.pbf' }, /http/],
    ['an uppercase planet SHA', { planetSha256: 'A'.repeat(64) }, /lowercase/],
    ['an impossible planet date', { planetDate: '2026-02-31' }, /calendar date/],
    ['a traversing output directory', { outputDir: '../dist' }, /--output-dir/],
    ['an empty output directory', { outputDir: '   ' }, /--output-dir/],
    ['the repository root as output directory', { outputDir: '.' }, /--output-dir/],
    [
      'an absolute output directory',
      { outputDir: path.join(repoRoot, 'tmp', 'absolute-output') },
      /--output-dir/,
    ],
  ])('rejects %s', async (_label, overrides, message) => {
    await expect(
      runBuild({
        repoRoot,
        only: 'pois',
        log: () => {},
        warn: () => {},
        ...overrides,
      }),
    ).rejects.toThrow(message);
  });

  it('rejects a fixture whose actual hash differs from the fixture manifest', async () => {
    const root = await makeTemp();
    const fixturePath = path.join(root, 'broken.osm.pbf');
    await writeFile(fixturePath, 'fixture payload', 'utf8');
    await writeFile(
      path.join(root, 'broken.manifest.json'),
      JSON.stringify({ sha256: 'a'.repeat(64), extractDate: '2026-10-29' }),
      'utf8',
    );

    await expect(
      runBuild({
        repoRoot,
        only: 'pois',
        fixture: fixturePath,
        outputDir: relativeOutputDir(root),
        log: () => {},
        warn: () => {},
      }),
    ).rejects.toThrow(/Fixture checksum mismatch/);
  });

  it('rejects a local planet PBF whose actual hash is stale', async () => {
    const root = await makeTemp();
    const pbfPath = path.join(root, 'planet.osm.pbf');
    await writeFile(pbfPath, 'planet payload', 'utf8');

    await expect(
      runBuild({
        repoRoot,
        only: 'pois',
        planetPbf: pbfPath,
        planetDate: '2026-10-29',
        planetSha256: 'a'.repeat(64),
        outputDir: relativeOutputDir(root),
        log: () => {},
        warn: () => {},
      }),
    ).rejects.toThrow(/Planet PBF checksum mismatch/);
  });
});

describe('runBuild --skip-build', () => {
  it('verifies a supplied archive without resolving Java, osmium or the planet', async () => {
    const root = await makeTemp();
    const archivePath = await makeArchive(root);
    const execFileImpl = await makeToolMocks(root);

    const [result] = await runSkipBuild({ root, archivePath, execFileImpl });

    expect(result.buildId).toMatch(/^fixture-[a-f0-9]{12}$/);
    expect(result.archivePath).toBe(
      path.join(root, 'out', result.buildId, 'pois', 'current.pmtiles'),
    );

    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(manifest.verification).toMatchObject({ ok: false, skipped: true });
    expect(manifest.skips).toMatchObject({ build: true, verify: true });
    expect(manifest.archive.path).toBe('current.pmtiles');
    expect(manifest.archive.metadata.osmReplicationTime).toBe('2026-10-29T20:21:00Z');
    expect(manifest.samples).toEqual([]);

    const entries = await readdir(path.dirname(result.archivePath));
    expect(entries.sort()).toEqual(['build.json', 'current.pmtiles']);
  });

  it('still enforces the size floor when verification is skipped', async () => {
    const root = await makeTemp();
    const archivePath = await makeArchive(root, 100);
    const execFileImpl = await makeToolMocks(root);

    await expect(runSkipBuild({ root, archivePath, execFileImpl })).rejects.toThrow(
      /below the size floor/,
    );
  });

  it('refuses to install when verification was skipped', async () => {
    const root = await makeTemp();
    const archivePath = await makeArchive(root);
    const execFileImpl = await makeToolMocks(root);

    await expect(runSkipBuild({ root, archivePath, execFileImpl, install: true })).rejects.toThrow(
      /Refusing to install/,
    );
  });

  it('uses an installed sidecar for the build ID, planet metadata and date', async () => {
    const root = await makeTemp();
    const archivePath = await makeArchive(root);
    const execFileImpl = await makeToolMocks(root);
    const archiveSha256 = sha256Text(await readFile(archivePath));
    const sidecar = {
      buildId: `20261028-${archiveSha256.slice(0, 12)}`,
      mode: 'planet',
      planet: {
        date: '2026-10-28',
        url: 'https://example.com/planet.osm.pbf',
        sha256: 'b'.repeat(64),
      },
      fixture: null,
      archive: { sha256: archiveSha256 },
    };
    await writeFile(
      path.join(path.dirname(archivePath), 'current.json'),
      JSON.stringify(sidecar),
      'utf8',
    );

    const configPath = await writeFailureConfig(root, { planetFloor: 4096 });
    const [result] = await runSkipBuild({
      root,
      archivePath,
      execFileImpl,
      configPath,
      fixture: undefined,
    });

    expect(result.buildId).toBe(sidecar.buildId);

    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(manifest.mode).toBe('planet');
    expect(manifest.planet).toMatchObject({
      date: '2026-10-28',
      url: 'https://example.com/planet.osm.pbf',
      sha256: 'b'.repeat(64),
    });
  });

  it('recomputes a format-valid sidecar build ID that does not match the archive hash', async () => {
    const root = await makeTemp();
    const archivePath = await makeArchive(root);
    const execFileImpl = await makeToolMocks(root);
    const archiveSha256 = sha256Text(await readFile(archivePath));
    const mismatchedBuildId = 'fixture-aaaaaaaaaaaa';
    expect(mismatchedBuildId.slice(-12)).not.toBe(archiveSha256.slice(0, 12));
    await writeFile(
      path.join(path.dirname(archivePath), 'current.json'),
      JSON.stringify({
        buildId: mismatchedBuildId,
        mode: 'fixture',
        planet: { date: '', url: '', sha256: '' },
        fixture: null,
        archive: { sha256: archiveSha256 },
      }),
      'utf8',
    );

    const [result] = await runSkipBuild({ root, archivePath, execFileImpl });

    const expectedBuildId = `fixture-${archiveSha256.slice(0, 12)}`;
    expect(result.buildId).toBe(expectedBuildId);

    const written = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(written.buildId).toBe(expectedBuildId);
    expect(written.buildId).not.toBe(mismatchedBuildId);
  });

  it('does not use an installed sidecar build ID to escape the output directory', async () => {
    const root = await makeTemp();
    const archivePath = await makeArchive(root);
    const execFileImpl = await makeToolMocks(root);
    const archiveSha256 = sha256Text(await readFile(archivePath));
    await writeFile(
      path.join(path.dirname(archivePath), 'current.json'),
      JSON.stringify({
        buildId: '..',
        mode: 'planet',
        planet: { date: '2026-10-28', url: '', sha256: '' },
        fixture: null,
        archive: { sha256: archiveSha256 },
      }),
      'utf8',
    );

    const escapedDirectory = path.join(root, 'pois');
    await mkdir(escapedDirectory, { recursive: true });
    await writeFile(path.join(escapedDirectory, 'sentinel.txt'), 'keep me', 'utf8');
    const configPath = await writeFailureConfig(root, { planetFloor: 4096 });

    const [result] = await runSkipBuild({
      root,
      archivePath,
      execFileImpl,
      configPath,
      fixture: undefined,
    });

    const expectedBuildId = `20261028-${archiveSha256.slice(0, 12)}`;
    const expectedArchivePath = path.join(root, 'out', expectedBuildId, 'pois', 'current.pmtiles');
    expect(result.buildId).toBe(expectedBuildId);
    expect(result.archivePath).toBe(expectedArchivePath);
    expect(await pathExists(expectedArchivePath)).toBe(true);

    const written = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(written.buildId).toBe(expectedBuildId);
    expect(written.archive.path).toBe('current.pmtiles');
    expect(path.resolve(path.dirname(result.manifestPath), written.archive.path)).toBe(
      expectedArchivePath,
    );

    expect(await readFile(path.join(escapedDirectory, 'sentinel.txt'), 'utf8')).toBe('keep me');
    expect(await readdir(escapedDirectory)).toEqual(['sentinel.txt']);
  });

  it('ignores a sidecar build ID containing a path separator', async () => {
    const root = await makeTemp();
    const archivePath = await makeArchive(root);
    const execFileImpl = await makeToolMocks(root);
    const archiveSha256 = sha256Text(await readFile(archivePath));
    await writeFile(
      path.join(path.dirname(archivePath), 'current.json'),
      JSON.stringify({
        buildId: '../escape',
        mode: 'planet',
        planet: { date: '2026-10-28', url: '', sha256: '' },
        fixture: null,
        archive: { sha256: archiveSha256 },
      }),
      'utf8',
    );
    const configPath = await writeFailureConfig(root, { planetFloor: 4096 });

    const [result] = await runSkipBuild({
      root,
      archivePath,
      execFileImpl,
      configPath,
      fixture: undefined,
    });

    expect(result.buildId).toBe(`20261028-${archiveSha256.slice(0, 12)}`);
    expect(result.archivePath).toContain(path.join(root, 'out') + path.sep);
  });

  it('records unknown fixture provenance for a raw archive with --fixture and no manifest', async () => {
    const root = await makeTemp();
    const archivePath = await makeArchive(root);
    const fixturePath = path.join(root, 'raw.osm.pbf');
    await writeFile(fixturePath, 'raw fixture payload', 'utf8');
    const execFileImpl = await makeToolMocks(root);

    const [result] = await runSkipBuild({
      root,
      archivePath,
      execFileImpl,
      fixture: fixturePath,
    });

    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(manifest.mode).toBe('fixture');
    expect(manifest.fixture).toMatchObject({
      extractDate: '',
      bbox: [],
      manifest: '',
      sourceUrl: '',
    });
    expect(manifest.fixture.sha256).toHaveLength(64);
  });

  it('records fixture manifest provenance for a raw archive with --fixture', async () => {
    const root = await makeTemp();
    const archivePath = await makeArchive(root);
    const execFileImpl = await makeToolMocks(root);

    const [result] = await runSkipBuild({ root, archivePath, execFileImpl });

    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(manifest.fixture).toMatchObject({
      path: 'test/fixtures/alberta-canmore.osm.pbf',
      extractDate: '2026-10-29',
      bbox: [-115.65, 50.95, -115.05, 51.35],
    });
  });

  it('rejects a fixture manifest whose bbox is not a four-number array', async () => {
    const root = await makeTemp();
    const archivePath = await makeArchive(root);
    const fixturePath = path.join(root, 'broken.osm.pbf');
    await writeFile(fixturePath, 'raw fixture payload', 'utf8');
    await writeFile(
      path.join(root, 'broken.manifest.json'),
      JSON.stringify({ extractDate: '2026-10-29', bbox: 'not-an-array' }),
      'utf8',
    );
    const execFileImpl = await makeToolMocks(root);

    await expect(
      runSkipBuild({ root, archivePath, execFileImpl, fixture: fixturePath }),
    ).rejects.toThrow(/four-number array/);
  });

  it('requires a planet date for planet-mode archive builds', async () => {
    const root = await makeTemp();
    const archivePath = await makeArchive(root);
    const execFileImpl = await makeToolMocks(root);

    await expect(
      runSkipBuild({ root, archivePath, execFileImpl, fixture: undefined }),
    ).rejects.toThrow(/planet date is required/i);
  });

  it('deduplicates repeated --only source names', async () => {
    const root = await makeTemp();
    const archivePath = await makeArchive(root);
    const execFileImpl = await makeToolMocks(root);

    const results = await runSkipBuild({
      root,
      archivePath,
      execFileImpl,
      only: 'pois,pois',
    });

    expect(results).toHaveLength(1);
    expect(results[0].source).toBe('pois');
  });

  it('requires an archive when none can be found', async () => {
    const root = await makeTemp();
    const execFileImpl = await makeToolMocks(root);

    await expect(
      runBuild({
        repoRoot,
        only: 'pois',
        fixture: 'test/fixtures/alberta-canmore.osm.pbf',
        outputDir: relativeOutputDir(root),
        skipBuild: true,
        skipVerify: true,
        execFileImpl,
        log: () => {},
        warn: () => {},
      }),
    ).rejects.toThrow(/--skip-build requires an existing archive/);
  });
});
