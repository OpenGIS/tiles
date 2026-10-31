import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadDeployLayers, resolveLayersPath } from '../../../src/deploy/layers.mjs';
import { loadEnvironment } from '../../../src/provision/provision.mjs';
import { createTempDirectory, removeTempDirectory } from '../../helpers/temp.mjs';

const created = [];

async function makeTemp() {
  const root = await createTempDirectory('tiles-deploy-layers-');
  created.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => removeTempDirectory(directory)));
});

function layersConfig(sourceName) {
  return {
    version: 1,
    server: { host: '127.0.0.1', port: 11010 },
    sources: {
      [sourceName]: {
        kind: 'pmtiles',
        title: 'Outdoor POIs',
        description: 'Points of interest.',
        attribution: [{ title: 'OpenStreetMap', href: 'https://www.openstreetmap.org/copyright' }],
        archiveDir: `data/${sourceName}`,
        minzoom: 0,
        maxzoom: 14,
      },
    },
  };
}

describe('loadDeployLayers', () => {
  it('loads the repository default when CONFIG_PATH is absent', async () => {
    const root = await makeTemp();
    const configDir = path.join(root, 'config');
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, 'layers.json'),
      JSON.stringify(layersConfig('pois')),
      'utf8',
    );

    const layers = loadDeployLayers({ env: {}, repoRoot: root });

    expect(Object.keys(layers.sources)).toEqual(['pois']);
  });

  it('uses CONFIG_PATH from the merged environment', async () => {
    const root = await makeTemp();
    const configDir = path.join(root, 'config');
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(configDir, 'layers.json'),
      JSON.stringify(layersConfig('pois')),
      'utf8',
    );

    const customPath = path.join(configDir, 'custom layers.json');
    await writeFile(customPath, JSON.stringify(layersConfig('custom')), 'utf8');

    const envPath = path.join(root, '.env');
    await writeFile(envPath, `CONFIG_PATH=${customPath}\n`, 'utf8');

    const env = await loadEnvironment({ env: {}, envPath });
    const layers = loadDeployLayers({ env, repoRoot: root });

    expect(Object.keys(layers.sources)).toEqual(['custom']);
    expect(resolveLayersPath({ env, repoRoot: root })).toBe(customPath);
  });
});
