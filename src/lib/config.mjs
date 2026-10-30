import { readFileSync } from 'node:fs';
import path from 'node:path';

const SOURCE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

const CONFIG_KEYS = ['version', 'server', 'sources'];
const SERVER_KEYS = ['host', 'port', 'publicBaseUrl', 'trustProxy'];
const SOURCE_KEYS = [
  'kind',
  'title',
  'description',
  'attribution',
  'archiveDir',
  'minzoom',
  'maxzoom',
];
const ATTRIBUTION_KEYS = ['title', 'href'];

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

  assertAllowedKeys(source, SOURCE_KEYS, label);

  const kind = requireString(source.kind, `${label}.kind`);
  if (kind !== 'pmtiles') {
    throw new ConfigError(
      `Source "${name}" has unknown kind "${kind}"; only "pmtiles" is supported`,
    );
  }

  const minzoom = requireInteger(source.minzoom, `${label}.minzoom`, 0, 26);
  const maxzoom = requireInteger(source.maxzoom, `${label}.maxzoom`, 0, 26);
  if (minzoom > maxzoom) {
    throw new ConfigError(`${label}.minzoom must not be greater than ${label}.maxzoom`);
  }

  return {
    kind,
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
