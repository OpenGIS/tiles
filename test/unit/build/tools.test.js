import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BuildError } from '../../../src/build/errors.mjs';
import { sha256Text } from '../../../src/build/fs.mjs';
import {
  detectJavaVersion,
  detectOsmiumVersion,
  detectPmtiles,
  downloadFile,
  ensurePlanetiler,
  resolveExecutable,
} from '../../../src/build/tools.mjs';
import { createTempDirectory, removeTempDirectory } from '../../helpers/temp.mjs';

const created = [];

async function makeTemp() {
  const root = await createTempDirectory('tiles-build-tools-');
  created.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => removeTempDirectory(directory)));
});

describe('downloadFile', () => {
  it('writes the downloaded file and returns its digest', async () => {
    const root = await makeTemp();
    const destination = path.join(root, 'tools', 'planetiler.jar');
    const contents = 'planetiler jar';
    const expectedSha256 = sha256Text(contents);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(contents));

    const result = await downloadFile({
      url: 'https://example.com/planetiler.jar',
      destination,
      expectedSha256,
      fetchImpl,
    });

    expect(result).toBe(expectedSha256);
    expect(await readFile(destination, 'utf8')).toBe(contents);
    expect(await readdir(path.dirname(destination))).toEqual(['planetiler.jar']);
    expect(fetchImpl).toHaveBeenCalledWith('https://example.com/planetiler.jar', {
      redirect: 'follow',
    });
  });

  it('rejects a checksum mismatch and removes the temporary file', async () => {
    const root = await makeTemp();
    const destination = path.join(root, 'tools', 'planetiler.jar');
    const fetchImpl = vi.fn().mockResolvedValue(new Response('corrupt'));

    await expect(
      downloadFile({
        url: 'https://example.com/planetiler.jar',
        destination,
        expectedSha256: 'a'.repeat(64),
        fetchImpl,
      }),
    ).rejects.toThrow(/Checksum mismatch/);

    expect(await readdir(path.dirname(destination))).toEqual([]);
  });

  it('accepts a matching MD5 and still returns the SHA-256', async () => {
    const root = await makeTemp();
    const destination = path.join(root, 'planet.osm.pbf');
    const contents = 'planet payload';
    const expectedMd5 = createHash('md5').update(contents).digest('hex');
    const fetchImpl = vi.fn().mockResolvedValue(new Response(contents));

    const result = await downloadFile({
      url: 'https://example.com/planet.osm.pbf',
      destination,
      expectedMd5,
      fetchImpl,
    });

    expect(result).toBe(sha256Text(contents));
    expect(await readFile(destination, 'utf8')).toBe(contents);
  });

  it('rejects a mismatched MD5 and leaves a cached file untouched', async () => {
    const root = await makeTemp();
    const destination = path.join(root, 'planet.osm.pbf');
    await writeFile(destination, 'cached planet', 'utf8');
    const fetchImpl = vi.fn().mockResolvedValue(new Response('corrupt'));

    await expect(
      downloadFile({
        url: 'https://example.com/planet.osm.pbf',
        destination,
        expectedMd5: 'a'.repeat(32),
        fetchImpl,
      }),
    ).rejects.toThrow(/MD5 checksum mismatch/);

    expect(await readFile(destination, 'utf8')).toBe('cached planet');
    expect(await readdir(path.dirname(destination))).toEqual(['planet.osm.pbf']);
  });

  it('requires both digests to match when both are supplied', async () => {
    const root = await makeTemp();
    const contents = 'planet payload';
    const expectedSha256 = sha256Text(contents);
    const expectedMd5 = createHash('md5').update(contents).digest('hex');
    const fetchImpl = vi.fn().mockImplementation(async () => new Response(contents));

    await expect(
      downloadFile({
        url: 'https://example.com/planet.osm.pbf',
        destination: path.join(root, 'sha-ok-md5-bad.osm.pbf'),
        expectedSha256,
        expectedMd5: 'b'.repeat(32),
        fetchImpl,
      }),
    ).rejects.toThrow(/MD5 checksum mismatch/);

    await expect(
      downloadFile({
        url: 'https://example.com/planet.osm.pbf',
        destination: path.join(root, 'sha-bad-md5-ok.osm.pbf'),
        expectedSha256: 'a'.repeat(64),
        expectedMd5,
        fetchImpl,
      }),
    ).rejects.toThrow(/Checksum mismatch/);
  });

  it('rejects a failed HTTP response without leaving a temporary file', async () => {
    const root = await makeTemp();
    const destination = path.join(root, 'tools', 'planetiler.jar');
    const fetchImpl = vi.fn().mockResolvedValue(new Response('missing', { status: 404 }));

    await expect(
      downloadFile({
        url: 'https://example.com/planetiler.jar',
        destination,
        fetchImpl,
      }),
    ).rejects.toThrow(/HTTP 404/);

    expect(await readdir(path.dirname(destination))).toEqual([]);
  });

  it('requires a download URL', async () => {
    await expect(
      downloadFile({ url: '', destination: path.join('tmp', 'unused') }),
    ).rejects.toThrow(/A download URL is required/);
  });
});

describe('ensurePlanetiler', () => {
  const planetiler = {
    version: '0.10.2',
    url: 'https://example.com/planetiler.jar',
    sha256: '',
  };

  it('reuses a cached jar whose checksum matches', async () => {
    const root = await makeTemp();
    const contents = 'cached planetiler jar';
    const sha256 = sha256Text(contents);
    await writeFile(path.join(root, 'planetiler-0.10.2.jar'), contents, 'utf8');
    const fetchImpl = vi.fn();

    const result = await ensurePlanetiler({
      planetiler: { ...planetiler, sha256 },
      toolsDir: root,
      fetchImpl,
    });

    expect(result).toEqual({
      path: path.join(root, 'planetiler-0.10.2.jar'),
      sha256,
      version: '0.10.2',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a cached jar with the wrong checksum unless forced', async () => {
    const root = await makeTemp();
    await writeFile(path.join(root, 'planetiler-0.10.2.jar'), 'stale', 'utf8');
    const fetchImpl = vi.fn();

    await expect(
      ensurePlanetiler({
        planetiler: { ...planetiler, sha256: 'a'.repeat(64) },
        toolsDir: root,
        fetchImpl,
      }),
    ).rejects.toThrow(/wrong checksum/i);

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('replaces a cached jar with the wrong checksum when forced', async () => {
    const root = await makeTemp();
    const jarPath = path.join(root, 'planetiler-0.10.2.jar');
    await writeFile(jarPath, 'stale', 'utf8');
    const contents = 'fresh planetiler jar';
    const sha256 = sha256Text(contents);
    const fetchImpl = vi.fn().mockResolvedValue(new Response(contents));

    const result = await ensurePlanetiler({
      planetiler: { ...planetiler, sha256 },
      toolsDir: root,
      fetchImpl,
      force: true,
    });

    expect(result.sha256).toBe(sha256);
    expect(await readFile(jarPath, 'utf8')).toBe(contents);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps the cached jar when a forced download fails checksum verification', async () => {
    const root = await makeTemp();
    const jarPath = path.join(root, 'planetiler-0.10.2.jar');
    await writeFile(jarPath, 'stale but usable jar', 'utf8');
    const fetchImpl = vi.fn().mockResolvedValue(new Response('corrupt download'));

    await expect(
      ensurePlanetiler({
        planetiler: { ...planetiler, sha256: 'a'.repeat(64) },
        toolsDir: root,
        fetchImpl,
        force: true,
      }),
    ).rejects.toThrow(/Checksum mismatch/);

    expect(await readFile(jarPath, 'utf8')).toBe('stale but usable jar');
    expect(await readdir(root)).toEqual(['planetiler-0.10.2.jar']);
  });

  it('requires a configured Planetiler version', async () => {
    const root = await makeTemp();

    await expect(ensurePlanetiler({ planetiler: {}, toolsDir: root })).rejects.toThrow(
      /No Planetiler version is configured/,
    );
  });
});

describe('tool detection', () => {
  it('reads the Java version from stderr', async () => {
    const execFileImpl = vi.fn().mockResolvedValue({
      stdout: '',
      stderr: 'openjdk version "26.0.2" 2026-07-21\nOpenJDK Runtime Environment',
    });

    await expect(detectJavaVersion({ execFileImpl })).resolves.toBe('26.0.2');
  });

  it('rejects unparseable Java output', async () => {
    const execFileImpl = vi.fn().mockResolvedValue({
      stdout: 'not a version',
      stderr: '',
    });

    await expect(detectJavaVersion({ execFileImpl })).rejects.toThrow(BuildError);
  });

  it('reads the osmium version', async () => {
    const execFileImpl = vi.fn().mockResolvedValue({
      stdout: 'osmium version 1.19.1\nlibosmium version 2.23.1\n',
      stderr: '',
    });

    await expect(detectOsmiumVersion({ execFileImpl })).resolves.toBe('1.19.1');
  });

  it('rejects unparseable osmium output', async () => {
    const execFileImpl = vi.fn().mockResolvedValue({ stdout: 'osmium', stderr: '' });

    await expect(detectOsmiumVersion({ execFileImpl })).rejects.toThrow(BuildError);
  });

  it('returns the pmtiles version and the resolved executable digest', async () => {
    const root = await makeTemp();
    const executable = path.join(root, 'pmtiles');
    const contents = 'pmtiles executable';
    await writeFile(executable, contents, 'utf8');
    const execFileImpl = vi.fn(async (command) => {
      if (command === 'pmtiles') {
        return { stdout: 'pmtiles 1.31.2\n', stderr: '' };
      }

      if (command === 'which') {
        return { stdout: `${executable}\n`, stderr: '' };
      }

      throw new Error(`unexpected command: ${command}`);
    });

    await expect(detectPmtiles({ execFileImpl })).resolves.toEqual({
      version: '1.31.2',
      sha256: sha256Text(contents),
    });
  });

  it('extracts the semantic version from the pmtiles build stamp', async () => {
    const root = await makeTemp();
    const executable = path.join(root, 'pmtiles');
    const contents = 'pmtiles executable';
    await writeFile(executable, contents, 'utf8');
    const execFileImpl = vi.fn(async (command) => {
      if (command === 'pmtiles') {
        return {
          stdout:
            'pmtiles 1.31.2, commit a3e4951ea6a0477b784c27c1dcbfd9c130878c5a, built at 2026-07-22T18:59:03Z\n',
          stderr: '',
        };
      }

      if (command === 'which') {
        return { stdout: `${executable}\n`, stderr: '' };
      }

      throw new Error(`unexpected command: ${command}`);
    });

    await expect(detectPmtiles({ execFileImpl })).resolves.toEqual({
      version: '1.31.2',
      sha256: sha256Text(contents),
    });
  });

  it('accepts a non-semver pmtiles build stamp', async () => {
    const root = await makeTemp();
    const executable = path.join(root, 'pmtiles');
    const contents = 'pmtiles executable';
    await writeFile(executable, contents, 'utf8');
    const execFileImpl = vi.fn(async (command) => {
      if (command === 'pmtiles') {
        return { stdout: 'pmtiles dev, commit none, built at unknown\n', stderr: '' };
      }

      if (command === 'which') {
        return { stdout: `${executable}\n`, stderr: '' };
      }

      throw new Error(`unexpected command: ${command}`);
    });

    await expect(detectPmtiles({ execFileImpl })).resolves.toEqual({
      version: 'dev',
      sha256: sha256Text(contents),
    });
  });

  it('rejects unparseable pmtiles output', async () => {
    const execFileImpl = vi.fn().mockResolvedValue({ stdout: 'not pmtiles', stderr: '' });

    await expect(detectPmtiles({ execFileImpl })).rejects.toThrow(BuildError);
  });

  it('rejects an empty executable resolution', async () => {
    const execFileImpl = vi.fn().mockResolvedValue({ stdout: '\n', stderr: '' });

    await expect(resolveExecutable('pmtiles', { execFileImpl })).rejects.toThrow(
      /Unable to locate the pmtiles executable/,
    );
  });
});
