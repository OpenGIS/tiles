import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const helpersDir = path.dirname(fileURLToPath(import.meta.url));

export const repoRoot = path.resolve(helpersDir, '..', '..');
export const tmpRoot = path.join(repoRoot, 'tmp');
export const fixturePath = path.join(repoRoot, 'test', 'fixtures', 'pois.pmtiles');
export const fixtureManifestPath = path.join(repoRoot, 'test', 'fixtures', 'manifest.json');

async function writeSidecar(archiveDir, filename, buildId) {
  if (buildId === null) {
    return;
  }
  await writeFile(path.join(archiveDir, filename), JSON.stringify({ buildId }), 'utf8');
}

export async function createTempDirectory(prefix = 'tiles-test-') {
  await mkdir(tmpRoot, { recursive: true });
  return mkdtemp(path.join(tmpRoot, prefix));
}

export async function removeTempDirectory(directory) {
  await rm(directory, { recursive: true, force: true });
}

export async function createTempData({
  current = true,
  previous = false,
  currentBuildId = 'build-current',
  previousBuildId = 'build-previous',
} = {}) {
  const root = await createTempDirectory('tiles-data-');
  const dataDir = path.join(root, 'data', 'pois');
  await mkdir(dataDir, { recursive: true });

  if (current) {
    await copyFile(fixturePath, path.join(dataDir, 'current.pmtiles'));
    await writeSidecar(dataDir, 'current.json', currentBuildId);
  }

  if (previous) {
    await copyFile(fixturePath, path.join(dataDir, 'previous.pmtiles'));
    await writeSidecar(dataDir, 'previous.json', previousBuildId);
  }

  return {
    root,
    dataDir,
    async cleanup() {
      await removeTempDirectory(root);
    },
  };
}
