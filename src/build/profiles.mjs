import path from 'node:path';

import { BuildError } from './errors.mjs';
import { pathExists } from './fs.mjs';

const PROFILES = {
  pois: {
    schema: 'build/profiles/pois.yml',
    layer: 'outdoor_pois',
  },
};

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

export async function resolveProfile(repoRoot, profile) {
  const entry = describeProfile(profile);
  const schemaPath = path.join(repoRoot, entry.schema);

  if (!(await pathExists(schemaPath))) {
    throw new BuildError(`Build profile file not found: ${entry.schema}`);
  }

  return { ...entry, schemaPath };
}
