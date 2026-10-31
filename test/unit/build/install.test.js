import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { sha256Text } from '../../../src/build/fs.mjs';
import { installArchive, installArchives } from '../../../src/build/install.mjs';
import { createTempDirectory, removeTempDirectory } from '../../helpers/temp.mjs';

const created = [];

async function makeTemp() {
  const root = await createTempDirectory('tiles-build-install-');
  created.push(root);
  return root;
}

function manifest(buildId, archiveSha256) {
  return `${JSON.stringify({ buildId, archive: { sha256: archiveSha256 } }, null, 2)}\n`;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => removeTempDirectory(directory)));
});

describe('installArchive', () => {
  it('promotes a new archive and keeps the previous pair', async () => {
    const root = await makeTemp();
    const dataDir = path.join(root, 'data', 'pois');
    const buildDir = path.join(root, 'build');
    await mkdir(dataDir, { recursive: true });
    await mkdir(buildDir, { recursive: true });

    const archivePath = path.join(buildDir, 'current.pmtiles');
    const manifestPath = path.join(buildDir, 'build.json');
    await writeFile(archivePath, 'new archive', 'utf8');
    await writeFile(manifestPath, manifest('new', 'a'.repeat(64)), 'utf8');

    const oldContents = 'old archive';
    const oldBuildId = `20261028-${sha256Text(oldContents).slice(0, 12)}`;
    await writeFile(path.join(dataDir, 'current.pmtiles'), oldContents, 'utf8');
    await writeFile(
      path.join(dataDir, 'current.json'),
      manifest(oldBuildId, sha256Text(oldContents)),
      'utf8',
    );

    const installed = await installArchive({ archivePath, manifestPath, dataDir });

    expect(await readFile(path.join(dataDir, 'current.pmtiles'), 'utf8')).toBe('new archive');
    const current = JSON.parse(await readFile(path.join(dataDir, 'current.json'), 'utf8'));
    expect(current.buildId).toBe('new');
    expect(current.archive.path).toBe('current.pmtiles');
    expect(await readFile(path.join(dataDir, 'previous.pmtiles'), 'utf8')).toBe(oldContents);
    const previous = JSON.parse(await readFile(path.join(dataDir, 'previous.json'), 'utf8'));
    expect(previous.buildId).toBe(oldBuildId);
    expect(installed.previousArchive).toBe(path.join(dataDir, 'previous.pmtiles'));
    expect(installed.previousManifest).toBe(path.join(dataDir, 'previous.json'));
  });

  it('installs into an empty data directory without a previous pair', async () => {
    const root = await makeTemp();
    const dataDir = path.join(root, 'data', 'pois');
    const buildDir = path.join(root, 'build');
    await mkdir(buildDir, { recursive: true });

    const archivePath = path.join(buildDir, 'current.pmtiles');
    const manifestPath = path.join(buildDir, 'build.json');
    await writeFile(archivePath, 'archive', 'utf8');
    await writeFile(manifestPath, manifest('first', 'c'.repeat(64)), 'utf8');

    const installed = await installArchive({ archivePath, manifestPath, dataDir });

    expect(await readFile(path.join(dataDir, 'current.pmtiles'), 'utf8')).toBe('archive');
    expect(installed.previousArchive).toBeNull();
    expect(installed.previousManifest).toBeNull();
  });

  it('skips rotation when the build ID and archive hash are unchanged', async () => {
    const root = await makeTemp();
    const dataDir = path.join(root, 'data', 'pois');
    const buildDir = path.join(root, 'build');
    await mkdir(dataDir, { recursive: true });
    await mkdir(buildDir, { recursive: true });

    const archivePath = path.join(buildDir, 'current.pmtiles');
    const manifestPath = path.join(buildDir, 'build.json');
    await writeFile(archivePath, 'first archive', 'utf8');
    await writeFile(manifestPath, manifest('same', sha256Text('first archive')), 'utf8');

    await installArchive({ archivePath, manifestPath, dataDir });
    await writeFile(path.join(dataDir, 'previous.pmtiles'), 'sentinel', 'utf8');
    await writeFile(archivePath, 'second archive', 'utf8');

    const installed = await installArchive({ archivePath, manifestPath, dataDir });

    expect(installed.skipped).toBe(true);
    expect(await readFile(path.join(dataDir, 'current.pmtiles'), 'utf8')).toBe('first archive');
    expect(await readFile(path.join(dataDir, 'previous.pmtiles'), 'utf8')).toBe('sentinel');
  });

  it('reinstalls when the current archive is corrupt despite a matching sidecar', async () => {
    const root = await makeTemp();
    const dataDir = path.join(root, 'data', 'pois');
    const buildDir = path.join(root, 'build');
    await mkdir(buildDir, { recursive: true });

    const archivePath = path.join(buildDir, 'current.pmtiles');
    const manifestPath = path.join(buildDir, 'build.json');
    const contents = 'first archive';
    const sha256 = sha256Text(contents);
    await writeFile(archivePath, contents, 'utf8');
    await writeFile(manifestPath, manifest('same', sha256), 'utf8');

    await installArchive({ archivePath, manifestPath, dataDir });
    await writeFile(path.join(dataDir, 'current.pmtiles'), 'corrupt bytes', 'utf8');

    const installed = await installArchive({ archivePath, manifestPath, dataDir });

    expect(installed.skipped).toBe(false);
    expect(await readFile(path.join(dataDir, 'current.pmtiles'), 'utf8')).toBe(contents);
  });

  it('does not replace a good previous pair when the current archive is corrupt', async () => {
    const root = await makeTemp();
    const dataDir = path.join(root, 'data', 'pois');
    const buildDir = path.join(root, 'build');
    await mkdir(dataDir, { recursive: true });
    await mkdir(buildDir, { recursive: true });

    const archivePath = path.join(buildDir, 'current.pmtiles');
    const manifestPath = path.join(buildDir, 'build.json');
    await writeFile(archivePath, 'new archive', 'utf8');
    await writeFile(manifestPath, manifest('new', sha256Text('new archive')), 'utf8');

    await writeFile(path.join(dataDir, 'current.pmtiles'), 'corrupt current', 'utf8');
    await writeFile(
      path.join(dataDir, 'current.json'),
      manifest('current', sha256Text('expected current')),
      'utf8',
    );
    await writeFile(path.join(dataDir, 'previous.pmtiles'), 'good previous', 'utf8');
    await writeFile(
      path.join(dataDir, 'previous.json'),
      manifest('previous', sha256Text('good previous')),
      'utf8',
    );

    await installArchive({ archivePath, manifestPath, dataDir });

    expect(await readFile(path.join(dataDir, 'current.pmtiles'), 'utf8')).toBe('new archive');
    expect(await readFile(path.join(dataDir, 'previous.pmtiles'), 'utf8')).toBe('good previous');
    const previous = JSON.parse(await readFile(path.join(dataDir, 'previous.json'), 'utf8'));
    expect(previous.buildId).toBe('previous');
  });

  it('does not promote a corrupt current archive when the build ID changes', async () => {
    const root = await makeTemp();
    const dataDir = path.join(root, 'data', 'pois');
    const buildDir = path.join(root, 'build');
    await mkdir(dataDir, { recursive: true });
    await mkdir(buildDir, { recursive: true });

    const archivePath = path.join(buildDir, 'current.pmtiles');
    const manifestPath = path.join(buildDir, 'build.json');
    await writeFile(archivePath, 'new archive', 'utf8');
    await writeFile(manifestPath, manifest('new', sha256Text('new archive')), 'utf8');

    await writeFile(path.join(dataDir, 'current.pmtiles'), 'corrupt current', 'utf8');
    await writeFile(
      path.join(dataDir, 'current.json'),
      manifest('old', sha256Text('expected old')),
      'utf8',
    );

    const installed = await installArchive({ archivePath, manifestPath, dataDir });

    expect(installed.previousArchive).toBeNull();
    expect(installed.previousManifest).toBeNull();
    expect((await readdir(dataDir)).sort()).toEqual(['current.json', 'current.pmtiles']);
    expect(await readFile(path.join(dataDir, 'current.pmtiles'), 'utf8')).toBe('new archive');
  });

  it('leaves the previous pair untouched when the current archive has no sidecar', async () => {
    const root = await makeTemp();
    const dataDir = path.join(root, 'data', 'pois');
    const buildDir = path.join(root, 'build');
    await mkdir(dataDir, { recursive: true });
    await mkdir(buildDir, { recursive: true });

    const archivePath = path.join(buildDir, 'current.pmtiles');
    const manifestPath = path.join(buildDir, 'build.json');
    await writeFile(archivePath, 'new archive', 'utf8');
    await writeFile(manifestPath, manifest('new', sha256Text('new archive')), 'utf8');

    await writeFile(path.join(dataDir, 'current.pmtiles'), 'orphan current', 'utf8');
    await writeFile(path.join(dataDir, 'previous.pmtiles'), 'good previous', 'utf8');
    await writeFile(
      path.join(dataDir, 'previous.json'),
      manifest('previous', sha256Text('good previous')),
      'utf8',
    );

    await installArchive({ archivePath, manifestPath, dataDir });

    expect(await readFile(path.join(dataDir, 'current.pmtiles'), 'utf8')).toBe('new archive');
    expect(await readFile(path.join(dataDir, 'previous.pmtiles'), 'utf8')).toBe('good previous');
    const previous = JSON.parse(await readFile(path.join(dataDir, 'previous.json'), 'utf8'));
    expect(previous.buildId).toBe('previous');
  });

  it('does not overwrite previous metadata when the current sidecar has no archive', async () => {
    const root = await makeTemp();
    const dataDir = path.join(root, 'data', 'pois');
    const buildDir = path.join(root, 'build');
    await mkdir(dataDir, { recursive: true });
    await mkdir(buildDir, { recursive: true });

    const archivePath = path.join(buildDir, 'current.pmtiles');
    const manifestPath = path.join(buildDir, 'build.json');
    await writeFile(archivePath, 'new archive', 'utf8');
    await writeFile(manifestPath, manifest('new', sha256Text('new archive')), 'utf8');

    await writeFile(
      path.join(dataDir, 'current.json'),
      manifest('stale', sha256Text('missing archive')),
      'utf8',
    );
    await writeFile(path.join(dataDir, 'previous.pmtiles'), 'good previous', 'utf8');
    await writeFile(
      path.join(dataDir, 'previous.json'),
      manifest('previous', sha256Text('good previous')),
      'utf8',
    );

    await installArchive({ archivePath, manifestPath, dataDir });

    expect(await readFile(path.join(dataDir, 'current.pmtiles'), 'utf8')).toBe('new archive');
    expect(await readFile(path.join(dataDir, 'previous.pmtiles'), 'utf8')).toBe('good previous');
    const previous = JSON.parse(await readFile(path.join(dataDir, 'previous.json'), 'utf8'));
    expect(previous.buildId).toBe('previous');
  });

  it('removes staged files when a later manifest cannot be read', async () => {
    const root = await makeTemp();
    const firstDataDir = path.join(root, 'data', 'pois');
    const secondDataDir = path.join(root, 'data', 'routes');
    const buildDir = path.join(root, 'build');
    await mkdir(firstDataDir, { recursive: true });
    await mkdir(buildDir, { recursive: true });

    const archivePath = path.join(buildDir, 'current.pmtiles');
    const manifestPath = path.join(buildDir, 'build.json');
    await writeFile(archivePath, 'new archive', 'utf8');
    await writeFile(manifestPath, manifest('new', sha256Text('new archive')), 'utf8');
    await writeFile(path.join(firstDataDir, 'current.pmtiles'), 'old archive', 'utf8');
    await writeFile(
      path.join(firstDataDir, 'current.json'),
      manifest('old', sha256Text('old archive')),
      'utf8',
    );

    await expect(
      installArchives([
        { archivePath, manifestPath, dataDir: firstDataDir },
        {
          archivePath,
          manifestPath: path.join(buildDir, 'missing.json'),
          dataDir: secondDataDir,
        },
      ]),
    ).rejects.toThrow(/ENOENT/);

    expect(await readFile(path.join(firstDataDir, 'current.pmtiles'), 'utf8')).toBe('old archive');
    expect((await readdir(firstDataDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(await readdir(secondDataDir)).toEqual([]);
  });

  it('rolls back the promoted archive when the second rename fails', async () => {
    const root = await makeTemp();
    const dataDir = path.join(root, 'data', 'pois');
    const buildDir = path.join(root, 'build');
    await mkdir(dataDir, { recursive: true });
    await mkdir(buildDir, { recursive: true });

    const archivePath = path.join(buildDir, 'current.pmtiles');
    const manifestPath = path.join(buildDir, 'build.json');
    await writeFile(archivePath, 'new archive', 'utf8');
    await writeFile(manifestPath, manifest('new', 'e'.repeat(64)), 'utf8');
    const oldContents = 'old archive';
    const oldBuildId = `20261028-${sha256Text(oldContents).slice(0, 12)}`;
    await writeFile(path.join(dataDir, 'current.pmtiles'), oldContents, 'utf8');
    await writeFile(
      path.join(dataDir, 'current.json'),
      manifest(oldBuildId, sha256Text(oldContents)),
      'utf8',
    );

    const fsImpl = {
      copyFile,
      mkdir,
      readFile,
      writeFile,
      stat,
      rm,
      async rename(from, to) {
        if (to.endsWith('current.json')) {
          throw new Error('simulated manifest promotion failure');
        }

        return rename(from, to);
      },
    };

    await expect(
      installArchive({ archivePath, manifestPath, dataDir }, { fsImpl }),
    ).rejects.toThrow(/simulated manifest promotion failure/);

    expect(await readFile(path.join(dataDir, 'current.pmtiles'), 'utf8')).toBe(oldContents);
    const current = JSON.parse(await readFile(path.join(dataDir, 'current.json'), 'utf8'));
    expect(current.buildId).toBe(oldBuildId);
    expect((await readdir(dataDir)).sort()).toEqual(['current.json', 'current.pmtiles']);
  });

  it('restores the current and previous pairs exactly when current promotion fails after rotation', async () => {
    const root = await makeTemp();
    const dataDir = path.join(root, 'data', 'pois');
    const buildDir = path.join(root, 'build');
    await mkdir(dataDir, { recursive: true });
    await mkdir(buildDir, { recursive: true });

    const archivePath = path.join(buildDir, 'current.pmtiles');
    const manifestPath = path.join(buildDir, 'build.json');
    await writeFile(archivePath, 'new archive', 'utf8');
    await writeFile(manifestPath, manifest('new', 'f'.repeat(64)), 'utf8');

    const currentContents = 'current archive';
    const currentBuildId = `20261028-${sha256Text(currentContents).slice(0, 12)}`;
    const currentSidecar = manifest(currentBuildId, sha256Text(currentContents));
    const previousContents = 'previous archive';
    const previousBuildId = `20261027-${sha256Text(previousContents).slice(0, 12)}`;
    const previousSidecar = manifest(previousBuildId, sha256Text(previousContents));
    await writeFile(path.join(dataDir, 'current.pmtiles'), currentContents, 'utf8');
    await writeFile(path.join(dataDir, 'current.json'), currentSidecar, 'utf8');
    await writeFile(path.join(dataDir, 'previous.pmtiles'), previousContents, 'utf8');
    await writeFile(path.join(dataDir, 'previous.json'), previousSidecar, 'utf8');

    let failureInjected = false;
    let rotated = null;
    const fsImpl = {
      copyFile,
      mkdir,
      readFile,
      writeFile,
      stat,
      rm,
      async rename(from, to) {
        if (!failureInjected && to.endsWith('current.json')) {
          rotated = {
            currentArchive: await readFile(path.join(dataDir, 'current.pmtiles'), 'utf8'),
            previousArchive: await readFile(path.join(dataDir, 'previous.pmtiles'), 'utf8'),
            previousManifest: await readFile(path.join(dataDir, 'previous.json'), 'utf8'),
          };
          failureInjected = true;
          throw new Error('simulated current manifest promotion failure');
        }

        return rename(from, to);
      },
    };

    await expect(
      installArchive({ archivePath, manifestPath, dataDir }, { fsImpl }),
    ).rejects.toThrow(/simulated current manifest promotion failure/);

    expect(rotated).not.toBeNull();
    expect(rotated.currentArchive).toBe('new archive');
    expect(rotated.previousArchive).toBe(currentContents);
    expect(rotated.previousManifest).toBe(currentSidecar);

    expect(await readFile(path.join(dataDir, 'current.pmtiles'), 'utf8')).toBe(currentContents);
    expect(await readFile(path.join(dataDir, 'current.json'), 'utf8')).toBe(currentSidecar);
    expect(await readFile(path.join(dataDir, 'previous.pmtiles'), 'utf8')).toBe(previousContents);
    expect(await readFile(path.join(dataDir, 'previous.json'), 'utf8')).toBe(previousSidecar);
    expect((await readdir(dataDir)).sort()).toEqual([
      'current.json',
      'current.pmtiles',
      'previous.json',
      'previous.pmtiles',
    ]);
  });

  it('does not rotate a current pair whose sidecar build ID is not content-addressed', async () => {
    const root = await makeTemp();
    const dataDir = path.join(root, 'data', 'pois');
    const buildDir = path.join(root, 'build');
    await mkdir(dataDir, { recursive: true });
    await mkdir(buildDir, { recursive: true });

    const archivePath = path.join(buildDir, 'current.pmtiles');
    const manifestPath = path.join(buildDir, 'build.json');
    const newContents = 'new archive';
    const newBuildId = `fixture-${sha256Text(newContents).slice(0, 12)}`;
    await writeFile(archivePath, newContents, 'utf8');
    await writeFile(manifestPath, manifest(newBuildId, sha256Text(newContents)), 'utf8');

    const currentContents = 'current archive';
    await writeFile(path.join(dataDir, 'current.pmtiles'), currentContents, 'utf8');
    await writeFile(
      path.join(dataDir, 'current.json'),
      manifest('..', sha256Text(currentContents)),
      'utf8',
    );
    const previousContents = 'previous archive';
    const previousSidecar = manifest('previous', sha256Text(previousContents));
    await writeFile(path.join(dataDir, 'previous.pmtiles'), previousContents, 'utf8');
    await writeFile(path.join(dataDir, 'previous.json'), previousSidecar, 'utf8');

    await installArchive({ archivePath, manifestPath, dataDir });

    expect(await readFile(path.join(dataDir, 'current.pmtiles'), 'utf8')).toBe(newContents);
    const current = JSON.parse(await readFile(path.join(dataDir, 'current.json'), 'utf8'));
    expect(current.buildId).toBe(newBuildId);
    expect(current.buildId).not.toBe('..');
    expect(await readFile(path.join(dataDir, 'previous.pmtiles'), 'utf8')).toBe(previousContents);
    expect(await readFile(path.join(dataDir, 'previous.json'), 'utf8')).toBe(previousSidecar);
  });

  it('does not rotate a current pair whose build ID does not match the archive hash', async () => {
    const root = await makeTemp();
    const dataDir = path.join(root, 'data', 'pois');
    const buildDir = path.join(root, 'build');
    await mkdir(dataDir, { recursive: true });
    await mkdir(buildDir, { recursive: true });

    const archivePath = path.join(buildDir, 'current.pmtiles');
    const manifestPath = path.join(buildDir, 'build.json');
    const newContents = 'new archive';
    const newBuildId = `fixture-${sha256Text(newContents).slice(0, 12)}`;
    await writeFile(archivePath, newContents, 'utf8');
    await writeFile(manifestPath, manifest(newBuildId, sha256Text(newContents)), 'utf8');

    const currentContents = 'current archive';
    const currentSha256 = sha256Text(currentContents);
    const mismatchedPrefix = `${currentSha256[0] === 'a' ? 'b' : 'a'}${currentSha256.slice(1, 12)}`;
    const mismatchedBuildId = `fixture-${mismatchedPrefix}`;
    expect(mismatchedBuildId).toMatch(/^fixture-[a-f0-9]{12}$/);
    expect(mismatchedPrefix).not.toBe(currentSha256.slice(0, 12));
    await writeFile(path.join(dataDir, 'current.pmtiles'), currentContents, 'utf8');
    await writeFile(
      path.join(dataDir, 'current.json'),
      manifest(mismatchedBuildId, currentSha256),
      'utf8',
    );

    const previousContents = 'previous archive';
    const previousSidecar = manifest('previous', sha256Text(previousContents));
    await writeFile(path.join(dataDir, 'previous.pmtiles'), previousContents, 'utf8');
    await writeFile(path.join(dataDir, 'previous.json'), previousSidecar, 'utf8');

    await installArchive({ archivePath, manifestPath, dataDir });

    expect(await readFile(path.join(dataDir, 'current.pmtiles'), 'utf8')).toBe(newContents);
    const current = JSON.parse(await readFile(path.join(dataDir, 'current.json'), 'utf8'));
    expect(current.buildId).toBe(newBuildId);
    expect(await readFile(path.join(dataDir, 'previous.pmtiles'), 'utf8')).toBe(previousContents);
    expect(await readFile(path.join(dataDir, 'previous.json'), 'utf8')).toBe(previousSidecar);
  });
});
