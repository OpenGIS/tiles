import { readFileSync } from 'node:fs';
import path from 'node:path';

import { isRealCalendarDate } from './dates.mjs';
import { BuildConfigError } from './errors.mjs';

const SOURCE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const PROFILE_PATTERN = /^[a-z][a-z0-9-]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EXPRESSION_PATTERN = /^[nwr]+\/\S+$/;
const PLANETILER_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const KNOWN_MODES = ['fixture', 'planet'];

const BUILD_KEYS = ['planet', 'tools', 'outputDir'];
const PLANET_KEYS = ['date', 'url', 'sha256'];
const TOOL_KEYS = ['planetiler', 'pmtiles'];
const PLANETILER_KEYS = ['version', 'url', 'sha256'];
const SOURCE_BUILD_KEYS = [
  'profile',
  'profileKind',
  'profileFile',
  'heap',
  'heapPlanet',
  'minzoom',
  'maxzoom',
  'expressions',
  'sampleTiles',
  'sizeFloor',
  'verification',
];
const SAMPLE_TILE_KEYS = ['z', 'x', 'y'];
const VERIFICATION_KEYS = ['layer', 'requiredAttributes', 'geometry', 'layers'];
const VERIFICATION_LAYER_KEYS = ['layer', 'requiredAttributes', 'geometry'];
const PROFILE_KINDS = ['yaml', 'java'];
const PROFILE_FILE_PATTERN = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:java|ya?ml)$/;
const HEAP_PATTERN = /^\d+[mg]$/i;
const GEOMETRIES = ['point', 'line', 'polygon'];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertAllowedKeys(value, allowedKeys, label) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) {
      throw new BuildConfigError(`${label} contains unknown key "${key}"`);
    }
  }
}

function requireString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') {
    throw new BuildConfigError(`${label} must be a string`);
  }

  const trimmed = value.trim();
  if (!allowEmpty && trimmed === '') {
    throw new BuildConfigError(`${label} must be a non-empty string`);
  }

  return trimmed;
}

function requireInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new BuildConfigError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }

  return value;
}

export function normalisePlanetUrl(value, label = 'planet URL') {
  const url = requireString(value, label);
  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    throw new BuildConfigError(`${label} must be an absolute http or https URL`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BuildConfigError(`${label} must use http or https`);
  }

  return url;
}

export function normalisePlanetSha256(value, label = 'planet SHA-256') {
  const digest = requireString(value, label);

  if (!SHA256_PATTERN.test(digest)) {
    throw new BuildConfigError(`${label} must be a lowercase 64 character hexadecimal digest`);
  }

  return digest;
}

export function normalisePlanetDate(value, label = 'planet date') {
  const date = requireString(value, label);

  if (!isRealCalendarDate(date)) {
    throw new BuildConfigError(`${label} must be a real calendar date in YYYY-MM-DD format`);
  }

  return date;
}

function optionalUrl(value, label) {
  const url = requireString(value, label, { allowEmpty: true });
  return url === '' ? '' : normalisePlanetUrl(url, label);
}

function optionalSha256(value, label) {
  const digest = requireString(value, label, { allowEmpty: true });
  return digest === '' ? '' : normalisePlanetSha256(digest, label);
}

function validatePlanet(planet) {
  if (!isPlainObject(planet)) {
    throw new BuildConfigError('build.planet must be an object');
  }

  assertAllowedKeys(planet, PLANET_KEYS, 'build.planet');

  const rawDate = requireString(planet.date, 'build.planet.date', { allowEmpty: true });

  return {
    date: rawDate === '' ? '' : normalisePlanetDate(rawDate, 'build.planet.date'),
    url: optionalUrl(planet.url, 'build.planet.url'),
    sha256: optionalSha256(planet.sha256, 'build.planet.sha256'),
  };
}

function validateTools(tools) {
  if (!isPlainObject(tools)) {
    throw new BuildConfigError('build.tools must be an object');
  }

  assertAllowedKeys(tools, TOOL_KEYS, 'build.tools');

  if (!isPlainObject(tools.planetiler)) {
    throw new BuildConfigError('build.tools.planetiler must be an object');
  }

  assertAllowedKeys(tools.planetiler, PLANETILER_KEYS, 'build.tools.planetiler');

  const version = requireString(tools.planetiler.version, 'build.tools.planetiler.version');
  if (!PLANETILER_VERSION_PATTERN.test(version)) {
    throw new BuildConfigError(
      'build.tools.planetiler.version must contain only letters, digits, dots, underscores and dashes',
    );
  }

  const url = optionalUrl(tools.planetiler.url, 'build.tools.planetiler.url');
  const sha256 = optionalSha256(tools.planetiler.sha256, 'build.tools.planetiler.sha256');

  if (url !== '' && sha256 === '') {
    throw new BuildConfigError(
      'build.tools.planetiler.sha256 is required whenever build.tools.planetiler.url is configured',
    );
  }

  return {
    planetiler: { version, url, sha256 },
    pmtiles: requireString(tools.pmtiles, 'build.tools.pmtiles'),
  };
}

function validateSizeFloor(value, label) {
  if (Number.isInteger(value)) {
    if (value <= 0) {
      throw new BuildConfigError(`${label} must be a positive integer`);
    }

    return { default: value };
  }

  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    throw new BuildConfigError(`${label} must be a positive integer or a non-empty object`);
  }

  const floor = {};
  for (const [mode, bytes] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9-]*$/.test(mode)) {
      throw new BuildConfigError(`${label}.${mode} must use a lower-case mode name`);
    }

    if (!Number.isInteger(bytes) || bytes <= 0) {
      throw new BuildConfigError(`${label}.${mode} must be a positive integer`);
    }

    floor[mode] = bytes;
  }

  const hasDefault = Object.hasOwn(floor, 'default');
  const hasEveryKnownMode = KNOWN_MODES.every((mode) => Object.hasOwn(floor, mode));

  if (!hasDefault && !hasEveryKnownMode) {
    throw new BuildConfigError(
      `${label} must define "default" or floors for every known mode (${KNOWN_MODES.join(', ')})`,
    );
  }

  return floor;
}

function validateSampleTiles(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BuildConfigError(`${label} must be a non-empty array`);
  }

  return value.map((tile, index) => {
    const tileLabel = `${label}[${index}]`;
    if (!isPlainObject(tile)) {
      throw new BuildConfigError(`${tileLabel} must be an object`);
    }

    assertAllowedKeys(tile, SAMPLE_TILE_KEYS, tileLabel);

    const z = requireInteger(tile.z, `${tileLabel}.z`, 0, 26);
    const maximum = 2 ** z - 1;

    return {
      z,
      x: requireInteger(tile.x, `${tileLabel}.x`, 0, maximum),
      y: requireInteger(tile.y, `${tileLabel}.y`, 0, maximum),
    };
  });
}

function validateExpressions(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BuildConfigError(`${label} must be a non-empty array`);
  }

  const expressions = [];
  const seen = new Set();

  for (const [index, entry] of value.entries()) {
    if (typeof entry === 'string' && /[\r\n]/.test(entry)) {
      throw new BuildConfigError(`${label}[${index}] must not contain CR or LF characters`);
    }

    const expression = requireString(entry, `${label}[${index}]`);

    if (/[\r\n]/.test(expression)) {
      throw new BuildConfigError(`${label}[${index}] must not contain CR or LF characters`);
    }

    if (!EXPRESSION_PATTERN.test(expression)) {
      throw new BuildConfigError(
        `${label}[${index}] must start with an object selector and a slash`,
      );
    }

    if (seen.has(expression)) {
      throw new BuildConfigError(`${label}[${index}] duplicates the expression "${expression}"`);
    }

    seen.add(expression);
    expressions.push(expression);
  }

  return expressions;
}

function validateRequiredAttributes(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BuildConfigError(`${label} must be a non-empty array`);
  }

  return value.map((entry, index) => requireString(entry, `${label}[${index}]`));
}

function validateVerificationLayer(value, label) {
  if (!isPlainObject(value)) {
    throw new BuildConfigError(`${label} must be an object`);
  }

  assertAllowedKeys(value, VERIFICATION_LAYER_KEYS, label);

  const layer = {
    layer: requireString(value.layer, `${label}.layer`),
    requiredAttributes: validateRequiredAttributes(
      value.requiredAttributes,
      `${label}.requiredAttributes`,
    ),
  };

  if (value.geometry !== undefined) {
    const geometry = requireString(value.geometry, `${label}.geometry`);
    if (!GEOMETRIES.includes(geometry)) {
      throw new BuildConfigError(
        `${label}.geometry must be one of ${GEOMETRIES.map((entry) => `"${entry}"`).join(', ')}`,
      );
    }
    layer.geometry = geometry;
  }

  return layer;
}

function validateVerification(value, label) {
  if (!isPlainObject(value)) {
    throw new BuildConfigError(`${label} must be an object`);
  }

  assertAllowedKeys(value, VERIFICATION_KEYS, label);

  if (value.layers !== undefined) {
    if (
      value.layer !== undefined ||
      value.requiredAttributes !== undefined ||
      !Array.isArray(value.layers) ||
      value.layers.length === 0
    ) {
      throw new BuildConfigError(`${label}.layers must be a non-empty array without layer fields`);
    }

    const layers = value.layers.map((entry, index) =>
      validateVerificationLayer(entry, `${label}.layers[${index}]`),
    );
    const seen = new Set();

    for (const [index, entry] of layers.entries()) {
      if (seen.has(entry.layer)) {
        throw new BuildConfigError(`${label}.layers[${index}] duplicates "${entry.layer}"`);
      }

      seen.add(entry.layer);
    }

    return { layers };
  }

  return validateVerificationLayer(value, label);
}

export function normaliseOutputDir(value, label = 'build.outputDir') {
  const outputDir = requireString(value, label);

  if (
    path.isAbsolute(outputDir) ||
    outputDir.split(/[\\/]+/).includes('..') ||
    outputDir.split(/[\\/]+/).includes('.') ||
    outputDir === '.'
  ) {
    throw new BuildConfigError(`${label} must be a relative directory inside the repository`);
  }

  return outputDir;
}

function validateArchiveDir(value, label) {
  const archiveDir = requireString(value, label);

  if (path.isAbsolute(archiveDir)) {
    throw new BuildConfigError(`${label} must be a relative directory`);
  }

  if (archiveDir.split(/[\\/]+/).includes('..')) {
    throw new BuildConfigError(`${label} must not contain ".."`);
  }

  if (archiveDir === '.') {
    throw new BuildConfigError(`${label} must not be the repository root`);
  }

  return archiveDir;
}

function validateProfileKind(value, label) {
  if (value === undefined) {
    return undefined;
  }

  const kind = requireString(value, label);
  if (!PROFILE_KINDS.includes(kind)) {
    throw new BuildConfigError(
      `${label} must be one of ${PROFILE_KINDS.map((entry) => `"${entry}"`).join(', ')}`,
    );
  }

  return kind;
}

function validateProfileFile(value, label) {
  if (value === undefined) {
    return undefined;
  }

  const file = requireString(value, label);
  if (
    path.isAbsolute(file) ||
    file.split(/[\\/]+/).includes('..') ||
    file.split(/[\\/]+/).includes('.')
  ) {
    throw new BuildConfigError(`${label} must be a relative path inside the repository`);
  }

  if (!PROFILE_FILE_PATTERN.test(file)) {
    throw new BuildConfigError(`${label} must be a .java or .yml profile file`);
  }

  return file;
}

export function normaliseHeap(value, label = 'heap') {
  if (value === undefined) {
    return undefined;
  }

  const heap = requireString(value, label);
  if (!HEAP_PATTERN.test(heap)) {
    throw new BuildConfigError(`${label} must be a heap size such as "512m" or "2g"`);
  }

  return heap;
}

function validateSourceBuild(name, source) {
  const label = `sources.${name}.build`;

  if (!isPlainObject(source.build)) {
    throw new BuildConfigError(`${label} must be an object`);
  }

  assertAllowedKeys(source.build, SOURCE_BUILD_KEYS, label);

  const profile = requireString(source.build.profile, `${label}.profile`);
  if (!PROFILE_PATTERN.test(profile)) {
    throw new BuildConfigError(`${label}.profile must match ${PROFILE_PATTERN}`);
  }

  const profileKind = validateProfileKind(source.build.profileKind, `${label}.profileKind`);
  const profileFile = validateProfileFile(source.build.profileFile, `${label}.profileFile`);
  const heap = normaliseHeap(source.build.heap, `${label}.heap`);
  const heapPlanet = normaliseHeap(source.build.heapPlanet, `${label}.heapPlanet`);

  const minzoom = requireInteger(source.build.minzoom, `${label}.minzoom`, 0, 26);
  const maxzoom = requireInteger(source.build.maxzoom, `${label}.maxzoom`, 0, 26);
  if (minzoom > maxzoom) {
    throw new BuildConfigError(`${label}.minzoom must not be greater than ${label}.maxzoom`);
  }

  return {
    archiveDir: validateArchiveDir(source.archiveDir, `sources.${name}.archiveDir`),
    profile,
    ...(profileKind === undefined ? {} : { profileKind }),
    ...(profileFile === undefined ? {} : { profileFile }),
    ...(heap === undefined ? {} : { heap }),
    ...(heapPlanet === undefined ? {} : { heapPlanet }),
    minzoom,
    maxzoom,
    expressions: validateExpressions(source.build.expressions, `${label}.expressions`),
    sampleTiles: validateSampleTiles(source.build.sampleTiles, `${label}.sampleTiles`),
    sizeFloor: validateSizeFloor(source.build.sizeFloor, `${label}.sizeFloor`),
    verification: validateVerification(source.build.verification, `${label}.verification`),
  };
}

export function validateBuildConfig(config) {
  if (!isPlainObject(config)) {
    throw new BuildConfigError('Configuration must be a JSON object');
  }

  if (!isPlainObject(config.build)) {
    throw new BuildConfigError('build must be an object');
  }

  assertAllowedKeys(config.build, BUILD_KEYS, 'build');

  const outputDir = normaliseOutputDir(config.build.outputDir, 'build.outputDir');

  if (!isPlainObject(config.sources)) {
    throw new BuildConfigError('sources must be an object');
  }

  const sources = {};

  for (const [name, source] of Object.entries(config.sources)) {
    if (!isPlainObject(source) || source.build === undefined) {
      continue;
    }

    if (!SOURCE_NAME_PATTERN.test(name)) {
      throw new BuildConfigError(`Source name "${name}" is invalid`);
    }

    if (source.kind !== 'pmtiles') {
      throw new BuildConfigError(`sources.${name}.build is only supported on pmtiles sources`);
    }

    sources[name] = validateSourceBuild(name, source);
  }

  if (Object.keys(sources).length === 0) {
    throw new BuildConfigError('No source declares a build profile');
  }

  const archiveDirs = new Map();
  for (const [name, source] of Object.entries(sources)) {
    const key = path.posix.normalize(source.archiveDir.replaceAll('\\', '/')).replace(/\/+$/, '');
    const existing = archiveDirs.get(key);

    if (existing !== undefined) {
      throw new BuildConfigError(
        `sources.${name}.archiveDir resolves to the same directory as sources.${existing}.archiveDir`,
      );
    }

    archiveDirs.set(key, name);
  }

  return {
    build: {
      planet: validatePlanet(config.build.planet),
      tools: validateTools(config.build.tools),
      outputDir,
    },
    sources,
  };
}

export function loadBuildConfig(configPath) {
  const absolutePath = path.resolve(configPath);
  let raw;

  try {
    raw = readFileSync(absolutePath, 'utf8');
  } catch (error) {
    throw new BuildConfigError(`Unable to read configuration at ${absolutePath}: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new BuildConfigError(
      `Configuration at ${absolutePath} is not valid JSON: ${error.message}`,
    );
  }

  return { ...validateBuildConfig(parsed), raw: parsed };
}

export function resolveSizeFloor(sizeFloor, mode) {
  if (Number.isInteger(sizeFloor)) {
    return sizeFloor;
  }

  if (Number.isInteger(sizeFloor?.[mode])) {
    return sizeFloor[mode];
  }

  if (Number.isInteger(sizeFloor?.default)) {
    return sizeFloor.default;
  }

  throw new BuildConfigError(`No size floor is configured for mode "${mode}"`);
}
