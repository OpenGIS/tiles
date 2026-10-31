import path from 'node:path';

import { loadConfig } from '../lib/config.mjs';

import { DeployError } from './config.mjs';

export function resolveLayersPath({ env = process.env, repoRoot } = {}) {
  const configured = env?.CONFIG_PATH;

  if (typeof configured === 'string' && configured.trim() !== '') {
    return configured.trim();
  }

  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') {
    throw new DeployError('repoRoot is required to resolve the default layers configuration');
  }

  return path.join(repoRoot, 'config', 'layers.json');
}

export function loadDeployLayers({ env = process.env, repoRoot } = {}) {
  return loadConfig(resolveLayersPath({ env, repoRoot }), { repoRoot });
}
