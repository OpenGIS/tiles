import path from 'node:path';

import { normaliseHeap } from './config.mjs';
import { BuildError } from './errors.mjs';
import { pathExists } from './fs.mjs';

const PROFILES = {
  pois: {
    kind: 'yaml',
    file: 'build/profiles/pois.yml',
    layer: 'outdoor_pois',
  },
  routes: {
    kind: 'java',
    file: 'build/profiles/routes.java',
    layer: 'outdoor_routes',
  },
  paths: {
    kind: 'java',
    file: 'build/profiles/paths.java',
    layer: 'outdoor_paths',
  },
};

const PROFILE_KINDS = ['yaml', 'java'];
const DEFAULT_HEAP = '2g';

export function deriveMinZoom(schemaContents) {
  const zooms = [...String(schemaContents).matchAll(/^\s*min_zoom:\s*(\d+)\s*$/gm)].map((match) =>
    Number(match[1]),
  );

  return zooms.length === 0 ? null : Math.min(...zooms);
}

export function describeProfile(profile) {
  const entry = PROFILES[profile];
  if (!entry) {
    throw new BuildError(
      `No build profile is registered for "${profile}"; available profiles: ${Object.keys(PROFILES).join(', ')}`,
    );
  }

  return { ...entry };
}

export function profileNames() {
  return Object.keys(PROFILES);
}

export async function resolveProfile(repoRoot, profile, overrides = {}) {
  const entry = describeProfile(profile);
  const kind = overrides.profileKind ?? entry.kind;

  if (!PROFILE_KINDS.includes(kind)) {
    throw new BuildError(
      `Profile "${profile}" has an unknown kind "${kind}"; expected one of ${PROFILE_KINDS.join(', ')}`,
    );
  }

  const file = overrides.profileFile ?? entry.file;
  const filePath = path.join(repoRoot, file);

  if (!(await pathExists(filePath))) {
    throw new BuildError(`Build profile file not found: ${file}`);
  }

  return {
    name: profile,
    kind,
    file,
    layer: overrides.layer ?? entry.layer,
    heap: overrides.heap ?? DEFAULT_HEAP,
    ...(overrides.heapPlanet === undefined ? {} : { heapPlanet: overrides.heapPlanet }),
    filePath,
  };
}

export function resolveProfileHeap(profile, { mode = 'fixture', env = {}, explicitHeap } = {}) {
  const override =
    mode === 'planet'
      ? String(explicitHeap ?? env.PLANET_BUILD_HEAP ?? profile.heapPlanet ?? '').trim()
      : '';
  const heap = override === '' ? profile.heap : override;

  return normaliseHeap(heap, 'Java heap') ?? DEFAULT_HEAP;
}
