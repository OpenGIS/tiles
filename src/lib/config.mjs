import { readFileSync } from 'node:fs';
import path from 'node:path';

const SOURCE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

const CONFIG_KEYS = ['version', 'server', 'sources'];
const SERVER_KEYS = ['host', 'port', 'publicBaseUrl', 'trustProxy'];
const COMMON_SOURCE_KEYS = ['kind', 'title', 'description', 'attribution', 'minzoom', 'maxzoom'];
const PMTILES_SOURCE_KEYS = [...COMMON_SOURCE_KEYS, 'archiveDir'];
const CONTOUR_SOURCE_KEYS = [
  ...COMMON_SOURCE_KEYS,
  'demUrl',
  'encoding',
  'demMaxzoom',
  'demTileSize',
  'cacheSize',
  'timeoutMs',
  'buffer',
  'extent',
  'contourLayer',
  'elevationKey',
  'levelKey',
  'thresholds',
  'cacheMaxAge',
];
const ATTRIBUTION_KEYS = ['title', 'href'];
const ENCODINGS = ['terrarium', 'mapbox'];
const THRESHOLD_ZOOM_PATTERN = /^(?:[0-9]|1[0-9]|2[0-6])$/;

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertAllowedKeys(value, allowedKeys, label) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new ConfigError(`${label} contains unknown key "${key}"`);
    }
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requireInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ConfigError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function optionalInteger(value, label, minimum, maximum, fallback) {
  if (value === undefined) {
    return fallback;
  }

  return requireInteger(value, label, minimum, maximum);
}

function validateDemUrl(value, label) {
  const demUrl = requireString(value, label);

  for (const placeholder of ['{z}', '{x}', '{y}']) {
    if (!demUrl.includes(placeholder)) {
      throw new ConfigError(`${label} must contain ${placeholder}`);
    }
  }

  let url;
  try {
    url = new URL(demUrl);
  } catch {
    throw new ConfigError(`${label} must be an absolute http or https URL`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${label} must use http or https`);
  }

  return demUrl;
}

function validateThresholds(value, label) {
  if (!isPlainObject(value)) {
    throw new ConfigError(`${label} must be an object`);
  }

  const keys = Object.keys(value);

  if (keys.length === 0) {
    throw new ConfigError(`${label} must contain at least one zoom level`);
  }

  const entries = keys.map((key) => {
    const entryLabel = `${label}.${key}`;

    if (!THRESHOLD_ZOOM_PATTERN.test(key) || String(Number(key)) !== key) {
      throw new ConfigError(`${entryLabel} must use a zoom level from 0 to 26`);
    }

    const interval = value[key];

    if (!Array.isArray(interval) || interval.length !== 2) {
      throw new ConfigError(`${entryLabel} must be a [minor, major] array`);
    }

    const [minor, major] = interval.map((number, index) => {
      if (!Number.isInteger(number) || number < 1) {
        throw new ConfigError(`${entryLabel}[${index}] must be an integer of at least 1`);
      }

      return number;
    });

    if (!(minor < major)) {
      throw new ConfigError(`${entryLabel} must have minor < major`);
    }

    return { zoom: Number(key), levels: [minor, major] };
  });

  entries.sort((a, b) => a.zoom - b.zoom);

  const thresholds = {};
  for (const { zoom, levels } of entries) {
    thresholds[String(zoom)] = levels;
  }

  return thresholds;
}

function resolveRepoRoot(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') {
    throw new ConfigError('repoRoot is required to resolve source archive directories');
  }

  return path.resolve(repoRoot);
}

function resolveArchiveDir(archiveDir, label, repoRoot) {
  if (path.isAbsolute(archiveDir)) {
    return path.normalize(archiveDir);
  }

  if (archiveDir.split(/[\\/]+/).includes('..')) {
    throw new ConfigError(`${label} must not contain ".."`);
  }

  const resolved = path.resolve(repoRoot, archiveDir);
  const relative = path.relative(repoRoot, resolved);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ConfigError(`${label} resolves outside the repository root`);
  }

  return resolved;
}

function validateAttribution(attribution, label) {
  if (!Array.isArray(attribution)) {
    throw new ConfigError(`${label} must be an array`);
  }

  return attribution.map((entry, index) => {
    const entryLabel = `${label}[${index}]`;
    if (!isPlainObject(entry)) {
      throw new ConfigError(`${entryLabel} must be an object`);
    }

    assertAllowedKeys(entry, ATTRIBUTION_KEYS, entryLabel);

    const href = requireString(entry.href, `${entryLabel}.href`);
    let url;
    try {
      url = new URL(href);
    } catch {
      throw new ConfigError(`${entryLabel}.href must be an absolute http or https URL`);
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new ConfigError(`${entryLabel}.href must use http or https`);
    }

    return {
      title: requireString(entry.title, `${entryLabel}.title`),
      href,
    };
  });
}

function validateSource(name, source, repoRoot) {
  const label = `sources.${name}`;

  if (!SOURCE_NAME_PATTERN.test(name)) {
    throw new ConfigError(
      `Source name "${name}" is invalid; names must match ${SOURCE_NAME_PATTERN}`,
    );
  }

  if (!isPlainObject(source)) {
    throw new ConfigError(`${label} must be an object`);
  }

  const kind = requireString(source.kind, `${label}.kind`);

  if (kind === 'pmtiles') {
    return validatePmtilesSource(label, source, repoRoot);
  }

  if (kind === 'contour') {
    return validateContourSource(label, source);
  }

  throw new ConfigError(
    `Source "${name}" has unknown kind "${kind}"; supported kinds are "pmtiles" and "contour"`,
  );
}

function validatePmtilesSource(label, source, repoRoot) {
  assertAllowedKeys(source, PMTILES_SOURCE_KEYS, label);

  const minzoom = requireInteger(source.minzoom, `${label}.minzoom`, 0, 26);
  const maxzoom = requireInteger(source.maxzoom, `${label}.maxzoom`, 0, 26);
  if (minzoom > maxzoom) {
    throw new ConfigError(`${label}.minzoom must not be greater than ${label}.maxzoom`);
  }

  return {
    kind: source.kind,
    title: requireString(source.title, `${label}.title`),
    description: requireString(source.description, `${label}.description`),
    attribution: validateAttribution(source.attribution, `${label}.attribution`),
    archiveDir: resolveArchiveDir(
      requireString(source.archiveDir, `${label}.archiveDir`),
      `${label}.archiveDir`,
      repoRoot,
    ),
    minzoom,
    maxzoom,
  };
}

function validateContourSource(label, source) {
  assertAllowedKeys(source, CONTOUR_SOURCE_KEYS, label);

  const minzoom = requireInteger(source.minzoom, `${label}.minzoom`, 1, 15);
  const maxzoom = requireInteger(source.maxzoom, `${label}.maxzoom`, 1, 15);
  if (minzoom > maxzoom) {
    throw new ConfigError(`${label}.minzoom must not be greater than ${label}.maxzoom`);
  }

  const encoding = requireString(source.encoding, `${label}.encoding`);
  if (!ENCODINGS.includes(encoding)) {
    throw new ConfigError(
      `${label}.encoding must be one of ${ENCODINGS.map((value) => `"${value}"`).join(', ')}`,
    );
  }

  const demMaxzoom = optionalInteger(source.demMaxzoom, `${label}.demMaxzoom`, 0, 17, 12);
  if (demMaxzoom > maxzoom) {
    throw new ConfigError(`${label}.demMaxzoom must not be greater than ${label}.maxzoom`);
  }

  return {
    kind: source.kind,
    title: requireString(source.title, `${label}.title`),
    description: requireString(source.description, `${label}.description`),
    attribution: validateAttribution(source.attribution, `${label}.attribution`),
    minzoom,
    maxzoom,
    demUrl: validateDemUrl(source.demUrl, `${label}.demUrl`),
    encoding,
    demMaxzoom,
    demTileSize: optionalInteger(source.demTileSize, `${label}.demTileSize`, 256, 2048, 512),
    cacheSize: optionalInteger(source.cacheSize, `${label}.cacheSize`, 1, 1000, 100),
    timeoutMs: optionalInteger(source.timeoutMs, `${label}.timeoutMs`, 1000, 60000, 10000),
    buffer: optionalInteger(source.buffer, `${label}.buffer`, 0, 64, 1),
    extent: optionalInteger(source.extent, `${label}.extent`, 256, 8192, 4096),
    contourLayer:
      source.contourLayer === undefined
        ? 'contours'
        : requireString(source.contourLayer, `${label}.contourLayer`),
    elevationKey:
      source.elevationKey === undefined
        ? 'ele'
        : requireString(source.elevationKey, `${label}.elevationKey`),
    levelKey:
      source.levelKey === undefined ? 'level' : requireString(source.levelKey, `${label}.levelKey`),
    thresholds: validateThresholds(source.thresholds, `${label}.thresholds`),
    cacheMaxAge: optionalInteger(source.cacheMaxAge, `${label}.cacheMaxAge`, 60, 86400, 86400),
  };
}

export function normalisePublicBaseUrl(value, label = 'server.publicBaseUrl') {
  const raw = requireString(value, label);

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`${label} must be a valid http or https URL`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${label} must use http or https`);
  }

  if (url.search !== '' || url.hash !== '') {
    throw new ConfigError(`${label} must not include a query string or fragment`);
  }

  const pathname = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${pathname}`;
}

export function validateConfig(config, { repoRoot } = {}) {
  const resolvedRoot = resolveRepoRoot(repoRoot);

  if (!isPlainObject(config)) {
    throw new ConfigError('Configuration must be a JSON object');
  }

  assertAllowedKeys(config, CONFIG_KEYS, 'Configuration');

  if (config.version !== 1) {
    throw new ConfigError(`Configuration version must be 1 (received ${config.version})`);
  }

  if (!isPlainObject(config.server)) {
    throw new ConfigError('server must be an object');
  }

  assertAllowedKeys(config.server, SERVER_KEYS, 'server');

  const host = requireString(config.server.host, 'server.host');
  const port = requireInteger(config.server.port, 'server.port', 1, 65535);

  const publicBaseUrl =
    config.server.publicBaseUrl === undefined || config.server.publicBaseUrl === null
      ? null
      : normalisePublicBaseUrl(config.server.publicBaseUrl);

  let trustProxy = false;
  if (config.server.trustProxy !== undefined) {
    if (typeof config.server.trustProxy !== 'boolean') {
      throw new ConfigError('server.trustProxy must be a boolean');
    }
    trustProxy = config.server.trustProxy;
  }

  if (!isPlainObject(config.sources) || Object.keys(config.sources).length === 0) {
    throw new ConfigError('sources must be a non-empty object');
  }

  const sources = {};

  for (const [name, source] of Object.entries(config.sources)) {
    sources[name] = validateSource(name, source, resolvedRoot);
  }

  return {
    version: 1,
    server: { host, port, publicBaseUrl, trustProxy },
    sources,
  };
}

export function loadConfig(configPath, { repoRoot } = {}) {
  const resolvedRoot = resolveRepoRoot(repoRoot);
  const absolutePath = path.resolve(configPath);
  let raw;

  try {
    raw = readFileSync(absolutePath, 'utf8');
  } catch (error) {
    throw new ConfigError(`Unable to read configuration at ${absolutePath}: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`Configuration at ${absolutePath} is not valid JSON: ${error.message}`);
  }

  return validateConfig(parsed, { repoRoot: resolvedRoot });
}
