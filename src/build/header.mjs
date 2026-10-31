import { BuildError } from './errors.mjs';

function requireInteger(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new BuildError(`${label} must be an integer between ${minimum} and ${maximum}`);
  }

  return value;
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new BuildError(`${label} must be a non-negative integer`);
  }

  return value;
}

function requireNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new BuildError(`${label} must be a finite number`);
  }

  return value;
}

function validateBounds(bounds) {
  if (bounds === undefined) {
    return null;
  }

  if (!Array.isArray(bounds) || bounds.length !== 4) {
    throw new BuildError('PMTiles header bounds must be a four-number array');
  }

  const values = bounds.map((value, index) =>
    requireNumber(value, `PMTiles header bounds[${index}]`),
  );
  const [west, south, east, north] = values;

  if (west < -180 || east > 180) {
    throw new BuildError('PMTiles header bounds must use longitudes between -180 and 180');
  }

  if (south < -90 || north > 90) {
    throw new BuildError('PMTiles header bounds must use latitudes between -90 and 90');
  }

  if (!(west < east)) {
    throw new BuildError('PMTiles header bounds must have west < east');
  }

  if (!(south < north)) {
    throw new BuildError('PMTiles header bounds must have south < north');
  }

  return values;
}

function validateCenter(center) {
  if (center === undefined) {
    return null;
  }

  if (!Array.isArray(center) || center.length !== 3) {
    throw new BuildError('PMTiles header center must be a three-number array');
  }

  const longitude = requireNumber(center[0], 'PMTiles header center[0]');
  const latitude = requireNumber(center[1], 'PMTiles header center[1]');

  if (longitude < -180 || longitude > 180) {
    throw new BuildError('PMTiles header center longitude must be between -180 and 180');
  }

  if (latitude < -90 || latitude > 90) {
    throw new BuildError('PMTiles header center latitude must be between -90 and 90');
  }

  return [longitude, latitude, validateCenterZoom(center[2])];
}

function validateCenterZoom(value) {
  if (!Number.isInteger(value) || value < 0 || value > 26) {
    throw new BuildError('PMTiles header center zoom must be an integer between 0 and 26');
  }

  return value;
}

function midpoint(bounds) {
  if (!bounds) {
    return [0, 0];
  }

  return [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
}

export function repairHeader(header, { minzoom, centerZoom } = {}) {
  if (typeof header !== 'object' || header === null || Array.isArray(header)) {
    throw new BuildError('PMTiles header must be a JSON object');
  }

  const resolvedMinzoom = requireInteger(
    minzoom ?? header.minzoom,
    'PMTiles header minzoom',
    0,
    26,
  );
  const maxzoom = requireInteger(header.maxzoom, 'PMTiles header maxzoom', 0, 26);

  if (resolvedMinzoom > maxzoom) {
    throw new BuildError('PMTiles header minzoom must not be greater than maxzoom');
  }

  const bounds = validateBounds(header.bounds);
  const existingCenter = validateCenter(header.center);
  const requestedZoom =
    centerZoom === undefined
      ? existingCenter
        ? existingCenter[2]
        : resolvedMinzoom
      : requireNonNegativeInteger(centerZoom, 'PMTiles header center zoom');
  const zoom = Math.min(Math.max(requestedZoom, resolvedMinzoom), maxzoom);
  const [longitude, latitude] = existingCenter ? existingCenter.slice(0, 2) : midpoint(bounds);

  if (
    bounds &&
    (longitude < bounds[0] || longitude > bounds[2] || latitude < bounds[1] || latitude > bounds[3])
  ) {
    throw new BuildError('PMTiles header center must lie within the header bounds');
  }

  return {
    ...header,
    minzoom: resolvedMinzoom,
    center: [longitude, latitude, zoom],
  };
}

export function serialiseHeader(header) {
  return `${JSON.stringify(header, null, 2)}\n`;
}
