const BLOCKED_PACKAGES = new Set(['@mapbox/vector-tile', 'pbf']);

export async function resolve(specifier, context, nextResolve) {
  for (const name of BLOCKED_PACKAGES) {
    if (specifier === name || specifier.startsWith(`${name}/`)) {
      throw new Error(`Build-only dependency "${specifier}" must not be loaded by this command`);
    }
  }

  return nextResolve(specifier, context);
}
