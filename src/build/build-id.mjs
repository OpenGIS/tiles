import { createHash } from 'node:crypto';

import { isRealCalendarDate } from './dates.mjs';
import { BuildError } from './errors.mjs';

const SHORT_HASH_LENGTH = 12;
const BUILD_ID_HASH_LENGTH = 12;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BUILD_ID_PATTERN = /^(?:fixture|[0-9]{8})-[a-f0-9]{12}$/;

export function isBuildId(value) {
  if (typeof value !== 'string' || !BUILD_ID_PATTERN.test(value)) {
    return false;
  }

  if (value.startsWith('fixture-')) {
    return true;
  }

  const compact = value.slice(0, 8);
  const date = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;

  return isRealCalendarDate(date);
}

export function assertBuildId(value, label = 'buildId') {
  if (!isBuildId(value)) {
    throw new BuildError(
      `${label} must be "fixture-<12 lowercase hex>" or "<8-digit date>-<12 lowercase hex>"`,
    );
  }

  return value;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }

  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

export function shortHash(value, length = SHORT_HASH_LENGTH) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, length);
}

export function compactDate(date) {
  if (!isRealCalendarDate(date)) {
    throw new BuildError(`Planet date "${date}" must use the YYYY-MM-DD format`);
  }

  return date.replaceAll('-', '');
}

export function buildIdPayload({
  mode,
  source,
  planetDate,
  planetSha256,
  minzoom,
  maxzoom,
  filterApplied,
  filterSkipped,
  profileHash,
  filterHash,
  skips,
  tools,
}) {
  return {
    mode,
    source: source ?? '',
    planetDate: planetDate ?? '',
    planetSha256: planetSha256 ?? '',
    minzoom: minzoom ?? null,
    maxzoom: maxzoom ?? null,
    filterApplied: Boolean(filterApplied),
    filterSkipped: Boolean(filterSkipped),
    profileHash: profileHash ?? '',
    filterHash: filterHash ?? '',
    skips: skips ?? {},
    tools: tools ?? {},
  };
}

// A run ID identifies the build recipe: source, zooms, filter/skip flags, profile
// and tool versions. Identical recipes share a run ID even when their output differs.
export function computeRunId(input) {
  if (input.mode !== 'fixture' && input.mode !== 'planet') {
    throw new BuildError(`Unknown build mode "${input.mode}"`);
  }

  return shortHash(buildIdPayload(input));
}

// A build ID identifies the archive bytes themselves. It is derived from the final
// archive SHA-256, so two builds that produce identical archives legitimately share
// an identity regardless of how their run IDs were configured.
export function computeBuildId({ mode, planetDate, archiveSha256 }) {
  if (mode !== 'fixture' && mode !== 'planet') {
    throw new BuildError(`Unknown build mode "${mode}"`);
  }

  if (typeof archiveSha256 !== 'string' || !SHA256_PATTERN.test(archiveSha256)) {
    throw new BuildError('A lowercase 64 character archive SHA-256 is required for the build ID');
  }

  const hash = archiveSha256.slice(0, BUILD_ID_HASH_LENGTH);

  if (mode === 'fixture') {
    return `fixture-${hash}`;
  }

  return `${compactDate(planetDate)}-${hash}`;
}
