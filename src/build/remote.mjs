// Remote build boxes.
//
// A remote build creates a disposable Hetzner Cloud server, syncs the repository to it, runs the
// Phase 4 build pipeline there, and copies the resulting archives to the tile server's restricted
// incoming directory. The Mac never builds the planet itself; `ogis promote` remains the explicit
// step that swaps an incoming pair into service.

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { sha256Text } from './fs.mjs';

import { createHcloudClient } from '../provision/hcloud.mjs';
import { resolveConfig, resolvePublicKey, childEnvironment } from '../provision/provision.mjs';
import {
  loadBuildConfig,
  normaliseOutputDir,
  normalisePlanetDate,
  normalisePlanetMd5,
  normalisePlanetSha256,
  normalisePlanetUrl,
} from './config.mjs';
import { BuildConfigError, BuildError } from './errors.mjs';
import { runCommand } from './exec.mjs';
import { renderBuildBoxCloudInit, BUILD_BOX_APP_DIR } from './remote-cloud-init.mjs';
import { detectRsync } from '../deploy/rsync.mjs';
import { quoteIfNeeded, rsyncSshCommand, runRemote, shellQuote } from '../deploy/ssh.mjs';

export const BUILD_BOX_DEFAULTS = Object.freeze({
  serverType: 'cpx62',
  location: 'nbg1',
  image: 'ubuntu-26.04',
});

export const BUILD_BOX_LOG_PATH = `${BUILD_BOX_APP_DIR}/tmp/remote-build.log`;
export const BUILD_BOX_KEY_PATH = '.ssh/ogis-tiles-build';
// The tile server's rrsync build key is provisioned against this fixed directory (see
// src/provision/cloud-init.mjs). The remote build must use the same path so the disk preflight and
// the actual transfer describe the same filesystem.
export const BUILD_BOX_INCOMING_DIR = '/opt/ogis-tiles/data/incoming';
export const BUILD_BOX_DATA_DIR = path.posix.dirname(BUILD_BOX_INCOMING_DIR);
export const BUILD_BOX_MANAGED_LABELS = Object.freeze({
  'managed-by': 'ogis-tiles',
  role: 'build-box',
});
export const RSYNC_MKPATH_MIN_VERSION = '3.2.3';
// A filtered planet build can exceed six hours per source on a CPX62, and planet-scale route and
// path builds can run closer to a day. The timeout is a safety net against a wedged build, not an
// expected duration, so allow 24 hours before failing.
export const BUILD_BOX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const BUILD_BOX_TRANSFER_TIMEOUT_MS = 4 * 60 * 60 * 1000;
export const BUILD_BOX_KEY_REMOVAL_TIMEOUT_MS = 30_000;
export const BUILD_BOX_ACTION_TIMEOUT_MS = 15 * 60 * 1000;
export const BUILD_BOX_CLOUD_INIT_TIMEOUT_MS = 15 * 60 * 1000;
export const BUILD_BOX_SIGNAL_KEY_TIMEOUT_MS = 8_000;
export const BUILD_BOX_SIGNAL_LOG_TIMEOUT_MS = 6_000;
export const BUILD_BOX_SIGNAL_DESTROY_TIMEOUT_MS = 12_000;

// The tile server's data filesystem must have headroom before a build box starts transferring. A
// CX23 has a 40 GB disk; the approved fix when it fills past 70% is the CX33 upgrade, performed
// manually. This preflight never resizes a server.
export const DESTINATION_MIN_FREE_BYTES = 8 * 1024 ** 3;
export const DESTINATION_DISK_WARN_PERCENT = 70;
export const TILE_SERVER_CX23_DISK_GB = 40;
export const TILE_SERVER_CX33_UPGRADE =
  'the approved capacity path is a manual Hetzner CX33 upgrade; remote builds never resize a server';

// A CPX62 has a 640 GB default disk (about 596 GiB usable). A filtered planet build peaks at
// roughly 300–450 GB and fits. An unfiltered build needs about 800 GB and is not supported on the
// default disk; the build fails before downloading rather than filling the box. A larger server
// type is the supported escape hatch; attaching a separate volume is deliberately not automated.
export const BUILD_BOX_DISK_FILTERED_BYTES = 500 * 1024 ** 3;
export const BUILD_BOX_DISK_UNFILTERED_BYTES = 850 * 1024 ** 3;
export const BUILD_BOX_DISK_FIXTURE_BYTES = 10 * 1024 ** 3;
export const BUILD_BOX_DISK_POLICY =
  'CPX62 provides a 640 GB disk, which supports filtered planet builds; --skip-filter needs a ' +
  'larger server type';

// Hetzner/Ubuntu vendor cloud-config emits deprecation warnings (lists, chpasswd) that make an
// otherwise healthy cloud-init exit 2, so tolerate exit 2 but still fail on a hard error (exit 1).
// The tool checks that follow remain the real gate: a failed cloud-init that never installed the
// toolchain still fails here.
export const BUILD_BOX_READY_COMMAND = [
  'cloud-init status --wait || test $? -eq 2',
  '/usr/local/bin/node --version',
  '/usr/local/bin/pmtiles version',
  'java -version',
  'osmium --version',
  'rsync --version',
].join(' && ');

const SERVER_TYPE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const ARM_SERVER_TYPE_PATTERN = /^cax/i;
const LOCATION_PATTERN = /^[a-z][a-z0-9-]{1,15}$/;
const IMAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SERVER_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SOURCE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const REMOTE_USER_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const REMOTE_HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const ABSOLUTE_PATH_PATTERN = /^\/[^\0\r\n]*$/;
const SAFE_APP_DIR_ROOTS = new Set(['opt', 'srv']);
const PLANET_LATEST_PATTERN = /(?:^|[^a-z0-9])planet-latest(?:[^a-z0-9]|$)/i;

const REMOTE_VALUE_FLAGS = [
  ['only', '--only'],
  ['fixture', '--fixture'],
  ['planetPbf', '--planet-pbf'],
  ['planetUrl', '--planet-url'],
  ['planetDate', '--planet-date'],
  ['planetSha256', '--planet-sha256'],
  ['planetMd5', '--planet-md5'],
  ['outputDir', '--output-dir'],
  ['buildServerType', '--build-server-type'],
  ['buildLocation', '--build-location'],
  ['buildImage', '--build-image'],
  ['buildName', '--build-name'],
  ['appDir', '--app-dir'],
];

const BUILD_BOX_EXCLUDES = [
  '--exclude=/data/',
  '--exclude=/node_modules/',
  '--exclude=/tmp/',
  '--exclude=/dist/',
  '--exclude=/.git/',
  '--exclude=.env*',
  '--exclude=/.opencode/',
];

const REMOTE_EXCLUDED_PREFIXES = ['data', 'node_modules', 'tmp', 'dist', '.git', '.opencode'];
const PRIVATE_KEY_MATERIAL_PATTERN = /-----BEGIN [^-]*PRIVATE KEY-----/;

function defaultSleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function firstValue(...values) {
  return values.find((value) => typeof value === 'string' && value.trim() !== '')?.trim() ?? '';
}

function isTruthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(
    String(value ?? '')
      .trim()
      .toLowerCase(),
  );
}

function isManagedBuildBox(server) {
  const labels = server?.labels ?? {};

  return (
    labels['managed-by'] === BUILD_BOX_MANAGED_LABELS['managed-by'] &&
    labels.role === BUILD_BOX_MANAGED_LABELS.role
  );
}

function requirePattern(value, pattern, label) {
  const text = String(value ?? '').trim();
  if (!pattern.test(text)) {
    throw new BuildConfigError(`${label} "${value}" is not valid`);
  }

  return text;
}

function requireAbsolutePath(value, label) {
  const text = String(value ?? '').trim();
  const normalised = path.posix.normalize(text);

  if (
    !ABSOLUTE_PATH_PATTERN.test(text) ||
    normalised === '/' ||
    text.split('/').includes('..') ||
    normalised.split('/').includes('..')
  ) {
    throw new BuildConfigError(`${label} "${value}" must be a safe absolute path`);
  }

  return normalised;
}

function requireSafeAppDir(value, label) {
  if (String(value ?? '').trim() === '/') {
    throw new BuildConfigError(
      `${label} "${value}" must be a child directory under /opt or /srv; /etc, /home, /root, ` +
        '/usr, /var, /opt, /srv and / are not allowed',
    );
  }

  const normalised = requireAbsolutePath(value, label);
  const segments = normalised.split('/').filter((segment) => segment !== '');
  const root = segments[0];

  if (!SAFE_APP_DIR_ROOTS.has(root) || segments.length < 2) {
    throw new BuildConfigError(
      `${label} "${value}" must be a child directory under /opt or /srv; /etc, /home, /root, ` +
        '/usr, /var, /opt, /srv and / are not allowed',
    );
  }

  return normalised;
}

function requireNonEmptyFlagValues(options) {
  for (const [key, flag] of REMOTE_VALUE_FLAGS) {
    const value = options[key];

    if (value !== undefined && value !== null && String(value).trim() === '') {
      throw new BuildConfigError(`${flag} requires a non-empty value with --remote`);
    }
  }
}

function resolveOptionalTimeout({ env, name, fallback }) {
  const raw = String(env[name] ?? '').trim();
  if (raw === '') {
    return fallback;
  }

  if (!/^\d+$/.test(raw)) {
    throw new BuildConfigError(`${name} must be a positive integer number of milliseconds`);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BuildConfigError(`${name} must be a positive integer number of milliseconds`);
  }

  return value;
}

export function resolveDestinationMinFreeBytes({ env = {}, value } = {}) {
  const raw = firstValue(value, env.BUILD_DESTINATION_MIN_FREE_BYTES);
  if (raw === '') {
    return DESTINATION_MIN_FREE_BYTES;
  }

  if (!/^\d+$/.test(raw)) {
    throw new BuildConfigError(
      'BUILD_DESTINATION_MIN_FREE_BYTES must be a non-negative integer number of bytes',
    );
  }

  const bytes = Number(raw);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new BuildConfigError(
      'BUILD_DESTINATION_MIN_FREE_BYTES must be a non-negative integer number of bytes',
    );
  }

  return bytes;
}

export function resolveDestinationDataDir({ env = {}, value } = {}) {
  const dataDir = requireAbsolutePath(
    firstValue(value, env.TILE_DATA_DIR, BUILD_BOX_DATA_DIR),
    'Tile server data directory',
  );

  if (dataDir !== BUILD_BOX_DATA_DIR) {
    throw new BuildConfigError(
      `Tile server data directory "${dataDir}" must be "${BUILD_BOX_DATA_DIR}"; the remote build ` +
        `key writes under "${BUILD_BOX_INCOMING_DIR}". Unset TILE_DATA_DIR before a remote build, ` +
        'or re-provision the tile server to use the same data directory',
    );
  }

  return dataDir;
}

// The build key's rrsync root is provisioned at a fixed path. A configured incoming directory that
// disagrees would make the disk preflight describe one filesystem while the transfer wrote to
// another, so reject the mismatch before a billable box exists.
export function resolveDestinationIncomingDir({ env = {}, value } = {}) {
  const incomingDir = requireAbsolutePath(
    firstValue(value, env.TILE_INCOMING_DIR, BUILD_BOX_INCOMING_DIR),
    'Tile server incoming directory',
  );

  resolveDestinationDataDir({ env });

  if (incomingDir !== BUILD_BOX_INCOMING_DIR) {
    throw new BuildConfigError(
      `TILE_INCOMING_DIR "${incomingDir}" must be "${BUILD_BOX_INCOMING_DIR}"; the remote build ` +
        'key is provisioned with rrsync against that fixed directory. Unset TILE_INCOMING_DIR ' +
        'before a remote build, or re-provision the tile server to use the same path',
    );
  }

  return incomingDir;
}

export function destinationDiskCommand({ dataDir }) {
  const directory = requireAbsolutePath(dataDir, 'Tile server data directory');

  return `df -B1 --output=size,avail ${shellQuote(directory)} | tail -n 1`;
}

export function parseDestinationDisk(output) {
  const numbers = String(output ?? '')
    .trim()
    .split(/\s+/)
    .filter((entry) => entry !== '');

  if (numbers.length === 0 || numbers.some((entry) => !/^\d+$/.test(entry))) {
    throw new BuildError('Unable to read the free disk space reported by the tile server');
  }

  if (numbers.length === 1) {
    const availableBytes = Number(numbers[0]);
    if (!Number.isSafeInteger(availableBytes)) {
      throw new BuildError('The tile server reported an invalid free disk space');
    }

    return { sizeBytes: null, availableBytes, usedPercent: null };
  }

  const sizeBytes = Number(numbers[0]);
  const availableBytes = Number(numbers[1]);
  if (
    !Number.isSafeInteger(sizeBytes) ||
    !Number.isSafeInteger(availableBytes) ||
    sizeBytes <= 0 ||
    availableBytes < 0 ||
    availableBytes > sizeBytes
  ) {
    throw new BuildError('The tile server reported an invalid data filesystem capacity');
  }

  const usedPercent = Math.round(((sizeBytes - availableBytes) / sizeBytes) * 1000) / 10;
  return { sizeBytes, availableBytes, usedPercent };
}

export function assertDestinationDisk({
  availableBytes,
  sizeBytes = null,
  usedPercent = null,
  minFreeBytes = DESTINATION_MIN_FREE_BYTES,
  warn = () => {},
} = {}) {
  if (availableBytes < minFreeBytes) {
    throw new BuildError(
      `The tile server data filesystem has ${formatGiB(availableBytes)} free but at least ` +
        `${formatGiB(minFreeBytes)} is required before creating a build box; free space on the ` +
        'tile server first',
    );
  }

  if (usedPercent !== null && usedPercent >= DESTINATION_DISK_WARN_PERCENT) {
    warn(
      `Warning: the tile server data filesystem is ${usedPercent}% full. A CX23 has a ` +
        `${TILE_SERVER_CX23_DISK_GB} GB disk, so plan capacity before it fills; ` +
        `${TILE_SERVER_CX33_UPGRADE}.`,
    );
  }

  return { availableBytes, sizeBytes, usedPercent, minFreeBytes };
}

export function resolveRemotePlanetPin({ options = {}, env = {}, config }) {
  const url = firstValue(options.planetUrl, env.PLANET_URL, config?.build?.planet?.url);
  const date = firstValue(options.planetDate, env.PLANET_DATE, config?.build?.planet?.date);
  const sha256 = firstValue(options.planetSha256, env.PLANET_SHA256, config?.build?.planet?.sha256);
  const md5 = firstValue(options.planetMd5, env.PLANET_MD5, config?.build?.planet?.md5);

  const missing = [];
  if (url === '') {
    missing.push('PLANET_URL');
  }
  if (date === '') {
    missing.push('PLANET_DATE');
  }
  if (sha256 === '' && md5 === '') {
    missing.push('a checksum pin (PLANET_SHA256 or PLANET_MD5)');
  }

  if (missing.length > 0) {
    throw new BuildConfigError(
      `Planet builds require PLANET_URL, PLANET_DATE and at least one of PLANET_SHA256 or ` +
        `PLANET_MD5 before creating a build box; missing ${missing.join(', ')}`,
    );
  }

  const resolved = {
    url: normalisePlanetUrl(url, 'Planet URL'),
    date: normalisePlanetDate(date, 'Planet date'),
    sha256: sha256 === '' ? '' : normalisePlanetSha256(sha256, 'Planet SHA-256'),
    md5: md5 === '' ? '' : normalisePlanetMd5(md5, 'Planet MD5'),
  };

  if (PLANET_LATEST_PATTERN.test(resolved.url)) {
    throw new BuildConfigError(
      `Planet URL "${resolved.url}" points at planet-latest; pin a dated planet snapshot with a ` +
        'matching SHA-256 or MD5 before creating a build box',
    );
  }

  return resolved;
}

function buildBoxName(now) {
  const stamp = new Date(now())
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')
    .toLowerCase();

  return `ogis-build-${stamp}`;
}

export function resolveRemoteBuildConfig({ env, homedir, options = {}, now = () => Date.now() }) {
  const base = resolveConfig({
    env,
    homedir,
    requireSshKeys: true,
    requireBuildKey: !options.noTransfer,
  });
  const serverType = requirePattern(
    firstValue(options.buildServerType, env.BUILD_SERVER_TYPE, BUILD_BOX_DEFAULTS.serverType),
    SERVER_TYPE_PATTERN,
    'Build box server type',
  );
  const location = requirePattern(
    firstValue(options.buildLocation, env.BUILD_SERVER_LOCATION, BUILD_BOX_DEFAULTS.location),
    LOCATION_PATTERN,
    'Build box location',
  );
  const image = requirePattern(
    firstValue(options.buildImage, env.BUILD_SERVER_IMAGE, BUILD_BOX_DEFAULTS.image),
    IMAGE_PATTERN,
    'Build box image',
  );

  if (ARM_SERVER_TYPE_PATTERN.test(serverType)) {
    throw new BuildConfigError(
      `Build box server type "${serverType}" is ARM; the ${image} image and Node.js tarball are x86 only`,
    );
  }

  const serverName = requirePattern(
    firstValue(options.buildName, env.BUILD_SERVER_NAME, buildBoxName(now)),
    SERVER_NAME_PATTERN,
    'Build box name',
  );
  const appDir = requireSafeAppDir(
    firstValue(options.appDir, env.TILE_APP_DIR, BUILD_BOX_APP_DIR),
    'Build box app directory',
  );
  const keep =
    Boolean(options.keepBuildBox) || Boolean(options.noDestroy) || isTruthy(env.KEEP_BUILD_BOX);

  return {
    ...base,
    serverType,
    location,
    image,
    serverName,
    appDir,
    keep,
  };
}

export function selectBuildSources(config, only) {
  if (only === undefined || only === null) {
    return Object.keys(config.sources);
  }

  const requested = [
    ...new Set(
      String(only)
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== ''),
    ),
  ];

  if (requested.length === 0) {
    throw new BuildConfigError('--only requires at least one source name');
  }

  for (const name of requested) {
    if (!Object.hasOwn(config.sources, name)) {
      throw new BuildConfigError(`Source "${name}" has no build profile`);
    }
  }

  return requested;
}

function repositoryRelativePath(repoRoot, target, label) {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new BuildConfigError(`${label} must be a non-empty path`);
  }

  const absolute = path.isAbsolute(target) ? path.resolve(target) : path.resolve(repoRoot, target);
  const relative = path.relative(path.resolve(repoRoot), absolute);

  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new BuildConfigError(`${label} must be inside the repository for a remote build`);
  }

  if (path.isAbsolute(relative)) {
    throw new BuildConfigError(`${label} must be inside the repository for a remote build`);
  }

  return relative.split(path.sep).join('/');
}

async function requireLocalFile(fsImpl, repoRoot, relative, label) {
  const absolutePath = path.resolve(repoRoot, relative);
  const statImpl = fsImpl?.stat ?? stat;
  let info;

  try {
    info = await statImpl(absolutePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new BuildConfigError(`${label} file not found: ${relative}`);
    }

    throw new BuildConfigError(`Unable to check ${label} at ${relative}: ${error.message}`, {
      cause: error,
    });
  }

  if (typeof info?.isFile === 'function' && !info.isFile()) {
    throw new BuildConfigError(`${label} must be a file: ${relative}`);
  }

  return absolutePath;
}

function buildFlag(name, value) {
  return `--${name}=${shellQuote(value)}`;
}

export function remoteBuildCommand({
  appDir = BUILD_BOX_APP_DIR,
  nodeBin = '/usr/local/bin/node',
  configPath = 'config/layers.json',
  outputDir = 'dist',
  options = {},
  planetBuildHeap = '',
  logPath = BUILD_BOX_LOG_PATH,
} = {}) {
  const flags = [buildFlag('output-dir', outputDir)];

  if (firstValue(options.only) !== '') {
    flags.push(buildFlag('only', options.only));
  }

  if (firstValue(options.fixture) !== '') {
    flags.push(buildFlag('fixture', options.fixture));
  }

  if (firstValue(options.planetPbf) !== '') {
    flags.push(buildFlag('planet-pbf', options.planetPbf));
  }

  if (firstValue(options.planetUrl) !== '') {
    flags.push(buildFlag('planet-url', options.planetUrl));
  }

  if (firstValue(options.planetDate) !== '') {
    flags.push(buildFlag('planet-date', options.planetDate));
  }

  if (firstValue(options.planetSha256) !== '') {
    flags.push(buildFlag('planet-sha256', options.planetSha256));
  }

  if (firstValue(options.planetMd5) !== '') {
    flags.push(buildFlag('planet-md5', options.planetMd5));
  }

  for (const [flag, enabled] of [
    ['skip-download', options.skipDownload],
    ['skip-filter', options.skipFilter],
    ['skip-verify', options.skipVerify],
    ['keep-work', options.keepWork],
    ['force', options.force],
  ]) {
    if (enabled) {
      flags.push(`--${flag}`);
    }
  }

  const environment = [];
  if (configPath !== 'config/layers.json') {
    environment.push(`CONFIG_PATH=${shellQuote(configPath)}`);
  }
  if (firstValue(planetBuildHeap) !== '') {
    environment.push(`PLANET_BUILD_HEAP=${shellQuote(planetBuildHeap)}`);
  }
  const prefix = environment.length === 0 ? '' : `${environment.join(' ')} `;
  const command = `${prefix}${quoteIfNeeded(nodeBin)} bin/ogis.mjs build ${flags.join(' ')}`.trim();
  const tmpDir = path.posix.join(appDir, 'tmp');

  return [
    'set -o pipefail;',
    `cd ${shellQuote(appDir)}`,
    `&& mkdir -p ${shellQuote(tmpDir)}`,
    `&& (${command} 2>&1 | tee ${shellQuote(logPath)} | tail -n 200)`,
  ].join(' ');
}

export function npmCiCommand({ appDir = BUILD_BOX_APP_DIR, nodeBin = '/usr/local/bin/node' } = {}) {
  const npm = path.posix.join(path.posix.dirname(nodeBin), 'npm');
  const npmPath = [
    ...new Set([path.posix.dirname(nodeBin), '/usr/local/bin', '/usr/bin', '/bin']),
  ].join(':');

  return (
    `cd ${shellQuote(appDir)} && ` +
    `PATH=${quoteIfNeeded(npmPath)} ${quoteIfNeeded(npm)} ci --include=dev`
  );
}

export function installBuildKeyCommand({ keyPath, stagedPath = `${keyPath}.tmp` } = {}) {
  for (const [label, target] of [
    ['Build key path', keyPath],
    ['Staged build key path', stagedPath],
  ]) {
    if (
      typeof target !== 'string' ||
      !path.isAbsolute(target) ||
      target.includes('\0') ||
      /[\r\n]/.test(target)
    ) {
      throw new BuildConfigError(`${label} "${target}" must be an absolute safe path`);
    }
  }

  if (path.posix.normalize(keyPath) === path.posix.normalize(stagedPath)) {
    throw new BuildConfigError('The staged build key path must differ from the final key path');
  }

  const directory = path.posix.dirname(keyPath);

  return [
    'umask 077',
    `&& install -d -m 0700 ${shellQuote(directory)}`,
    `&& chmod 0600 ${shellQuote(stagedPath)}`,
    `&& mv -f ${shellQuote(stagedPath)} ${shellQuote(keyPath)}`,
    `&& chmod 0600 ${shellQuote(keyPath)}`,
    `&& test -s ${shellQuote(keyPath)}`,
  ].join(' ');
}

export function removeBuildKeyCommand(keyPath) {
  return `rm -f ${shellQuote(keyPath)} ${shellQuote(`${keyPath}.tmp`)}`;
}

export function diskSpaceCommand({ appDir = BUILD_BOX_APP_DIR } = {}) {
  const tmpDir = path.posix.join(appDir, 'tmp');
  return (
    `mkdir -p ${shellQuote(tmpDir)} && ` +
    `df -B1 --output=avail ${shellQuote(tmpDir)} | tail -n 1 | tr -d '[:space:]'`
  );
}

export function parseAvailableBytes(output) {
  const match = /(\d+)/.exec(String(output ?? ''));
  if (!match) {
    throw new BuildError('Unable to read the free disk space reported by the build box');
  }

  const bytes = Number(match[1]);
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new BuildError('The build box reported an invalid free disk space');
  }

  return bytes;
}

export function requiredDiskBytes({ fixture, skipFilter } = {}) {
  if (firstValue(fixture) !== '') {
    return BUILD_BOX_DISK_FIXTURE_BYTES;
  }

  return skipFilter ? BUILD_BOX_DISK_UNFILTERED_BYTES : BUILD_BOX_DISK_FILTERED_BYTES;
}

export function formatGiB(bytes) {
  return `${(Number(bytes) / 1024 ** 3).toFixed(1)} GiB`;
}

export function assertRemoteInputPath(relative, label) {
  const normalised = String(relative ?? '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '');
  const segments = normalised.split('/');
  const first = segments[0];

  if (
    REMOTE_EXCLUDED_PREFIXES.includes(first) ||
    segments.some((segment) => segment.startsWith('.env'))
  ) {
    throw new BuildConfigError(
      `${label} "${relative}" is under a path that is excluded from the remote sync; ` +
        'copy it into the repository first',
    );
  }

  return normalised;
}

export function buildTransferSshCommand(keyPath) {
  return [
    'ssh',
    '-i',
    keyPath,
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=10',
  ]
    .map((part) => quoteIfNeeded(part))
    .join(' ');
}

export function transferSourceCommand({
  appDir = BUILD_BOX_APP_DIR,
  outputDir = 'dist',
  source,
  targetHost,
  buildUser = 'build',
  keyPath,
} = {}) {
  if (!SOURCE_NAME_PATTERN.test(String(source ?? ''))) {
    throw new BuildConfigError(`Source "${source}" is not a valid source name`);
  }

  if (!REMOTE_USER_PATTERN.test(String(buildUser ?? ''))) {
    throw new BuildConfigError(`Build user "${buildUser}" is not a valid Linux user name`);
  }

  if (!REMOTE_HOST_PATTERN.test(String(targetHost ?? ''))) {
    throw new BuildConfigError(`Target host "${targetHost}" is not a valid host name`);
  }

  if (
    typeof keyPath !== 'string' ||
    keyPath === '' ||
    /[\0\r\n]/.test(keyPath) ||
    !path.isAbsolute(keyPath)
  ) {
    throw new BuildConfigError('A safe absolute build private key path is required to transfer');
  }

  const sourceRoot = path.posix.join(appDir, outputDir);
  const probePath = path.posix.join(appDir, 'tmp', 'ogis-write-probe');
  // The build key is restricted with `rrsync -wo /opt/ogis-tiles/data/incoming`, so the remote
  // path is relative to that directory: `pois/` lands in `data/incoming/pois/`.
  const destination = `${buildUser}@${targetHost}:${source}/`;
  const quotedDestination = quoteIfNeeded(destination);
  const sshOption = `-e ${shellQuote(buildTransferSshCommand(keyPath))}`;
  const probeDestination = quoteIfNeeded(`${destination}.ogis-write-probe`);

  return [
    `src=$(ls -1dt ${shellQuote(`${sourceRoot}/`)}*/${shellQuote(source)} 2>/dev/null | head -n 1)`,
    '&& test -n "$src"',
    '&& test -f "$src/current.pmtiles"',
    '&& test -f "$src/build.json"',
    `&& mkdir -p ${shellQuote(path.posix.dirname(probePath))}`,
    `&& : > ${shellQuote(probePath)}`,
    `&& rsync --archive --mkpath ${sshOption} ${shellQuote(probePath)} ${probeDestination}`,
    '&& empty=$(mktemp -d)',
    `&& rsync --archive --no-perms --omit-dir-times --delete ` +
      `--include=${shellQuote('/current.pmtiles')} ` +
      `--include=${shellQuote('/build.json')} --include=${shellQuote('/.ogis-write-probe')} ` +
      `--exclude=${shellQuote('*')} ${sshOption} "$empty/" ${quotedDestination}`,
    '&& rmdir "$empty"',
    `&& rsync --archive --compress --delay-updates --no-group --mkpath ${sshOption} ` +
      `"$src/current.pmtiles" "$src/build.json" ${quotedDestination}`,
  ].join(' ');
}

export function repositorySyncArguments({
  repoRoot,
  boxConfig,
  appDir = BUILD_BOX_APP_DIR,
  rsync,
}) {
  if (!repoRoot) {
    throw new BuildConfigError('The repository root is required to sync the build box');
  }

  if (!rsync?.command) {
    throw new BuildConfigError('A usable rsync is required to sync the build box');
  }

  const destination = `${boxConfig.deployUser}@${boxConfig.targetHost}:${appDir.replace(/\/+$/, '')}/`;
  const args = ['--archive', '--compress', '--delete', '--human-readable'];

  if (rsync.protectArgs) {
    args.push('--protect-args');
  }

  args.push(
    ...BUILD_BOX_EXCLUDES,
    '-e',
    rsyncSshCommand(boxConfig),
    `${path.resolve(repoRoot)}/`,
    rsync.protectArgs ? destination : quoteIfNeeded(destination),
  );

  return args;
}

export async function waitForServerReady({
  client,
  serverId,
  timeoutMs = 5 * 60 * 1000,
  intervalMs = 5_000,
  sleep = defaultSleep,
  now = () => Date.now(),
} = {}) {
  const deadline = now() + timeoutMs;

  for (;;) {
    const server = await client.getServer(serverId);
    const ip = server?.public_net?.ipv4?.ip;

    if (server?.status === 'running' && ip) {
      return { server, ip };
    }

    if (now() >= deadline) {
      throw new BuildError(
        `Build box ${serverId} did not become reachable within ${timeoutMs}ms (status "${server?.status ?? 'unknown'}")`,
      );
    }

    await sleep(intervalMs);
  }
}

export async function waitForBuildBoxSsh({
  boxConfig,
  execImpl,
  env,
  attempts = 60,
  intervalMs = 5_000,
  sleep = defaultSleep,
  timeoutMs = 15_000,
} = {}) {
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await runRemote(boxConfig, 'true', {
        execImpl,
        env,
        timeoutMs,
        label: 'Build box SSH check',
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) {
        await sleep(intervalMs);
      }
    }
  }

  throw new BuildError(
    `Unable to reach the build box over SSH after ${attempts} attempts: ${lastError?.message ?? 'no response'}`,
    { cause: lastError ?? undefined },
  );
}

async function removeBuildKey({ boxConfig, keyPath, execImpl, env, err, timeoutMs }) {
  try {
    await runRemote(boxConfig, removeBuildKeyCommand(keyPath), {
      execImpl,
      env,
      timeoutMs,
      label: 'Build key cleanup',
    });
    return true;
  } catch (error) {
    err.write(`Warning: could not remove the build key from the build box: ${error.message}\n`);
    return false;
  }
}

function isTimeoutFailure(error) {
  return (
    error?.name === 'AbortError' ||
    /\btimed out\b/i.test(String(error?.message ?? '')) ||
    error?.code === 'ETIMEDOUT'
  );
}

async function destroyBuildBox(client, serverId, { timeoutMs = BUILD_BOX_ACTION_TIMEOUT_MS } = {}) {
  let action;

  try {
    action = await client.deleteServer(serverId);
  } catch (error) {
    if (error?.status === 404) {
      return { deleted: false, missing: true };
    }

    throw error;
  }

  if (action?.id !== undefined) {
    try {
      await client.waitForAction(action.id, {
        timeoutMs,
        intervalMs: 5_000,
      });
    } catch (error) {
      throw new BuildError(
        `Hetzner Cloud did not finish deleting build box ${serverId}: ${error.message}`,
        { cause: error },
      );
    }
  }

  try {
    const remaining = await client.getServer(serverId);
    if (remaining) {
      throw new BuildError(`Build box ${serverId} still exists after the delete action completed`);
    }
  } catch (error) {
    if (error?.status !== 404) {
      throw error;
    }
  }

  return { deleted: true, missing: false };
}

async function cleanupCreateTimeout({ client, box, err }) {
  try {
    const found = await client.findServerByName(box.serverName);

    if (!found?.id) {
      err.write(
        `Warning: the create request timed out and no server named "${box.serverName}" exists; ` +
          'nothing was left behind\n',
      );
      return;
    }

    if (!isManagedBuildBox(found)) {
      err.write(
        `Warning: the create request timed out and "${box.serverName}" exists but is not labelled ` +
          `as an ogis-tiles build box; check server ${found.id} manually\n`,
      );
      return;
    }

    await destroyBuildBox(client, found.id);
    err.write(
      `Warning: the create request timed out after Hetzner created ${box.serverName} (#${found.id}); ` +
        'the orphaned build box was deleted\n',
    );
  } catch (error) {
    err.write(
      `Warning: the create request timed out and the orphaned build box could not be cleaned up: ` +
        `${error.message}. Check Hetzner Cloud for "${box.serverName}" and delete it manually\n`,
    );
  }
}

async function copyBuildLog({ boxConfig, logPath, execImpl, env, err, timeoutMs = 60_000 }) {
  try {
    const { stdout } = await runRemote(boxConfig, `tail -n 200 ${shellQuote(logPath)} 2>&1`, {
      execImpl,
      env,
      timeoutMs,
      label: 'Remote build log',
    });

    if (String(stdout ?? '').trim() !== '') {
      err.write(`--- Remote build log (${logPath}) ---\n`);
      err.write(stdout.endsWith('\n') ? stdout : `${stdout}\n`);
      err.write('--- End remote build log ---\n');
    }
  } catch (error) {
    err.write(`Warning: could not read the remote build log at ${logPath}: ${error.message}\n`);
  }
}

export async function cleanupInterruptedBuild({
  box,
  boxConfig = null,
  activeServer = null,
  hcloud,
  keyPath,
  keyTransferAttempted = false,
  keyInstalled = false,
  localKeyDirectory = null,
  localKnownHostsPath = null,
  logPath,
  keep = false,
  execImpl,
  env,
  err,
  fsImpl = { rm },
  signal = 'interrupt',
  keyTimeoutMs = BUILD_BOX_SIGNAL_KEY_TIMEOUT_MS,
  logTimeoutMs = BUILD_BOX_SIGNAL_LOG_TIMEOUT_MS,
  destroyTimeoutMs = BUILD_BOX_SIGNAL_DESTROY_TIMEOUT_MS,
} = {}) {
  try {
    if (localKeyDirectory) {
      try {
        await fsImpl.rm(localKeyDirectory, { recursive: true, force: true });
      } catch (error) {
        err.write(
          `Warning: could not remove the local build-key staging directory ${localKeyDirectory}: ` +
            `${error.message}\n`,
        );
      }
    }

    if (boxConfig && (keyInstalled || keyTransferAttempted)) {
      await removeBuildKey({
        boxConfig,
        keyPath,
        execImpl,
        env,
        err,
        timeoutMs: keyTimeoutMs,
      });
    }

    if (boxConfig && logPath) {
      await copyBuildLog({
        boxConfig,
        logPath,
        execImpl,
        env,
        err,
        timeoutMs: logTimeoutMs,
      });
    }

    if (keep) {
      return { destroyed: false, kept: true };
    }

    if (activeServer?.id !== undefined) {
      await destroyBuildBox(hcloud, activeServer.id, { timeoutMs: destroyTimeoutMs });
      return { destroyed: true, kept: false };
    }

    try {
      const found = await hcloud.findServerByName(box.serverName);
      if (found?.id !== undefined) {
        if (!isManagedBuildBox(found)) {
          err.write(
            `Warning: "${box.serverName}" (#${found.id}) is not labelled as an ogis-tiles build ` +
              `box; refusing to delete it during ${signal}. Check the server manually\n`,
          );
          return { destroyed: false, kept: false };
        }

        await destroyBuildBox(hcloud, found.id, { timeoutMs: destroyTimeoutMs });
        return { destroyed: true, kept: false };
      }
    } catch (error) {
      err.write(
        `Warning: could not confirm an in-flight build box during ${signal}: ${error.message}\n`,
      );
    }

    return { destroyed: false, kept: false };
  } finally {
    if (localKnownHostsPath) {
      try {
        await fsImpl.rm(localKnownHostsPath, { force: true });
      } catch (error) {
        err.write(
          `Warning: could not remove the per-run known_hosts file ${localKnownHostsPath}: ` +
            `${error.message}\n`,
        );
      }
    }
  }
}

function settleWithin(promise, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    timer.unref?.();

    Promise.resolve(promise).then(
      () => finish({ kind: 'done' }),
      (error) => finish({ kind: 'error', error }),
    );
  });
}

export function installRemoteBuildSignalGuard({
  cleanup,
  err = process.stderr,
  processImpl = process,
  timeoutMs = 30_000,
  signals = ['SIGINT', 'SIGTERM'],
} = {}) {
  let receivedSignal = null;
  let disposed = false;
  const handlers = new Map();

  const onSignal = (signal) => {
    if (receivedSignal) {
      err.write(
        `Ignoring repeated ${signal}; cleanup for ${receivedSignal} is already in progress\n`,
      );
      return;
    }

    receivedSignal = signal;
    err.write(`Received ${signal}; removing the build box before exit\n`);

    settleWithin(
      Promise.resolve().then(() => cleanup()),
      timeoutMs,
    ).then((outcome) => {
      if (outcome.kind === 'error') {
        err.write(`Warning: cleanup after ${signal} failed: ${outcome.error.message}\n`);
      } else if (outcome.kind === 'timeout') {
        err.write(
          `Warning: cleanup after ${signal} did not finish within ${timeoutMs}ms; check Hetzner ` +
            'Cloud for an orphaned build box\n',
        );
      } else {
        err.write('Build box cleanup finished before exit\n');
      }

      processImpl.exit(signal === 'SIGTERM' ? 143 : 130);
    });
  };

  for (const signal of signals) {
    const handler = () => onSignal(signal);
    handlers.set(signal, handler);
    processImpl.on(signal, handler);
  }

  return {
    received() {
      return receivedSignal;
    },
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      for (const [signal, handler] of handlers) {
        processImpl.removeListener?.(signal, handler);
      }
    },
  };
}

function planLines({ box, config, sources, options, outputDir, configPath, cloudInitBytes }) {
  const input =
    firstValue(options.fixture) !== ''
      ? `fixture ${options.fixture}`
      : firstValue(options.planetPbf) !== ''
        ? `planet PBF ${options.planetPbf}`
        : `planet ${firstValue(options.planetUrl, 'configured URL')} ` +
          `(date ${firstValue(options.planetDate, 'configured date')})`;

  const transfers = options.noTransfer
    ? 'skip archive transfer (--no-transfer; the build box is kept)'
    : sources.map((source) => `${box.buildUser}@${box.host}:${source}/`).join(', ');
  const keep = box.keep || Boolean(options.noTransfer);

  return [
    'ogis build --remote — dry run',
    '',
    `Build box: ${box.serverName} (${box.serverType} in ${box.location} from ${box.image})`,
    `SSH user: ${box.deployUser} with the deploy key`,
    `Repository: ${box.appDir} (config ${configPath}, output ${outputDir})`,
    `Sources: ${sources.join(', ')}`,
    `Input: ${input}`,
    `Cloud-init: ${cloudInitBytes} bytes; Node, Java 21+, osmium, pmtiles and rsync are pinned`,
    'Sync excludes: data/, node_modules/, tmp/, dist/, .git/, .env* and .opencode/',
    `Disk: ${BUILD_BOX_DISK_POLICY}`,
    `Build: ${npmCiCommand({ appDir: box.appDir, nodeBin: '/usr/local/bin/node' })}; ` +
      'node bin/ogis.mjs build',
    `Transfer: ${transfers}`,
    `Keep build box: ${keep ? 'yes' : 'no'}`,
    '',
    'No changes were made. Run with --yes to create the billable build box.',
  ];
}

async function ensureDeploySshKey({ client, publicKey, err }) {
  if (typeof client.listSshKeys !== 'function' || typeof client.createSshKey !== 'function') {
    return null;
  }

  try {
    const keys = await client.listSshKeys();
    const match = keys.find((key) => String(key.public_key ?? '').trim() === publicKey.trim());

    if (match?.id !== undefined) {
      return match;
    }

    const name = `ogis-tiles-deploy-${sha256Text(publicKey).slice(0, 12)}`;
    return await client.createSshKey({ name, publicKey });
  } catch (error) {
    err.write(
      `Warning: could not register the deploy key as a recovery SSH key; ` +
        `cloud-init will still install it (${error.message})\n`,
    );
    return null;
  }
}

async function uploadBuildKey({
  repoRoot,
  boxConfig,
  remoteKeyPath,
  keyMaterial,
  execImpl,
  env,
  fsImpl,
  err = process.stderr,
  onStagingDirectory = () => {},
}) {
  const tmpRoot = path.join(repoRoot, 'tmp');
  await fsImpl.mkdir(tmpRoot, { recursive: true });
  const stagingDirectory = await fsImpl.mkdtemp(path.join(tmpRoot, 'ogis-build-key-'));
  onStagingDirectory(stagingDirectory);
  const localKeyPath = path.join(stagingDirectory, 'key');
  const stagedRemotePath = `${remoteKeyPath}.tmp`;

  try {
    await fsImpl.writeFile(localKeyPath, keyMaterial, { encoding: 'utf8', mode: 0o600 });

    const scpArguments = [
      '-i',
      boxConfig.deployPrivateKeyPath,
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-o',
      'ConnectTimeout=10',
    ];

    if (boxConfig.knownHostsPath) {
      scpArguments.push(
        '-o',
        `UserKnownHostsFile=${boxConfig.knownHostsPath}`,
        '-o',
        'GlobalKnownHostsFile=/dev/null',
      );
    }

    scpArguments.push(
      localKeyPath,
      `${boxConfig.deployUser}@${boxConfig.targetHost}:${stagedRemotePath}`,
    );

    try {
      await execImpl('scp', scpArguments, {
        encoding: 'utf8',
        env: childEnvironment(env),
      });
    } catch {
      throw new BuildError(
        'Unable to copy the build private key to the build box; check the deploy SSH key and ' +
          'permissions',
      );
    }

    await runRemote(
      boxConfig,
      installBuildKeyCommand({ keyPath: remoteKeyPath, stagedPath: stagedRemotePath }),
      {
        execImpl,
        env,
        label: 'Build key copy',
      },
    );
  } finally {
    try {
      await fsImpl.rm(stagingDirectory, { recursive: true, force: true });
    } catch (error) {
      err.write(
        `Warning: could not remove the local build-key staging directory ${stagingDirectory}: ` +
          `${error.message}\n`,
      );
    }

    onStagingDirectory(null);
  }
}

export function compareVersions(left, right) {
  const a = String(left ?? '')
    .split('.')
    .map((part) => Number(part));
  const b = String(right ?? '')
    .split('.')
    .map((part) => Number(part));
  const length = Math.max(a.length, b.length);

  for (let index = 0; index < length; index += 1) {
    const x = a[index] ?? 0;
    const y = b[index] ?? 0;

    if (x !== y) {
      return x > y ? 1 : -1;
    }
  }

  return 0;
}

export function supportsRsyncMkpath(rsync) {
  return Boolean(
    rsync?.command &&
    !rsync.openrsync &&
    rsync.version &&
    compareVersions(rsync.version, RSYNC_MKPATH_MIN_VERSION) >= 0,
  );
}

// macOS ships openrsync, which rejects --mkpath. The restricted build key only permits rsync, so a
// write probe at the rrsync root is used instead of creating the per-source directory first. This
// still proves the key can write and delete inside the incoming directory before a box exists.
export function preflightRsyncPlan({ targetHost, buildUser, source, rsync } = {}) {
  const root = `${buildUser}@${targetHost}:`;

  if (supportsRsyncMkpath(rsync)) {
    return {
      destination: `${root}${source}/`,
      marker: `${root}${source}/.ogis-preflight-probe`,
      deleteDestination: `${root}${source}/`,
      mkpath: true,
    };
  }

  return {
    destination: `${root}./`,
    marker: `${root}.ogis-preflight-probe`,
    deleteDestination: `${root}./`,
    mkpath: false,
  };
}

export async function preflightBuildKey({
  repoRoot,
  targetHost,
  buildUser = 'build',
  source,
  keyPath,
  execImpl,
  env = process.env,
  fsImpl = { mkdir, mkdtemp, rm, writeFile },
  rsync,
  err = process.stderr,
  timeoutMs = 60_000,
} = {}) {
  if (!SOURCE_NAME_PATTERN.test(String(source ?? ''))) {
    throw new BuildConfigError(`Source "${source}" is not a valid source name`);
  }

  if (!REMOTE_USER_PATTERN.test(String(buildUser ?? ''))) {
    throw new BuildConfigError(`Build user "${buildUser}" is not a valid Linux user name`);
  }

  if (!REMOTE_HOST_PATTERN.test(String(targetHost ?? ''))) {
    throw new BuildConfigError(`Target host "${targetHost}" is not a valid host name`);
  }

  if (!rsync?.command) {
    throw new BuildConfigError('A usable rsync is required for the build-key preflight');
  }

  if (
    typeof keyPath !== 'string' ||
    keyPath === '' ||
    /[\0\r\n]/.test(keyPath) ||
    !path.isAbsolute(keyPath)
  ) {
    throw new BuildConfigError('A safe absolute build private key path is required for preflight');
  }

  const tmpRoot = path.join(repoRoot, 'tmp');
  await fsImpl.mkdir(tmpRoot, { recursive: true });
  const stagingDirectory = await fsImpl.mkdtemp(path.join(tmpRoot, 'ogis-build-key-preflight-'));
  const localProbePath = path.join(stagingDirectory, 'probe');
  const emptyDirectory = path.join(stagingDirectory, 'empty');
  const sshCommand = buildTransferSshCommand(keyPath);
  const plan = preflightRsyncPlan({ targetHost, buildUser, source, rsync });
  const marker = quoteIfNeeded(plan.marker);
  const mkpath = plan.mkpath ? ['--mkpath'] : [];
  // openrsync forwards --dirs to the server, which rrsync rejects. --no-dirs suppresses that
  // forwarding and is a local client-side argument only, so it does not weaken the restricted key.
  const noDirs = rsync.openrsync ? ['--no-dirs'] : [];

  try {
    await fsImpl.writeFile(localProbePath, '', { encoding: 'utf8', mode: 0o600 });
    await fsImpl.mkdir(emptyDirectory, { recursive: true });

    await execImpl(
      rsync.command,
      ['--archive', ...noDirs, ...mkpath, '-e', sshCommand, localProbePath, marker],
      { encoding: 'utf8', env: childEnvironment(env), timeoutMs },
    );
    await execImpl(
      rsync.command,
      [
        '--archive',
        ...noDirs,
        '--no-perms',
        '--omit-dir-times',
        '--delete',
        `--include=${quoteIfNeeded('/.ogis-preflight-probe')}`,
        '--exclude=*',
        '-e',
        sshCommand,
        `${emptyDirectory}/`,
        quoteIfNeeded(plan.deleteDestination),
      ],
      { encoding: 'utf8', env: childEnvironment(env), timeoutMs },
    );
  } catch (error) {
    throw new BuildError(
      `Build-key preflight against ${buildUser}@${targetHost} failed: ${error.message}`,
      { cause: error },
    );
  } finally {
    try {
      await fsImpl.rm(stagingDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      err.write(
        `Warning: could not remove the build-key preflight staging directory ${stagingDirectory}: ` +
          `${cleanupError.message}\n`,
      );
    }
  }
}

export async function runRemoteBuild({
  repoRoot,
  configPath,
  options = {},
  env = process.env,
  client = null,
  execImpl = runCommand,
  fsImpl = { mkdir, mkdtemp, readFile, rm, stat, writeFile },
  out = process.stdout,
  err = process.stderr,
  now = () => Date.now(),
  sleep = defaultSleep,
  rsyncInfo = null,
  publicKey = null,
  buildPublicKey = null,
  buildKeyMaterial = null,
  homedir,
  processImpl = process,
} = {}) {
  if (!repoRoot) {
    throw new BuildConfigError('A repository root is required for a remote build');
  }

  requireNonEmptyFlagValues(options);

  if (options.skipFilter) {
    out.write(
      `Warning: --skip-filter needs about ${formatGiB(BUILD_BOX_DISK_UNFILTERED_BYTES)}; ` +
        `${BUILD_BOX_DISK_POLICY}\n`,
    );
  }

  const resolvedConfigPath = configPath ?? path.join(repoRoot, 'config', 'layers.json');
  const configRelative = repositoryRelativePath(repoRoot, resolvedConfigPath, 'CONFIG_PATH');
  assertRemoteInputPath(configRelative, 'CONFIG_PATH');
  await requireLocalFile(fsImpl, repoRoot, configRelative, 'CONFIG_PATH');
  const config = loadBuildConfig(resolvedConfigPath);

  if (options.skipBuild) {
    throw new BuildConfigError(
      '--skip-build is not supported with --remote; a remote build starts from a fixture or planet',
    );
  }

  if (options.archive !== undefined && options.archive !== null) {
    if (String(options.archive).trim() === '') {
      throw new BuildConfigError('--archive requires a non-empty path with --remote');
    }

    throw new BuildConfigError(
      '--archive is not supported with --remote; a remote build starts from a fixture or planet',
    );
  }

  for (const [flag, name] of [
    ['install', '--install'],
    ['allowUnverifiedInstall', '--allow-unverified-install'],
    ['skipDownload', '--skip-download'],
  ]) {
    if (options[flag]) {
      throw new BuildConfigError(`${name} is not supported with --remote`);
    }
  }

  const sources = selectBuildSources(config, options.only);
  const box = resolveRemoteBuildConfig({ env, homedir, options, now });
  const outputDir =
    options.outputDir === undefined
      ? config.build.outputDir
      : normaliseOutputDir(options.outputDir, '--output-dir');
  const log = (line = '') => out.write(`${line}\n`);
  const logPath = path.posix.join(box.appDir, 'tmp', 'remote-build.log');
  const effectiveKeep = box.keep || Boolean(options.noTransfer);

  if (options.fixture) {
    const fixture = assertRemoteInputPath(
      repositoryRelativePath(repoRoot, options.fixture, '--fixture'),
      '--fixture',
    );
    await requireLocalFile(fsImpl, repoRoot, fixture, '--fixture');
    options = { ...options, fixture };
  }

  if (options.planetPbf) {
    const planetPbf = assertRemoteInputPath(
      repositoryRelativePath(repoRoot, options.planetPbf, '--planet-pbf'),
      '--planet-pbf',
    );
    await requireLocalFile(fsImpl, repoRoot, planetPbf, '--planet-pbf');
    options = { ...options, planetPbf };
  }

  // Ambient planet pins from .env belong to planet runs. Forwarding them into a fixture build makes
  // the fixture checksum validate against a planet checksum, so only explicit flags survive.
  if (firstValue(options.fixture) === '') {
    options = {
      ...options,
      planetUrl: firstValue(options.planetUrl, env.PLANET_URL),
      planetDate: firstValue(options.planetDate, env.PLANET_DATE),
      planetSha256: firstValue(options.planetSha256, env.PLANET_SHA256),
      planetMd5: firstValue(options.planetMd5, env.PLANET_MD5),
    };

    const pin = resolveRemotePlanetPin({ options, env, config });

    options = {
      ...options,
      planetUrl: pin.url,
      planetDate: pin.date,
      planetSha256: pin.sha256,
      planetMd5: pin.md5,
    };
  }

  const deployPublicKey =
    publicKey ??
    (await resolvePublicKey({
      privateKeyPath: box.deployPrivateKeyPath,
      publicKeyPath: box.deployPublicKeyPath,
      label: 'Deploy',
      env,
      execImpl,
    }));

  const cloudInit = renderBuildBoxCloudInit({
    deployKeys: [deployPublicKey],
    deployUser: box.deployUser,
    appDir: box.appDir,
    pmtilesVersion: config.build.tools.pmtiles,
  });
  const cloudInitBytes = Buffer.byteLength(cloudInit, 'utf8');

  if (options.dryRun) {
    for (const line of planLines({
      box,
      config,
      sources,
      options,
      outputDir,
      configPath: configRelative,
      cloudInitBytes,
    })) {
      log(line);
    }

    return {
      dryRun: true,
      serverName: box.serverName,
      serverType: box.serverType,
      location: box.location,
      image: box.image,
      sources,
      cloudInitBytes,
      keep: effectiveKeep,
    };
  }

  if (options.yes !== true) {
    throw new BuildConfigError(
      'Creating a billable Hetzner Cloud build box requires --yes; use --dry-run to preview',
    );
  }

  let keyMaterial = null;

  if (!options.noTransfer) {
    keyMaterial =
      buildKeyMaterial ??
      (await fsImpl.readFile(box.buildPrivateKeyPath, 'utf8').catch((error) => {
        throw new BuildConfigError(
          `Unable to read BUILD_SSH_PRIVATE_KEY_PATH at ${box.buildPrivateKeyPath}: ${error.message}`,
          { cause: error },
        );
      }));

    if (
      typeof keyMaterial !== 'string' ||
      keyMaterial.trim() === '' ||
      !PRIVATE_KEY_MATERIAL_PATTERN.test(keyMaterial)
    ) {
      throw new BuildConfigError(
        `BUILD_SSH_PRIVATE_KEY_PATH at ${box.buildPrivateKeyPath} is not a private key`,
      );
    }

    if (buildPublicKey === null) {
      await resolvePublicKey({
        privateKeyPath: box.buildPrivateKeyPath,
        publicKeyPath: box.buildPublicKeyPath,
        label: 'Build',
        env,
        execImpl,
      });
    }
  }

  if (options.noTransfer && !box.keep) {
    log(
      'Warning: --no-transfer keeps the build box so the only output is not destroyed; ' +
        'destroy it yourself once the archives are copied',
    );
  }

  const rsync = rsyncInfo ?? (await detectRsync({ execImpl, env }));
  const buildTimeoutMs = resolveOptionalTimeout({
    env,
    name: 'BUILD_BOX_TIMEOUT_MS',
    fallback: BUILD_BOX_TIMEOUT_MS,
  });
  const transferTimeoutMs = resolveOptionalTimeout({
    env,
    name: 'BUILD_BOX_TRANSFER_TIMEOUT_MS',
    fallback: BUILD_BOX_TRANSFER_TIMEOUT_MS,
  });

  await fsImpl.mkdir(path.join(repoRoot, 'tmp'), { recursive: true });
  const knownHostsPath = path.join(repoRoot, 'tmp', `ogis-build-known-hosts-${randomUUID()}`);

  if (!options.noTransfer) {
    const destinationIncomingDir = resolveDestinationIncomingDir({
      env,
      value: options.destinationIncomingDir,
    });
    const destinationDataDir = resolveDestinationDataDir({
      env,
      value: options.destinationDataDir,
    });
    const destinationConfig = {
      deployUser: box.deployUser,
      targetHost: box.host,
      deployPrivateKeyPath: box.deployPrivateKeyPath,
    };
    const { stdout: destinationDiskOutput } = await runRemote(
      destinationConfig,
      destinationDiskCommand({ dataDir: destinationDataDir }),
      {
        execImpl,
        env,
        timeoutMs: 60_000,
        label: 'Tile server disk preflight',
      },
    );
    const destinationDisk = parseDestinationDisk(destinationDiskOutput);
    assertDestinationDisk({
      ...destinationDisk,
      minFreeBytes: resolveDestinationMinFreeBytes({ env, value: options.destinationMinFreeBytes }),
      warn: log,
    });
    log(
      `Tile server data: ${formatGiB(destinationDisk.availableBytes)} free at ${destinationDataDir}`,
    );

    log('Checking the build key can write to the incoming directory');
    await preflightBuildKey({
      repoRoot,
      targetHost: box.host,
      buildUser: box.buildUser,
      source: sources[0],
      keyPath: box.buildPrivateKeyPath,
      execImpl,
      env,
      fsImpl,
      rsync,
      err,
    });

    log(`Build key writes to ${destinationIncomingDir}`);
  }

  const hcloud = client ?? createHcloudClient({ token: box.token });
  const keyPath = path.posix.join('/home', box.deployUser, BUILD_BOX_KEY_PATH);
  const remoteKeyPath = path.posix.join(path.posix.dirname(keyPath), path.posix.basename(keyPath));
  const recoveryKey = await ensureDeploySshKey({ client: hcloud, publicKey: deployPublicKey, err });
  let activeServer = null;
  let boxConfig = null;
  let keyInstalled = false;
  let keyTransferAttempted = false;
  let localKeyDirectory = null;
  let localKnownHostsPath = knownHostsPath;
  let buildStarted = false;
  let signalGuard = null;
  let cleanupStarted = false;

  const cleanupOnInterrupt = async () => {
    if (cleanupStarted) {
      return;
    }

    cleanupStarted = true;

    await cleanupInterruptedBuild({
      box,
      boxConfig,
      activeServer,
      hcloud,
      keyPath: remoteKeyPath,
      keyInstalled,
      keyTransferAttempted,
      localKeyDirectory,
      localKnownHostsPath,
      logPath,
      keep: effectiveKeep,
      execImpl,
      env,
      err,
      fsImpl,
      signal: signalGuard?.received() ?? 'interrupt',
    });

    keyInstalled = false;
    keyTransferAttempted = false;
    localKeyDirectory = null;
    localKnownHostsPath = null;
  };

  signalGuard = installRemoteBuildSignalGuard({
    cleanup: cleanupOnInterrupt,
    err,
    processImpl,
  });

  try {
    log(`Creating build box ${box.serverName} (${box.serverType} in ${box.location})`);
    log(`Image: ${box.image}; cloud-init: ${cloudInitBytes} bytes`);

    const image = await hcloud.findImageByName(box.image, 'x86');
    if (!image) {
      throw new BuildConfigError(`No available x86 system image named "${box.image}"`);
    }

    let created;
    try {
      created = await hcloud.createServer({
        name: box.serverName,
        serverType: box.serverType,
        location: box.location,
        image: box.image,
        userData: cloudInit,
        labels: { 'managed-by': 'ogis-tiles', role: 'build-box' },
        ...(recoveryKey?.id === undefined ? {} : { sshKeys: [recoveryKey.id] }),
      });
    } catch (error) {
      if (isTimeoutFailure(error)) {
        await cleanupCreateTimeout({ client: hcloud, box, err });
      }

      throw error;
    }

    if (!created?.server?.id) {
      throw new BuildError('Hetzner Cloud did not return the created build box');
    }

    activeServer = { id: created.server.id, ip: null };

    if (created.action?.id !== undefined) {
      await hcloud.waitForAction(created.action.id, {
        timeoutMs: BUILD_BOX_ACTION_TIMEOUT_MS,
        intervalMs: 5_000,
      });
    }

    const ready = await waitForServerReady({
      client: hcloud,
      serverId: activeServer.id,
      now,
      sleep,
    });
    activeServer.ip = ready.ip;
    boxConfig = {
      deployUser: box.deployUser,
      targetHost: ready.ip,
      deployPrivateKeyPath: box.deployPrivateKeyPath,
      knownHostsPath,
    };

    log(`Build box ready at ${ready.ip}`);

    await waitForBuildBoxSsh({ boxConfig, execImpl, env, sleep, now });

    log('Waiting for cloud-init and the pinned toolchain');
    await runRemote(boxConfig, BUILD_BOX_READY_COMMAND, {
      execImpl,
      env,
      timeoutMs: BUILD_BOX_CLOUD_INIT_TIMEOUT_MS,
      label: 'Build box cloud-init',
    });

    log('Checking free disk space before downloading');
    const { stdout: diskOutput } = await runRemote(
      boxConfig,
      diskSpaceCommand({ appDir: box.appDir }),
      {
        execImpl,
        env,
        timeoutMs: 60_000,
        label: 'Build box disk preflight',
      },
    );
    const availableBytes = parseAvailableBytes(diskOutput);
    const requiredBytes = requiredDiskBytes({
      fixture: options.fixture,
      skipFilter: options.skipFilter,
    });

    if (availableBytes < requiredBytes) {
      const reason = options.skipFilter
        ? `--skip-filter needs about ${formatGiB(requiredBytes)} and ${BUILD_BOX_DISK_POLICY}`
        : `this build needs about ${formatGiB(requiredBytes)}; use a larger server type or free space`;
      throw new BuildError(
        `Build box ${box.serverName} has ${formatGiB(availableBytes)} free but ${reason}`,
      );
    }

    log(
      `Disk: ${formatGiB(availableBytes)} free; ${formatGiB(requiredBytes)} required for this build`,
    );

    log('Rsyncing the repository to the build box');
    await execImpl(
      rsync.command,
      repositorySyncArguments({ repoRoot, boxConfig, appDir: box.appDir, rsync }),
      { encoding: 'utf8', env: childEnvironment(env) },
    );

    log('Installing dependencies on the build box');
    await runRemote(boxConfig, npmCiCommand({ appDir: box.appDir }), {
      execImpl,
      env,
      timeoutMs: 30 * 60 * 1000,
      label: 'npm ci on the build box',
    });

    log(`Building ${sources.join(', ')} on the build box`);
    buildStarted = true;
    const build = await runRemote(
      boxConfig,
      remoteBuildCommand({
        appDir: box.appDir,
        configPath: configRelative,
        outputDir,
        options,
        planetBuildHeap: env.PLANET_BUILD_HEAP,
        logPath,
      }),
      {
        execImpl,
        env,
        timeoutMs: buildTimeoutMs,
        label: 'Remote build',
      },
    );

    if (build.stdout) {
      out.write(build.stdout.endsWith('\n') ? build.stdout : `${build.stdout}\n`);
    }

    const transfers = [];

    if (options.noTransfer) {
      log('Skipping archive transfer (--no-transfer)');
    } else {
      log('Staging the build key on the build box');
      keyTransferAttempted = true;
      await uploadBuildKey({
        repoRoot,
        boxConfig,
        remoteKeyPath,
        keyMaterial,
        execImpl,
        env,
        fsImpl,
        err,
        onStagingDirectory: (directory) => {
          localKeyDirectory = directory;
        },
      });
      keyInstalled = true;

      for (const source of sources) {
        await runRemote(
          boxConfig,
          transferSourceCommand({
            appDir: box.appDir,
            outputDir,
            source,
            targetHost: box.host,
            buildUser: box.buildUser,
            keyPath: remoteKeyPath,
          }),
          {
            execImpl,
            env,
            timeoutMs: transferTimeoutMs,
            label: `Archive transfer (${source})`,
          },
        );

        const destination = `${box.buildUser}@${box.host}:${source}/`;
        transfers.push({ source, destination });
        log(`Transferred ${source} to ${destination}`);
      }

      keyInstalled = !(await removeBuildKey({
        boxConfig,
        keyPath: remoteKeyPath,
        execImpl,
        env,
        err,
        timeoutMs: BUILD_BOX_KEY_REMOVAL_TIMEOUT_MS,
      }));
    }

    let destroyed = false;

    if (effectiveKeep) {
      log(`Keeping build box ${box.serverName} (${activeServer.ip}); logs: ${logPath}`);
    } else {
      log(`Destroying build box ${box.serverName} (${activeServer.id})`);
      await destroyBuildBox(hcloud, activeServer.id);
      destroyed = true;
      log('Build box destroyed');
    }

    for (const transfer of transfers) {
      log(`Next: ogis promote --source=${transfer.source}`);
    }

    return {
      dryRun: false,
      serverName: box.serverName,
      serverId: activeServer.id,
      serverIp: activeServer.ip,
      kept: effectiveKeep,
      destroyed,
      logPath,
      transfers,
    };
  } catch (error) {
    if (localKeyDirectory) {
      try {
        await fsImpl.rm(localKeyDirectory, { recursive: true, force: true });
      } catch (cleanupError) {
        err.write(
          `Warning: could not remove the local build-key staging directory ${localKeyDirectory}: ` +
            `${cleanupError.message}\n`,
        );
      }
      localKeyDirectory = null;
    }

    if (boxConfig) {
      await copyBuildLog({ boxConfig, logPath, execImpl, env, err });
    }

    if (boxConfig && (keyInstalled || keyTransferAttempted)) {
      await removeBuildKey({
        boxConfig,
        keyPath: remoteKeyPath,
        execImpl,
        env,
        err,
        timeoutMs: BUILD_BOX_KEY_REMOVAL_TIMEOUT_MS,
      });
      keyInstalled = false;
      keyTransferAttempted = false;
    }

    if (!activeServer) {
      throw error instanceof BuildError
        ? error
        : new BuildError(error instanceof Error ? error.message : String(error), { cause: error });
    }

    const location = activeServer.ip ? `at ${activeServer.ip}` : 'while still initialising';

    if (!effectiveKeep && !buildStarted) {
      let destroyed = false;
      let destroyError = null;

      try {
        await destroyBuildBox(hcloud, activeServer.id);
        destroyed = true;
      } catch (cleanupError) {
        destroyError = cleanupError;
      }

      const state = destroyed
        ? `Build box ${box.serverName} (id ${activeServer.id}) was destroyed after a pre-build failure`
        : `Build box ${box.serverName} (id ${activeServer.id}) could not be destroyed after a ` +
          `pre-build failure (${destroyError.message}); ` +
          `destroy it with: hcloud server delete ${activeServer.id}`;

      throw new BuildError(`${error.message}. ${state}`, { cause: error });
    }

    const state =
      `Build box ${box.serverName} (id ${activeServer.id}) was kept ${location}; ` +
      `logs: ${logPath}. ` +
      `Destroy it with: hcloud server delete ${activeServer.id}`;

    throw new BuildError(`${error.message}. ${state}`, { cause: error });
  } finally {
    if (localKnownHostsPath) {
      try {
        await fsImpl.rm(localKnownHostsPath, { force: true });
      } catch (error) {
        err.write(
          `Warning: could not remove the per-run known_hosts file ${localKnownHostsPath}: ` +
            `${error.message}\n`,
        );
      }
    }

    signalGuard?.dispose();
  }
}
