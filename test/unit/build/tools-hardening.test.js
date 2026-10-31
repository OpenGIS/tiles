import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BuildError } from '../../../src/build/errors.mjs';
import { sha256Text } from '../../../src/build/fs.mjs';
import {
  detectJavaVersion,
  ensurePlanetiler,
  parseJavaMajorVersion,
  resolveExecutable,
} from '../../../src/build/tools.mjs';
import { createTempDirectory, removeTempDirectory } from '../../helpers/temp.mjs';

const created = [];

async function makeTemp() {
  const root = await createTempDirectory('tiles-build-tools-hardening-');
  created.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => removeTempDirectory(directory)));
});

describe('Planetiler jar safety', () => {
  it('rejects a version that could escape the cache filename', async () => {
    const root = await makeTemp();

    await expect(
      ensurePlanetiler({
        planetiler: {
          version: '../0.10.2',
          url: 'https://example.com/tool.jar',
          sha256: 'a'.repeat(64),
        },
        toolsDir: root,
      }),
    ).rejects.toThrow(/unsupported characters/);
  });

  it('requires a pinned SHA whenever a download URL is configured', async () => {
    const root = await makeTemp();

    await expect(
      ensurePlanetiler({
        planetiler: { version: '0.10.2', url: 'https://example.com/tool.jar', sha256: '' },
        toolsDir: root,
      }),
    ).rejects.toThrow(/pinned Planetiler SHA-256/);
  });

  it('refuses a cached jar without a pinned SHA', async () => {
    const root = await makeTemp();
    await writeFile(path.join(root, 'planetiler-0.10.2.jar'), 'cached', 'utf8');

    await expect(
      ensurePlanetiler({
        planetiler: { version: '0.10.2', url: '', sha256: '' },
        toolsDir: root,
      }),
    ).rejects.toThrow(/Refusing to execute the unverified Planetiler jar/);
  });

  it('re-downloads a matching cached jar when forced', async () => {
    const root = await makeTemp();
    const contents = 'planetiler jar';
    const sha256 = sha256Text(contents);
    const jarPath = path.join(root, 'planetiler-0.10.2.jar');
    await writeFile(jarPath, contents, 'utf8');
    const fetchImpl = vi.fn().mockResolvedValue(new Response(contents));

    const result = await ensurePlanetiler({
      planetiler: {
        version: '0.10.2',
        url: 'https://example.com/tool.jar',
        sha256,
      },
      toolsDir: root,
      fetchImpl,
      force: true,
    });

    expect(result.sha256).toBe(sha256);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await readFile(jarPath, 'utf8')).toBe(contents);
  });

  it('names the cached jar when forced without a download URL', async () => {
    const root = await makeTemp();
    const contents = 'planetiler jar';
    const sha256 = sha256Text(contents);
    const jarPath = path.join(root, 'planetiler-0.10.2.jar');
    await writeFile(jarPath, contents, 'utf8');

    await expect(
      ensurePlanetiler({
        planetiler: { version: '0.10.2', url: '', sha256 },
        toolsDir: root,
        force: true,
      }),
    ).rejects.toThrow(/is cached at .*--force.*no download URL is configured/);

    expect(await readFile(jarPath, 'utf8')).toBe(contents);
  });
});

describe('Java preflight', () => {
  it.each([
    ['26.0.2', 26],
    ['21', 21],
    ['1.8.0_402', 8],
  ])('parses %s as major %i', (version, major) => {
    expect(parseJavaMajorVersion(version)).toBe(major);
  });

  it('rejects a Java runtime older than 21 with a clear message', async () => {
    const execFileImpl = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: 'openjdk version "17.0.12" 2026-07-16',
    });

    await expect(detectJavaVersion({ execFileImpl })).rejects.toThrow(
      /Java 17\.0\.12 is too old.*Java 21/,
    );
  });

  it('names a missing Java executable in the preflight error', async () => {
    const error = new Error('spawn java ENOENT');
    error.code = 'ENOENT';
    const execFileImpl = vi.fn().mockRejectedValue(error);

    await expect(detectJavaVersion({ execFileImpl })).rejects.toThrow(
      /Unable to run "java".*not found/,
    );
  });

  it('wraps a failed executable lookup with the command name', async () => {
    const execFileImpl = vi.fn().mockRejectedValue(new Error('which failed'));

    await expect(resolveExecutable('osmium', { execFileImpl })).rejects.toBeInstanceOf(BuildError);
    await expect(resolveExecutable('osmium', { execFileImpl })).rejects.toThrow(
      /Unable to locate the osmium executable/,
    );
  });
});
