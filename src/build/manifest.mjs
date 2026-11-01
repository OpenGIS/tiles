import { assertBuildId } from './build-id.mjs';
import { isRealCalendarDate, normaliseCalendarDate } from './dates.mjs';
import { BuildError } from './errors.mjs';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MD5_PATTERN = /^[a-f0-9]{32}$/;
const PLANET_BUILD_ID_PATTERN = /^(\d{8})-[a-f0-9]{12}$/;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BuildError(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function optionalString(value, label) {
  if (value === undefined || value === null) {
    return '';
  }

  if (typeof value !== 'string') {
    throw new BuildError(`${label} must be a string`);
  }

  return value.trim();
}

function requireInteger(value, label, minimum = 0) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new BuildError(`${label} must be an integer of at least ${minimum}`);
  }

  return value;
}

function validateBbox(bbox, label) {
  if (bbox === undefined || bbox === null) {
    return [];
  }

  if (!Array.isArray(bbox)) {
    throw new BuildError(`${label} must be a four-number array`);
  }

  if (bbox.length === 0) {
    return [];
  }

  if (bbox.length !== 4) {
    throw new BuildError(`${label} must be a four-number array`);
  }

  const values = bbox.map((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new BuildError(`${label}[${index}] must be a finite number`);
    }

    return value;
  });
  const [west, south, east, north] = values;

  if (west < -180 || east > 180) {
    throw new BuildError(`${label} longitudes must be between -180 and 180`);
  }

  if (south < -90 || north > 90) {
    throw new BuildError(`${label} latitudes must be between -90 and 90`);
  }

  if (!(west < east)) {
    throw new BuildError(`${label} must have west < east`);
  }

  if (!(south < north)) {
    throw new BuildError(`${label} must have south < north`);
  }

  return values;
}

function normaliseFixture(fixture) {
  if (fixture === undefined || fixture === null) {
    return null;
  }

  if (!isPlainObject(fixture)) {
    throw new BuildError('fixture must be an object when present');
  }

  return {
    ...fixture,
    extractDate: normaliseCalendarDate(fixture.extractDate ?? '', 'fixture.extractDate'),
    bbox: validateBbox(fixture.bbox, 'fixture.bbox'),
  };
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new BuildError(`${label} must be a 64 character lowercase hexadecimal SHA-256 digest`);
  }

  return value;
}

function validateBuildIdContentAddressing({ buildId, mode, archiveSha256, planetDate }) {
  const expectedHash = archiveSha256.slice(0, 12);
  const actualHash = buildId.slice(-12);

  if (actualHash !== expectedHash) {
    throw new BuildError(
      `buildId hash suffix "${actualHash}" must match the first 12 characters of archive.sha256 ("${expectedHash}")`,
    );
  }

  if (mode === 'fixture') {
    if (!buildId.startsWith('fixture-')) {
      throw new BuildError(`buildId "${buildId}" must start with "fixture-" for fixture builds`);
    }

    return;
  }

  const match = PLANET_BUILD_ID_PATTERN.exec(buildId);
  if (match === null) {
    throw new BuildError(
      `buildId "${buildId}" must use "<YYYYMMDD>-<12 lowercase hex>" for planet builds`,
    );
  }

  const datePrefix = match[1];
  const date = `${datePrefix.slice(0, 4)}-${datePrefix.slice(4, 6)}-${datePrefix.slice(6, 8)}`;

  if (!isRealCalendarDate(date)) {
    throw new BuildError(`buildId date prefix "${datePrefix}" must be a real calendar date`);
  }

  if (planetDate !== '' && datePrefix !== planetDate.replaceAll('-', '')) {
    throw new BuildError(
      `buildId date prefix "${datePrefix}" must match planet.date "${planetDate}"`,
    );
  }
}

function requireBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new BuildError(`${label} must be a boolean`);
  }

  return value;
}

function validateToolRecord(value, label) {
  if (typeof value === 'string') {
    return { version: requireString(value, label), path: '', sha256: '' };
  }

  if (!isPlainObject(value)) {
    throw new BuildError(`${label} must be a string or an object`);
  }

  const sha256 = optionalString(value.sha256, `${label}.sha256`).toLowerCase();
  if (sha256 !== '' && !SHA256_PATTERN.test(sha256)) {
    throw new BuildError(`${label}.sha256 must be empty or a SHA-256 digest`);
  }

  return {
    version: requireString(value.version, `${label}.version`),
    path: optionalString(value.path, `${label}.path`),
    sha256,
  };
}

function requiredAttributesFromVerification(verification) {
  if (!isPlainObject(verification)) {
    return [];
  }

  if (Array.isArray(verification.layers)) {
    return [...new Set(verification.layers.flatMap((entry) => entry.requiredAttributes ?? []))];
  }

  return Array.isArray(verification.requiredAttributes) ? verification.requiredAttributes : [];
}

export function assertSizeFloor({ bytes, floor, label = 'archive' }) {
  requireInteger(floor, 'size floor', 1);
  requireInteger(bytes, `${label} bytes`, 0);

  if (bytes < floor) {
    throw new BuildError(`${label} is ${bytes} bytes, below the size floor of ${floor} bytes`);
  }

  return bytes;
}

export function assertSampleTile(sample, { label = 'sample tile', requiredAttributes = [] } = {}) {
  if (!isPlainObject(sample)) {
    throw new BuildError(`${label} must be an object`);
  }

  requireInteger(sample.features, `${label} feature count`, 1);

  const layer = requireString(sample.layer, `${label} layer`);
  if (!Array.isArray(sample.attributes)) {
    throw new BuildError(`${label} attributes must be an array`);
  }

  for (const required of requiredAttributes) {
    if (!sample.attributes.includes(required)) {
      throw new BuildError(`${label} is missing the "${required}" attribute`);
    }
  }

  return { layer, features: sample.features };
}

export function assertVerification({
  verification,
  samples,
  floor,
  bytes,
  tiles,
  requiredAttributes = [],
  label = 'archive',
}) {
  if (!isPlainObject(verification) || verification.ok !== true) {
    throw new BuildError(`${label} failed PMTiles verification`);
  }

  assertSizeFloor({ bytes, floor, label });

  if (tiles !== undefined && requireInteger(tiles, 'addressed tile count', 0) < 1) {
    throw new BuildError(`${label} contains no addressed tiles`);
  }

  if (!Array.isArray(samples) || samples.length === 0) {
    throw new BuildError('At least one sample tile must be verified');
  }

  for (const [index, sample] of samples.entries()) {
    assertSampleTile(sample, {
      label: `sample tile ${index + 1}`,
      requiredAttributes,
    });
  }

  return true;
}

export function createBuildManifest({
  buildId,
  runId,
  source,
  mode,
  minzoom,
  maxzoom,
  planet,
  fixture,
  tools,
  profile,
  filter,
  skips,
  verification,
  archive,
  samples,
  sizeFloor,
  createdAt = new Date().toISOString(),
}) {
  const manifest = {
    buildId,
    runId: runId ?? '',
    source,
    mode,
    minzoom,
    maxzoom,
    planet: {
      date: normaliseCalendarDate(planet.date ?? '', 'planet.date'),
      url: planet.url ?? '',
      sha256: planet.sha256 ?? '',
      md5: planet.md5 ?? '',
    },
    fixture: normaliseFixture(fixture),
    tools: {
      planetiler: {
        version: tools.planetiler.version,
        url: tools.planetiler.url ?? '',
        sha256: tools.planetiler.sha256 ?? '',
        path: tools.planetiler.path ?? '',
      },
      pmtiles: {
        version: tools.pmtiles.version,
        sha256: tools.pmtiles.sha256,
        pinned: tools.pmtiles.pinned ?? '',
      },
      java: tools.java,
      osmium: tools.osmium,
    },
    profile: {
      path: profile.path,
      sha256: profile.sha256,
    },
    filter: {
      sha256: filter.sha256,
      expressions: filter.expressions,
      applied: Boolean(filter.applied),
      skipped: Boolean(filter.skipped),
    },
    skips: {
      download: Boolean(skips?.download),
      filter: Boolean(skips?.filter),
      build: Boolean(skips?.build),
      verify: Boolean(skips?.verify),
    },
    verification: {
      ok: Boolean(verification?.ok),
      skipped: Boolean(verification?.skipped),
      layers: verification?.layers ?? [],
    },
    archive: {
      path: archive.path,
      sha256: archive.sha256,
      bytes: archive.bytes,
      tiles: archive.tiles,
      compression: archive.compression ?? '',
      metadata: archive.metadata ?? { available: false },
    },
    samples,
    sizeFloor,
    createdAt,
  };

  validateBuildManifest(manifest);
  return manifest;
}

export function validateBuildManifest(manifest) {
  if (!isPlainObject(manifest)) {
    throw new BuildError('Build manifest must be an object');
  }

  const buildId = requireString(manifest.buildId, 'buildId');
  assertBuildId(buildId);

  requireString(manifest.source, 'source');

  if (manifest.mode !== 'fixture' && manifest.mode !== 'planet') {
    throw new BuildError('mode must be "fixture" or "planet"');
  }

  if (manifest.minzoom !== undefined) {
    const minzoom = requireInteger(manifest.minzoom, 'minzoom', 0);
    const maxzoom = requireInteger(manifest.maxzoom, 'maxzoom', 0);

    if (minzoom > maxzoom) {
      throw new BuildError('minzoom must not be greater than maxzoom');
    }
  }

  if (!isPlainObject(manifest.planet)) {
    throw new BuildError('planet must be an object');
  }
  if (typeof manifest.planet.url !== 'string') {
    throw new BuildError('planet.url must be a string');
  }
  const planetDate = normaliseCalendarDate(manifest.planet.date, 'planet.date');
  if (manifest.mode === 'planet' && planetDate === '') {
    throw new BuildError('planet.date is required for planet builds');
  }
  if (manifest.planet.sha256 !== '' && !SHA256_PATTERN.test(manifest.planet.sha256 ?? '')) {
    throw new BuildError('planet.sha256 must be empty or a SHA-256 digest');
  }
  const planetMd5 = manifest.planet.md5 ?? '';
  if (planetMd5 !== '' && !MD5_PATTERN.test(planetMd5)) {
    throw new BuildError('planet.md5 must be empty or an MD5 digest');
  }

  if (manifest.fixture !== undefined && manifest.fixture !== null) {
    if (!isPlainObject(manifest.fixture)) {
      throw new BuildError('fixture must be an object when present');
    }
    requireString(manifest.fixture.path, 'fixture.path');
    requireSha256(manifest.fixture.sha256, 'fixture.sha256');
    normaliseCalendarDate(manifest.fixture.extractDate ?? '', 'fixture.extractDate');
    validateBbox(manifest.fixture.bbox, 'fixture.bbox');
  }

  if (!isPlainObject(manifest.tools) || !isPlainObject(manifest.tools.planetiler)) {
    throw new BuildError('tools must describe Planetiler, pmtiles, Java and osmium');
  }
  requireString(manifest.tools.planetiler.version, 'tools.planetiler.version');
  if (
    manifest.tools.planetiler.sha256 !== '' &&
    !SHA256_PATTERN.test(manifest.tools.planetiler.sha256 ?? '')
  ) {
    throw new BuildError('tools.planetiler.sha256 must be empty or a SHA-256 digest');
  }
  if (!isPlainObject(manifest.tools.pmtiles)) {
    throw new BuildError('tools.pmtiles must be an object');
  }
  requireString(manifest.tools.pmtiles.version, 'tools.pmtiles.version');
  requireSha256(manifest.tools.pmtiles.sha256, 'tools.pmtiles.sha256');
  requireString(manifest.tools.pmtiles.pinned, 'tools.pmtiles.pinned');
  validateToolRecord(manifest.tools.java, 'tools.java');
  validateToolRecord(manifest.tools.osmium, 'tools.osmium');

  if (!isPlainObject(manifest.profile)) {
    throw new BuildError('profile must be an object');
  }
  requireString(manifest.profile.path, 'profile.path');
  requireSha256(manifest.profile.sha256, 'profile.sha256');

  if (!isPlainObject(manifest.filter)) {
    throw new BuildError('filter must be an object');
  }
  requireSha256(manifest.filter.sha256, 'filter.sha256');
  requireInteger(manifest.filter.expressions, 'filter.expressions', 0);
  if (manifest.filter.applied !== undefined) {
    requireBoolean(manifest.filter.applied, 'filter.applied');
    requireBoolean(manifest.filter.skipped, 'filter.skipped');
  }

  if (manifest.skips !== undefined) {
    if (!isPlainObject(manifest.skips)) {
      throw new BuildError('skips must be an object');
    }

    for (const key of ['download', 'filter', 'build', 'verify']) {
      if (manifest.skips[key] !== undefined) {
        requireBoolean(manifest.skips[key], `skips.${key}`);
      }
    }
  }

  if (manifest.verification !== undefined) {
    if (!isPlainObject(manifest.verification)) {
      throw new BuildError('verification must be an object');
    }

    requireBoolean(manifest.verification.ok, 'verification.ok');
    requireBoolean(manifest.verification.skipped, 'verification.skipped');

    if (manifest.verification.skipped === true && manifest.verification.ok === true) {
      throw new BuildError('verification.ok must be false when verification was skipped');
    }

    if (manifest.verification.layers !== undefined) {
      if (!Array.isArray(manifest.verification.layers)) {
        throw new BuildError('verification.layers must be an array');
      }

      for (const [index, entry] of manifest.verification.layers.entries()) {
        if (!isPlainObject(entry)) {
          throw new BuildError(`verification.layers[${index}] must be an object`);
        }
        requireString(entry.layer, `verification.layers[${index}].layer`);
        if (!Array.isArray(entry.requiredAttributes)) {
          throw new BuildError(`verification.layers[${index}].requiredAttributes must be an array`);
        }

        for (const [attributeIndex, attribute] of entry.requiredAttributes.entries()) {
          requireString(
            attribute,
            `verification.layers[${index}].requiredAttributes[${attributeIndex}]`,
          );
        }
      }
    }
  }

  if (!isPlainObject(manifest.archive)) {
    throw new BuildError('archive must be an object');
  }
  requireString(manifest.archive.path, 'archive.path');
  requireSha256(manifest.archive.sha256, 'archive.sha256');
  validateBuildIdContentAddressing({
    buildId,
    mode: manifest.mode,
    archiveSha256: manifest.archive.sha256,
    planetDate,
  });
  requireInteger(manifest.archive.bytes, 'archive.bytes', 1);
  requireInteger(manifest.archive.tiles, 'archive.tiles', 0);

  if (manifest.verification?.ok === true && manifest.archive.tiles < 1) {
    throw new BuildError('archive.tiles must be at least 1 when verification passed');
  }

  if (!Array.isArray(manifest.samples)) {
    throw new BuildError('samples must be an array');
  }

  const requiredAttributes = requiredAttributesFromVerification(manifest.verification);
  const verificationSkipped = manifest.verification?.skipped === true;

  if (!verificationSkipped && manifest.samples.length === 0) {
    throw new BuildError('samples must contain at least one verified tile');
  }

  for (const [index, sample] of manifest.samples.entries()) {
    requireInteger(sample?.z, `samples[${index}].z`, 0);
    requireInteger(sample?.x, `samples[${index}].x`, 0);
    requireInteger(sample?.y, `samples[${index}].y`, 0);
    assertSampleTile(sample, {
      label: `samples[${index}]`,
      requiredAttributes,
    });
  }

  requireInteger(manifest.sizeFloor, 'sizeFloor', 1);

  if (typeof manifest.createdAt !== 'string' || Number.isNaN(Date.parse(manifest.createdAt))) {
    throw new BuildError('createdAt must be an ISO date string');
  }

  return manifest;
}
