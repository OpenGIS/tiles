import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isBuildId } from '../build/build-id.mjs';
import { sha256File } from '../build/fs.mjs';
import { installArchive } from '../build/install.mjs';

import { DeployError } from './config.mjs';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const PAIR_FILES = ['current.pmtiles', 'current.json', 'previous.pmtiles', 'previous.json'];
const defaultFs = { copyFile, mkdir, readFile, rename, rm, stat, writeFile };

async function pathExists(fsImpl, target) {
  try {
    await fsImpl.stat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

function requireSource(source) {
  if (typeof source !== 'string' || !SOURCE_NAME_PATTERN.test(source)) {
    throw new DeployError(`Source "${source}" is invalid; names must match ${SOURCE_NAME_PATTERN}`);
  }

  return source;
}

function dataDirectory({ dataDir, appDir }) {
  if (typeof dataDir === 'string' && dataDir !== '') {
    return path.resolve(dataDir);
  }

  return path.join(path.resolve(appDir ?? '/opt/ogis-tiles'), 'data');
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function resolveSourceDirectory({ name, layers, appDir, dataDir }) {
  const dataRoot = dataDirectory({ dataDir, appDir });

  if (layers === undefined || layers === null) {
    return path.join(dataRoot, name);
  }

  if (typeof layers !== 'object' || typeof layers.sources !== 'object' || layers.sources === null) {
    throw new DeployError('A layers configuration with sources is required to resolve archives');
  }

  if (!Object.hasOwn(layers.sources, name)) {
    throw new DeployError(`Unknown source "${name}"; it is not configured in layers.json`);
  }

  const source = layers.sources[name];
  if (source?.kind !== 'pmtiles') {
    throw new DeployError(`Source "${name}" is not a pmtiles source and cannot be promoted`);
  }

  if (typeof source.archiveDir !== 'string' || source.archiveDir.trim() === '') {
    throw new DeployError(`Source "${name}" does not configure an archiveDir`);
  }

  const appRoot = path.resolve(appDir ?? path.dirname(dataRoot));
  const archive = path.isAbsolute(source.archiveDir)
    ? path.normalize(source.archiveDir)
    : path.resolve(appRoot, source.archiveDir);
  const insideApp = archive !== appRoot && isWithin(appRoot, archive);
  const insideData = archive !== dataRoot && isWithin(dataRoot, archive);

  if (!insideApp && !insideData) {
    throw new DeployError(
      `Source "${name}" archiveDir "${archive}" is outside the app and data directories`,
    );
  }

  return archive;
}

function assertNoIncomingOverlap({ dataRoot, incomingRoot, sourceDir, incomingSourceDir }) {
  if (incomingRoot === dataRoot) {
    throw new DeployError('TILE_INCOMING_DIR must not be the data directory');
  }

  if (isWithin(sourceDir, incomingSourceDir) || isWithin(incomingSourceDir, sourceDir)) {
    throw new DeployError(
      `Incoming directory "${incomingRoot}" overlaps the live source directory "${sourceDir}"; ` +
        'refusing to promote because it could delete current files',
    );
  }
}

async function requestJson({ fetchImpl, url, label, timeoutMs }) {
  let response;

  try {
    response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    throw new DeployError(`${label} request to ${url} failed: ${error.message}`, { cause: error });
  }

  if (response.status !== 200) {
    throw new DeployError(`${label} ${url} returned HTTP ${response.status}; expected 200`);
  }

  try {
    return await response.json();
  } catch (error) {
    throw new DeployError(`${label} ${url} did not return valid JSON: ${error.message}`, {
      cause: error,
    });
  }
}

export async function verifyPromotedSource({
  fetchImpl = globalThis.fetch,
  healthUrl,
  source,
  buildId,
  timeoutMs = 5_000,
  label = 'Promoted source',
} = {}) {
  await requestJson({ fetchImpl, url: `${healthUrl}/ready`, label: 'Ready check', timeoutMs });

  const payload = await requestJson({
    fetchImpl,
    url: `${healthUrl}/sources`,
    label: 'Sources check',
    timeoutMs,
  });
  const entry = Array.isArray(payload?.sources)
    ? payload.sources.find((candidate) => candidate?.name === source)
    : null;

  if (!entry) {
    throw new DeployError(`${label} "${source}" is missing from /sources`);
  }

  if (entry.available !== true) {
    throw new DeployError(`${label} "${source}" is not available after the swap`);
  }

  if (entry.buildId !== buildId) {
    throw new DeployError(
      `${label} "${source}" reports build "${entry.buildId ?? 'none'}", expected "${buildId}"`,
    );
  }

  return entry;
}

async function readJson(fsImpl, target, label) {
  let contents;

  try {
    contents = await fsImpl.readFile(target, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new DeployError(`${label} is missing: ${target}`);
    }

    throw new DeployError(`Unable to read ${label} at ${target}: ${error.message}`, {
      cause: error,
    });
  }

  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new DeployError(`${label} at ${target} is not valid JSON: ${error.message}`, {
      cause: error,
    });
  }
}

function validateManifest({ manifest, actualSha256, label }) {
  const buildId = manifest?.buildId;

  if (!isBuildId(buildId)) {
    throw new DeployError(`${label} must contain a content-addressed buildId`);
  }

  const declared = manifest?.archive?.sha256;
  if (typeof declared !== 'string' || !SHA256_PATTERN.test(declared)) {
    throw new DeployError(`${label} must contain a lowercase 64 character archive SHA-256`);
  }

  if (declared !== actualSha256) {
    throw new DeployError(
      `${label} archive SHA-256 is ${actualSha256}, but the manifest declares ${declared}`,
    );
  }

  if (buildId.slice(-12) !== actualSha256.slice(0, 12)) {
    throw new DeployError(
      `${label} buildId "${buildId}" is not content-addressed by the archive SHA-256`,
    );
  }

  return { buildId, archiveSha256: actualSha256 };
}

async function inspectPair({ sourceDir, fsImpl, label }) {
  const archivePath = path.join(sourceDir, 'current.pmtiles');
  const buildJson = path.join(sourceDir, 'build.json');
  const currentJson = path.join(sourceDir, 'current.json');

  if (!(await pathExists(fsImpl, archivePath))) {
    throw new DeployError(`${label} is missing: ${archivePath}`);
  }

  let manifestPath = buildJson;
  if (!(await pathExists(fsImpl, buildJson))) {
    manifestPath = currentJson;
  }

  const manifest = await readJson(fsImpl, manifestPath, `${label} manifest`);
  const actualSha256 = await sha256File(archivePath);
  const identity = validateManifest({ manifest, actualSha256, label });

  return { archivePath, manifestPath, manifest, ...identity };
}

async function inspectInstalledPair({ sourceDir, fsImpl, kind }) {
  const archivePath = path.join(sourceDir, `${kind}.pmtiles`);
  const manifestPath = path.join(sourceDir, `${kind}.json`);

  if (!(await pathExists(fsImpl, archivePath))) {
    throw new DeployError(`${kind} archive is missing: ${archivePath}`);
  }

  if (!(await pathExists(fsImpl, manifestPath))) {
    throw new DeployError(`${kind} sidecar is missing: ${manifestPath}`);
  }

  const manifest = await readJson(fsImpl, manifestPath, `${kind} sidecar`);
  const actualSha256 = await sha256File(archivePath);
  const identity = validateManifest({ manifest, actualSha256, label: `${kind} sidecar` });

  return { archivePath, manifestPath, manifest, ...identity };
}

async function snapshotPairs(fsImpl, sourceDir) {
  const backupDir = path.join(sourceDir, `.deploy-backup-${randomUUID()}`);
  await fsImpl.mkdir(backupDir, { recursive: true });

  const present = {};
  for (const name of PAIR_FILES) {
    const target = path.join(sourceDir, name);
    if (await pathExists(fsImpl, target)) {
      await fsImpl.copyFile(target, path.join(backupDir, name));
      present[name] = true;
    }
  }

  return { sourceDir, backupDir, present };
}

async function restorePairs(fsImpl, snapshot) {
  for (const name of PAIR_FILES) {
    const target = path.join(snapshot.sourceDir, name);
    const backup = path.join(snapshot.backupDir, name);
    await fsImpl.rm(target, { force: true });

    if (snapshot.present[name]) {
      await fsImpl.copyFile(backup, target);
    }
  }
}

async function removeSnapshot(fsImpl, snapshot) {
  await fsImpl.rm(snapshot.backupDir, { recursive: true, force: true });
}

async function consumeIncoming(fsImpl, { archivePath, manifestPath }) {
  const candidates = new Set([
    archivePath,
    manifestPath,
    path.join(path.dirname(archivePath), 'build.json'),
    path.join(path.dirname(archivePath), 'current.json'),
  ]);

  for (const target of candidates) {
    await fsImpl.rm(target, { force: true });
  }
}

async function restartAfterRestore({ restart, smoke }, label) {
  try {
    await restart();
    await smoke();
  } catch (error) {
    throw new DeployError(
      `${label} was restored, but the service did not recover: ${error.message}`,
      { cause: error },
    );
  }
}

async function failWithRestore({
  fsImpl,
  snapshot,
  restart,
  smoke,
  err,
  error,
  action,
  actionWord,
  sourceName,
}) {
  let restoreError = null;

  try {
    await restorePairs(fsImpl, snapshot);
  } catch (caught) {
    restoreError = caught;
  }

  if (!restoreError) {
    await removeSnapshot(fsImpl, snapshot).catch(() => {});
  }

  const retainedNotice = restoreError
    ? ` The deployment snapshot was retained at ${snapshot.backupDir} for manual recovery.`
    : '';

  if (restoreError) {
    err.write(
      `${action} of "${sourceName}" failed: ${error.message}. ` +
        `Restoring the previous pair also failed: ${restoreError.message}.` +
        `${retainedNotice}\n`,
    );
  }

  let recoveryError = null;

  try {
    if (restoreError) {
      await restart();
      await smoke();
    } else {
      await restartAfterRestore({ restart, smoke }, `After a failed ${sourceName} ${actionWord}`);
    }
  } catch (caught) {
    recoveryError = caught;
  }

  if (restoreError) {
    throw new DeployError(
      `${action} of "${sourceName}" failed: ${error.message}. ` +
        `Restoring the previous pair also failed: ${restoreError.message}; ` +
        (recoveryError
          ? `the service did not recover: ${recoveryError.message}.`
          : 'the server may be inconsistent.') +
        retainedNotice,
      { cause: error },
    );
  }

  if (recoveryError) {
    throw new DeployError(
      `${action} of "${sourceName}" failed: ${error.message}. ` +
        `The previous pair was restored, but recovery failed: ${recoveryError.message}`,
      { cause: error },
    );
  }

  throw new DeployError(
    `${action} of "${sourceName}" failed: ${error.message}. The previous pair was restored.`,
    { cause: error },
  );
}

export async function promoteSource({
  source,
  layers,
  appDir,
  dataDir,
  incomingDir,
  fsImpl = defaultFs,
  restart = async () => {},
  smoke = async () => {},
  fetchImpl = globalThis.fetch,
  healthUrl = null,
  healthTimeoutMs = 5_000,
  dryRun = false,
  err = process.stderr,
} = {}) {
  const name = requireSource(source);
  const root = dataDirectory({ dataDir, appDir });
  const incomingRoot = incomingDir ? path.resolve(incomingDir) : path.join(root, 'incoming');
  const sourceDir = resolveSourceDirectory({ name, layers, appDir, dataDir });
  const incomingSourceDir = path.join(incomingRoot, name);
  assertNoIncomingOverlap({ dataRoot: root, incomingRoot, sourceDir, incomingSourceDir });
  const incoming = await inspectPair({
    sourceDir: incomingSourceDir,
    fsImpl,
    label: `Incoming ${name}`,
  });

  if (dryRun) {
    return {
      dryRun: true,
      source: name,
      buildId: incoming.buildId,
      archiveSha256: incoming.archiveSha256,
      archivePath: incoming.archivePath,
      manifestPath: incoming.manifestPath,
      sourceDir,
    };
  }

  const snapshot = await snapshotPairs(fsImpl, sourceDir);

  try {
    const installed = await installArchive(
      {
        archivePath: incoming.archivePath,
        manifestPath: incoming.manifestPath,
        dataDir: sourceDir,
      },
      { fsImpl },
    );

    await restart();
    await smoke();

    if (healthUrl) {
      await verifyPromotedSource({
        fetchImpl,
        healthUrl,
        source: name,
        buildId: incoming.buildId,
        timeoutMs: healthTimeoutMs,
      });
    }

    await consumeIncoming(fsImpl, incoming).catch(() => {});
    await removeSnapshot(fsImpl, snapshot).catch(() => {});

    return {
      dryRun: false,
      source: name,
      buildId: incoming.buildId,
      archiveSha256: incoming.archiveSha256,
      currentArchive: installed.currentArchive,
      currentManifest: installed.currentManifest,
      previousArchive: installed.previousArchive,
      previousManifest: installed.previousManifest,
      skipped: installed.skipped,
    };
  } catch (error) {
    await failWithRestore({
      fsImpl,
      snapshot,
      restart,
      smoke,
      err,
      error,
      action: 'Promotion',
      actionWord: 'promotion',
      sourceName: name,
    });
  }
}

export async function rollbackSource({
  source,
  layers,
  appDir,
  dataDir,
  incomingDir,
  fsImpl = defaultFs,
  restart = async () => {},
  smoke = async () => {},
  fetchImpl = globalThis.fetch,
  healthUrl = null,
  healthTimeoutMs = 5_000,
  dryRun = false,
  err = process.stderr,
} = {}) {
  const name = requireSource(source);
  const root = dataDirectory({ dataDir, appDir });
  const incomingRoot = incomingDir ? path.resolve(incomingDir) : path.join(root, 'incoming');
  const sourceDir = resolveSourceDirectory({ name, layers, appDir, dataDir });
  assertNoIncomingOverlap({
    dataRoot: root,
    incomingRoot,
    sourceDir,
    incomingSourceDir: path.join(incomingRoot, name),
  });
  const previous = await inspectInstalledPair({ sourceDir, fsImpl, kind: 'previous' });

  if (dryRun) {
    return {
      dryRun: true,
      source: name,
      buildId: previous.buildId,
      archiveSha256: previous.archiveSha256,
      archivePath: previous.archivePath,
      manifestPath: previous.manifestPath,
      sourceDir,
    };
  }

  const snapshot = await snapshotPairs(fsImpl, sourceDir);

  try {
    const installed = await installArchive(
      {
        archivePath: previous.archivePath,
        manifestPath: previous.manifestPath,
        dataDir: sourceDir,
      },
      { fsImpl },
    );

    await restart();
    await smoke();

    if (healthUrl) {
      await verifyPromotedSource({
        fetchImpl,
        healthUrl,
        source: name,
        buildId: previous.buildId,
        timeoutMs: healthTimeoutMs,
        label: 'Restored source',
      });
    }

    await removeSnapshot(fsImpl, snapshot).catch(() => {});

    return {
      dryRun: false,
      source: name,
      buildId: previous.buildId,
      archiveSha256: previous.archiveSha256,
      currentArchive: installed.currentArchive,
      currentManifest: installed.currentManifest,
      previousArchive: installed.previousArchive,
      previousManifest: installed.previousManifest,
      skipped: installed.skipped,
    };
  } catch (error) {
    await failWithRestore({
      fsImpl,
      snapshot,
      restart,
      smoke,
      err,
      error,
      action: 'Rollback',
      actionWord: 'rollback',
      sourceName: name,
    });
  }
}
