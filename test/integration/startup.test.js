import { spawn } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createTempDirectory,
  fixturePath,
  removeTempDirectory,
  repoRoot,
} from '../helpers/temp.mjs';

const createdDirectories = [];
const runningChildren = [];

afterEach(async () => {
  for (const child of runningChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
  await Promise.all(
    createdDirectories.splice(0).map((directory) => removeTempDirectory(directory)),
  );
});

function spawnServer(environment) {
  const child = spawn(process.execPath, ['src/server.mjs'], {
    cwd: repoRoot,
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });

  runningChildren.push(child);

  return {
    child,
    exited,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function waitForExit(running, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out waiting for the server process to exit')),
      timeoutMs,
    );

    running.exited.then((result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
}

async function waitFor(predicate, timeoutMs = 5000) {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for the server process');
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function freePort() {
  const server = createNetServer();

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));

  return port;
}

async function writeConfig(directory, port, { archiveDir }) {
  const configDirectory = path.join(directory, 'config');
  const configPath = path.join(configDirectory, 'layers.json');
  await mkdir(configDirectory, { recursive: true });
  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      server: { host: '127.0.0.1', port },
      sources: {
        pois: {
          kind: 'pmtiles',
          title: 'Outdoor POIs',
          description: 'Points of interest.',
          attribution: [
            { title: 'OpenStreetMap', href: 'https://www.openstreetmap.org/copyright' },
          ],
          archiveDir,
          minzoom: 12,
          maxzoom: 16,
        },
      },
    }),
    'utf8',
  );

  return configPath;
}

function getJson(baseUrl, pathname) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL(pathname, baseUrl), (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        resolve({
          status: response.statusCode,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

async function makeDataDirectory(directory) {
  const dataDir = path.join(directory, 'data', 'pois');
  await mkdir(dataDir, { recursive: true });
  await copyFile(fixturePath, path.join(dataDir, 'current.pmtiles'));
  await writeFile(
    path.join(dataDir, 'current.json'),
    JSON.stringify({ buildId: 'startup-build' }),
    'utf8',
  );
  return dataDir;
}

describe('server startup', () => {
  it('loads a custom CONFIG_PATH and resolves archiveDir against the repository root', async () => {
    const directory = await createTempDirectory('tiles-startup-');
    createdDirectories.push(directory);

    const dataDir = await makeDataDirectory(directory);
    const port = await freePort();
    const archiveDir = path.relative(repoRoot, dataDir);
    const configPath = await writeConfig(directory, port, { archiveDir });

    expect(archiveDir.startsWith('..')).toBe(false);

    const running = spawnServer({ CONFIG_PATH: configPath, PORT: String(port) });

    await waitFor(() => running.stdout().includes('listening'));
    const health = await getJson(`http://127.0.0.1:${port}`, '/health');

    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');
    expect(health.body.sources.pois).toEqual({ available: true, buildId: 'startup-build' });

    running.child.kill('SIGTERM');
    const exit = await waitForExit(running);

    expect(exit.code).toBe(0);
  });

  it('exits cleanly for an invalid config without a stack trace', async () => {
    const directory = await createTempDirectory('tiles-startup-');
    createdDirectories.push(directory);

    const configPath = path.join(directory, 'broken.json');
    await writeFile(configPath, '{ not json', 'utf8');

    const running = spawnServer({ CONFIG_PATH: configPath });
    const exit = await waitForExit(running);

    expect(exit.code).toBe(1);
    expect(running.stderr()).toContain('Unable to load configuration');
    expect(running.stderr().trim().split('\n')).toHaveLength(1);
    expect(running.stderr()).not.toContain('    at ');
  });

  it('exits cleanly when the port is already in use', async () => {
    const directory = await createTempDirectory('tiles-startup-');
    createdDirectories.push(directory);

    const dataDir = await makeDataDirectory(directory);
    const blocker = createNetServer();
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address();
    const configPath = await writeConfig(directory, port, {
      archiveDir: path.relative(repoRoot, dataDir),
    });

    try {
      const running = spawnServer({ CONFIG_PATH: configPath, PORT: String(port) });
      const exit = await waitForExit(running);

      expect(exit.code).toBe(1);
      expect(running.stderr()).toContain('Unable to start ogis-tiles');
      expect(running.stderr()).not.toContain('    at ');
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});
