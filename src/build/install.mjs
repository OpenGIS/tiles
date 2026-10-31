import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isBuildId } from './build-id.mjs';
import { sha256File } from './fs.mjs';

const defaultFs = { copyFile, mkdir, readFile, rename, rm, stat, writeFile };

async function pathExists(fsImpl, target) {
  if (typeof target !== 'string' || target === '') {
    return false;
  }

  try {
    await fsImpl.stat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function temporaryPath(target) {
  return `${target}.${process.pid}.tmp`;
}

function backupPath(target) {
  return `${target}.${process.pid}.backup.tmp`;
}

async function readJson(fsImpl, target) {
  try {
    return JSON.parse(await fsImpl.readFile(target, 'utf8'));
  } catch {
    return null;
  }
}

async function stagePair(fsImpl, entry) {
  const { archivePath, manifestPath, dataDir, currentArchive, currentManifest } = entry;
  const temporaryArchive = temporaryPath(currentArchive);
  const temporaryManifest = temporaryPath(currentManifest);

  const manifest = JSON.parse(await fsImpl.readFile(manifestPath, 'utf8'));
  manifest.archive = {
    ...manifest.archive,
    path: path.relative(dataDir, currentArchive).split(path.sep).join('/'),
  };

  try {
    await fsImpl.copyFile(archivePath, temporaryArchive);
    await fsImpl.writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  } catch (error) {
    await fsImpl.rm(temporaryArchive, { force: true }).catch(() => {});
    await fsImpl.rm(temporaryManifest, { force: true }).catch(() => {});
    throw error;
  }

  return {
    ...entry,
    manifest,
    temporaryArchive,
    temporaryManifest,
  };
}

async function promoteFile(fsImpl, source, target) {
  const temporary = temporaryPath(target);

  try {
    await fsImpl.copyFile(source, temporary);
    await fsImpl.rename(temporary, target);
  } catch (error) {
    await fsImpl.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function restoreFile(fsImpl, backup, target, existed) {
  if (existed) {
    if (await pathExists(fsImpl, backup)) {
      await promoteFile(fsImpl, backup, target);
    }
    return;
  }

  await fsImpl.rm(target, { force: true });
}

async function removeTemporaryFiles(fsImpl, entry) {
  const targets = [
    entry.temporaryArchive,
    entry.temporaryManifest,
    entry.backupArchive,
    entry.backupManifest,
    entry.backupPreviousArchive,
    entry.backupPreviousManifest,
  ];

  for (const target of targets) {
    if (typeof target === 'string' && target !== '') {
      await fsImpl.rm(target, { force: true }).catch(() => {});
    }
  }
}

async function rollback(fsImpl, prepared) {
  for (const entry of [...prepared].reverse()) {
    await restoreFile(fsImpl, entry.backupArchive, entry.currentArchive, entry.hadArchive).catch(
      () => {},
    );
    await restoreFile(fsImpl, entry.backupManifest, entry.currentManifest, entry.hadManifest).catch(
      () => {},
    );
    await restoreFile(
      fsImpl,
      entry.backupPreviousArchive,
      entry.previousArchive,
      entry.hadPreviousArchive,
    ).catch(() => {});
    await restoreFile(
      fsImpl,
      entry.backupPreviousManifest,
      entry.previousManifest,
      entry.hadPreviousManifest,
    ).catch(() => {});
    await removeTemporaryFiles(fsImpl, entry);
  }
}

export async function installArchives(entries, { fsImpl = defaultFs } = {}) {
  const prepared = [];

  try {
    for (const rawEntry of entries) {
      const dataDir = rawEntry.dataDir;
      await fsImpl.mkdir(dataDir, { recursive: true });

      const currentArchive = path.join(dataDir, 'current.pmtiles');
      const currentManifest = path.join(dataDir, 'current.json');
      const previousArchive = path.join(dataDir, 'previous.pmtiles');
      const previousManifest = path.join(dataDir, 'previous.json');

      const newManifest = JSON.parse(await fsImpl.readFile(rawEntry.manifestPath, 'utf8'));
      const currentInstalled = await readJson(fsImpl, currentManifest);
      const currentArchiveExists = await pathExists(fsImpl, currentArchive);
      const currentManifestExists = await pathExists(fsImpl, currentManifest);
      const sameBuildId =
        currentInstalled?.buildId !== undefined && currentInstalled.buildId === newManifest.buildId;

      let unchanged = false;

      if (sameBuildId && currentArchiveExists) {
        const actualSha256 = await sha256File(currentArchive);
        const expectedSha256 = newManifest.archive?.sha256;
        const sidecarSha256 = currentInstalled?.archive?.sha256;

        unchanged =
          typeof expectedSha256 === 'string' &&
          expectedSha256 !== '' &&
          actualSha256 === expectedSha256 &&
          (typeof sidecarSha256 !== 'string' || sidecarSha256 === actualSha256);
      }

      const baseEntry = {
        ...rawEntry,
        dataDir,
        currentArchive,
        currentManifest,
        previousArchive,
        previousManifest,
        backupArchive: backupPath(currentArchive),
        backupManifest: backupPath(currentManifest),
        backupPreviousArchive: backupPath(previousArchive),
        backupPreviousManifest: backupPath(previousManifest),
        skipped: unchanged,
        hadArchive: currentArchiveExists,
        hadManifest: currentManifestExists,
        hadPreviousArchive: await pathExists(fsImpl, previousArchive),
        hadPreviousManifest: await pathExists(fsImpl, previousManifest),
        shouldRotate: false,
      };

      if (unchanged) {
        prepared.push(baseEntry);
        continue;
      }

      const currentSha256 = currentArchiveExists ? await sha256File(currentArchive) : '';
      const currentBuildIdIsContentAddressed =
        isBuildId(currentInstalled?.buildId) &&
        currentInstalled.buildId.slice(-12) === currentSha256.slice(0, 12);
      const currentPairValid =
        currentArchiveExists &&
        currentManifestExists &&
        currentBuildIdIsContentAddressed &&
        typeof currentInstalled?.archive?.sha256 === 'string' &&
        currentInstalled.archive.sha256 === currentSha256;

      const entry = {
        ...baseEntry,
        shouldRotate: currentPairValid && currentInstalled.buildId !== newManifest.buildId,
      };

      const staged = await stagePair(fsImpl, entry);
      prepared.push(staged);
    }

    const changed = prepared.filter((entry) => !entry.skipped);

    for (const entry of changed) {
      if (entry.hadArchive) {
        await promoteFile(fsImpl, entry.currentArchive, entry.backupArchive);
      }
      if (entry.hadManifest) {
        await promoteFile(fsImpl, entry.currentManifest, entry.backupManifest);
      }
      if (entry.hadPreviousArchive) {
        await promoteFile(fsImpl, entry.previousArchive, entry.backupPreviousArchive);
      }
      if (entry.hadPreviousManifest) {
        await promoteFile(fsImpl, entry.previousManifest, entry.backupPreviousManifest);
      }
    }

    for (const entry of changed) {
      if (!entry.shouldRotate) {
        continue;
      }

      await promoteFile(fsImpl, entry.currentArchive, entry.previousArchive);
      await promoteFile(fsImpl, entry.currentManifest, entry.previousManifest);
    }

    for (const entry of changed) {
      await fsImpl.rename(entry.temporaryArchive, entry.currentArchive);
      await fsImpl.rename(entry.temporaryManifest, entry.currentManifest);
    }

    for (const entry of changed) {
      await removeTemporaryFiles(fsImpl, entry);
    }
  } catch (error) {
    await rollback(
      fsImpl,
      prepared.filter((entry) => !entry.skipped),
    );
    throw error;
  }

  return prepared.map((entry) => ({
    currentArchive: entry.currentArchive,
    currentManifest: entry.currentManifest,
    previousArchive:
      entry.skipped || (!entry.shouldRotate && !entry.hadPreviousArchive)
        ? null
        : entry.previousArchive,
    previousManifest:
      entry.skipped || (!entry.shouldRotate && !entry.hadPreviousManifest)
        ? null
        : entry.previousManifest,
    skipped: entry.skipped,
  }));
}

export async function installArchive({ archivePath, manifestPath, dataDir }, options = {}) {
  const [installed] = await installArchives([{ archivePath, manifestPath, dataDir }], options);

  return installed;
}
