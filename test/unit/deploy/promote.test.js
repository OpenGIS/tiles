import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { sha256Text } from '../../../src/build/fs.mjs';
import {
  promoteSource,
  rollbackSource,
  verifyPromotedSource,
} from '../../../src/deploy/promote.mjs';
import { createTempDirectory, removeTempDirectory } from '../../helpers/temp.mjs';

const created = [];

async function makeTemp() {
  const root = await createTempDirectory('tiles-deploy-promote-');
  created.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => removeTempDirectory(directory)));
});

function buildIdFor(contents) {
  return `fixture-${sha256Text(contents).slice(0, 12)}`;
}

function sidecar(buildId, archiveSha256, source = 'pois') {
  return `${JSON.stringify(
    {
      buildId,
      source,
      archive: { path: 'current.pmtiles', sha256: archiveSha256 },
    },
    null,
    2,
  )}\n`;
}

async function writePair(directory, kind, contents) {
  await mkdir(directory, { recursive: true });
  const buildId = buildIdFor(contents);
  const sha256 = sha256Text(contents);
  await writeFile(path.join(directory, `${kind}.pmtiles`), contents, 'utf8');
  await writeFile(path.join(directory, `${kind}.json`), sidecar(buildId, sha256), 'utf8');
  return { buildId, sha256 };
}

async function writeIncoming(
  directory,
  contents,
  { manifestName = 'build.json', overrides = {} } = {},
) {
  await mkdir(directory, { recursive: true });
  const buildId = overrides.buildId ?? buildIdFor(contents);
  const sha256 = overrides.sha256 ?? sha256Text(contents);
  await writeFile(path.join(directory, 'current.pmtiles'), contents, 'utf8');
  await writeFile(path.join(directory, manifestName), sidecar(buildId, sha256), 'utf8');
  return { buildId, sha256 };
}

async function exists(target) {
  try {
    await readFile(target);
    return true;
  } catch {
    return false;
  }
}

function makeErr() {
  const chunks = [];
  return {
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    text() {
      return chunks.join('');
    },
  };
}

function failingRestoreFs() {
  return {
    copyFile: async (source, target) => {
      if (
        String(source).includes('.deploy-backup-') &&
        String(target).endsWith('current.pmtiles')
      ) {
        throw new Error('disk full');
      }

      return copyFile(source, target);
    },
    mkdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
  };
}

function paths(root) {
  const dataDir = path.join(root, 'data');
  return {
    dataDir,
    incomingDir: path.join(dataDir, 'incoming'),
    sourceDir: path.join(dataDir, 'pois'),
    incomingSourceDir: path.join(dataDir, 'incoming', 'pois'),
  };
}

function layersFor(archiveDir, name = 'pois') {
  return { sources: { [name]: { kind: 'pmtiles', archiveDir } } };
}

describe('promoteSource', () => {
  it('promotes the incoming archive and preserves the previous pair', async () => {
    const root = await makeTemp();
    const target = paths(root);
    const current = await writePair(target.sourceDir, 'current', 'current archive');
    await writePair(target.sourceDir, 'previous', 'older archive');
    const incoming = await writeIncoming(target.incomingSourceDir, 'new archive');
    const restart = vi.fn().mockResolvedValue(undefined);
    const smoke = vi.fn().mockResolvedValue(undefined);

    const result = await promoteSource({
      source: 'pois',
      dataDir: target.dataDir,
      incomingDir: target.incomingDir,
      restart,
      smoke,
    });

    expect(result.buildId).toBe(incoming.buildId);
    expect(await readFile(path.join(target.sourceDir, 'current.pmtiles'), 'utf8')).toBe(
      'new archive',
    );
    expect(await readFile(path.join(target.sourceDir, 'previous.pmtiles'), 'utf8')).toBe(
      'current archive',
    );

    const currentSidecar = JSON.parse(
      await readFile(path.join(target.sourceDir, 'current.json'), 'utf8'),
    );
    expect(currentSidecar.buildId).toBe(incoming.buildId);
    expect(currentSidecar.archive.path).toBe('current.pmtiles');

    const previousSidecar = JSON.parse(
      await readFile(path.join(target.sourceDir, 'previous.json'), 'utf8'),
    );
    expect(previousSidecar.buildId).toBe(current.buildId);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(smoke).toHaveBeenCalledTimes(1);
    expect(await exists(path.join(target.incomingSourceDir, 'current.pmtiles'))).toBe(false);
    expect(await exists(path.join(target.incomingSourceDir, 'build.json'))).toBe(false);
    expect(
      (await readdir(target.sourceDir)).some((name) => name.startsWith('.deploy-backup')),
    ).toBe(false);
  });

  it('accepts current.json as the incoming manifest name', async () => {
    const root = await makeTemp();
    const target = paths(root);
    await writePair(target.sourceDir, 'current', 'current archive');
    const incoming = await writeIncoming(target.incomingSourceDir, 'new archive', {
      manifestName: 'current.json',
    });

    const result = await promoteSource({
      source: 'pois',
      dataDir: target.dataDir,
      incomingDir: target.incomingDir,
    });

    expect(result.buildId).toBe(incoming.buildId);
    expect(await readFile(path.join(target.sourceDir, 'current.pmtiles'), 'utf8')).toBe(
      'new archive',
    );
  });

  it('rejects missing and corrupt inputs without touching current or previous', async () => {
    const root = await makeTemp();
    const target = paths(root);
    const current = await writePair(target.sourceDir, 'current', 'current archive');
    const previous = await writePair(target.sourceDir, 'previous', 'older archive');
    const restart = vi.fn();
    const smoke = vi.fn();

    await expect(
      promoteSource({
        source: 'pois',
        dataDir: target.dataDir,
        incomingDir: target.incomingDir,
        restart,
        smoke,
      }),
    ).rejects.toThrow(/Incoming pois is missing/);

    await writeIncoming(target.incomingSourceDir, 'new archive', {
      overrides: { sha256: sha256Text('different archive') },
    });

    await expect(
      promoteSource({
        source: 'pois',
        dataDir: target.dataDir,
        incomingDir: target.incomingDir,
        restart,
        smoke,
      }),
    ).rejects.toThrow(/manifest declares/);

    expect(await readFile(path.join(target.sourceDir, 'current.pmtiles'), 'utf8')).toBe(
      'current archive',
    );
    expect(await readFile(path.join(target.sourceDir, 'previous.pmtiles'), 'utf8')).toBe(
      'older archive',
    );
    const currentSidecar = JSON.parse(
      await readFile(path.join(target.sourceDir, 'current.json'), 'utf8'),
    );
    expect(currentSidecar.buildId).toBe(current.buildId);
    const previousSidecar = JSON.parse(
      await readFile(path.join(target.sourceDir, 'previous.json'), 'utf8'),
    );
    expect(previousSidecar.buildId).toBe(previous.buildId);
    expect(restart).not.toHaveBeenCalled();
    expect(smoke).not.toHaveBeenCalled();
  });

  it('rejects a build ID that is not content-addressed', async () => {
    const root = await makeTemp();
    const target = paths(root);
    await writePair(target.sourceDir, 'current', 'current archive');
    const contents = 'new archive';
    const actual = sha256Text(contents);
    const wrongPrefix = `${actual[0] === 'a' ? 'b' : 'a'}${actual.slice(1, 12)}`;
    await writeIncoming(target.incomingSourceDir, contents, {
      overrides: { buildId: `fixture-${wrongPrefix}` },
    });

    await expect(
      promoteSource({
        source: 'pois',
        dataDir: target.dataDir,
        incomingDir: target.incomingDir,
      }),
    ).rejects.toThrow(/not content-addressed/);

    expect(await readFile(path.join(target.sourceDir, 'current.pmtiles'), 'utf8')).toBe(
      'current archive',
    );
  });

  it('rolls the current pair back when the smoke check fails', async () => {
    const root = await makeTemp();
    const target = paths(root);
    const current = await writePair(target.sourceDir, 'current', 'current archive');
    const previous = await writePair(target.sourceDir, 'previous', 'older archive');
    await writeIncoming(target.incomingSourceDir, 'new archive');
    const restart = vi.fn().mockResolvedValue(undefined);
    const smoke = vi
      .fn()
      .mockRejectedValueOnce(new Error('smoke failed'))
      .mockResolvedValue(undefined);

    await expect(
      promoteSource({
        source: 'pois',
        dataDir: target.dataDir,
        incomingDir: target.incomingDir,
        restart,
        smoke,
      }),
    ).rejects.toThrow(/previous pair was restored/);

    expect(await readFile(path.join(target.sourceDir, 'current.pmtiles'), 'utf8')).toBe(
      'current archive',
    );
    expect(await readFile(path.join(target.sourceDir, 'previous.pmtiles'), 'utf8')).toBe(
      'older archive',
    );
    const currentSidecar = JSON.parse(
      await readFile(path.join(target.sourceDir, 'current.json'), 'utf8'),
    );
    expect(currentSidecar.buildId).toBe(current.buildId);
    const previousSidecar = JSON.parse(
      await readFile(path.join(target.sourceDir, 'previous.json'), 'utf8'),
    );
    expect(previousSidecar.buildId).toBe(previous.buildId);
    expect(restart).toHaveBeenCalledTimes(2);
    expect(smoke).toHaveBeenCalledTimes(2);
    expect(await exists(path.join(target.incomingSourceDir, 'current.pmtiles'))).toBe(true);
  });

  it('rolls back when the service restart fails', async () => {
    const root = await makeTemp();
    const target = paths(root);
    await writePair(target.sourceDir, 'current', 'current archive');
    await writeIncoming(target.incomingSourceDir, 'new archive');
    const restart = vi
      .fn()
      .mockRejectedValueOnce(new Error('restart failed'))
      .mockResolvedValue(undefined);
    const smoke = vi.fn().mockResolvedValue(undefined);

    await expect(
      promoteSource({
        source: 'pois',
        dataDir: target.dataDir,
        incomingDir: target.incomingDir,
        restart,
        smoke,
      }),
    ).rejects.toThrow(/previous pair was restored/);

    expect(await readFile(path.join(target.sourceDir, 'current.pmtiles'), 'utf8')).toBe(
      'current archive',
    );
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it('does not claim restoration when the pair restore fails after a restart failure', async () => {
    const root = await makeTemp();
    const target = paths(root);
    await writePair(target.sourceDir, 'current', 'current archive');
    await writeIncoming(target.incomingSourceDir, 'new archive');
    const restart = vi
      .fn()
      .mockRejectedValueOnce(new Error('restart failed'))
      .mockResolvedValue(undefined);
    const smoke = vi.fn().mockResolvedValue(undefined);
    const err = makeErr();

    await expect(
      promoteSource({
        source: 'pois',
        dataDir: target.dataDir,
        incomingDir: target.incomingDir,
        restart,
        smoke,
        fsImpl: failingRestoreFs(),
        err,
      }),
    ).rejects.toThrow(/Restoring the previous pair also failed: disk full/);

    expect(err.text()).toContain('Restoring the previous pair also failed: disk full');
    expect(await exists(path.join(target.sourceDir, 'current.pmtiles'))).toBe(false);
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it('retains the deployment snapshot when the pair restore fails', async () => {
    const root = await makeTemp();
    const target = paths(root);
    await writePair(target.sourceDir, 'current', 'current archive');
    await writeIncoming(target.incomingSourceDir, 'new archive');
    const restart = vi
      .fn()
      .mockRejectedValueOnce(new Error('restart failed'))
      .mockResolvedValue(undefined);
    const smoke = vi.fn().mockResolvedValue(undefined);
    const err = makeErr();
    let caught;

    try {
      await promoteSource({
        source: 'pois',
        dataDir: target.dataDir,
        incomingDir: target.incomingDir,
        restart,
        smoke,
        fsImpl: failingRestoreFs(),
        err,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught?.message).toMatch(/Restoring the previous pair also failed: disk full/);

    const entries = await readdir(target.sourceDir);
    const backupName = entries.find((name) => name.startsWith('.deploy-backup-'));
    expect(backupName).toBeDefined();

    const backupDir = path.join(target.sourceDir, backupName);
    expect(caught?.message).toContain(backupDir);
    expect(err.text()).toContain(backupDir);
    expect(await readFile(path.join(backupDir, 'current.pmtiles'), 'utf8')).toBe('current archive');
  });

  it('makes no changes during a dry run', async () => {
    const root = await makeTemp();
    const target = paths(root);
    await writePair(target.sourceDir, 'current', 'current archive');
    const incoming = await writeIncoming(target.incomingSourceDir, 'new archive');
    const restart = vi.fn();
    const smoke = vi.fn();

    const result = await promoteSource({
      source: 'pois',
      dataDir: target.dataDir,
      incomingDir: target.incomingDir,
      restart,
      smoke,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.buildId).toBe(incoming.buildId);
    expect(await readFile(path.join(target.sourceDir, 'current.pmtiles'), 'utf8')).toBe(
      'current archive',
    );
    expect(restart).not.toHaveBeenCalled();
    expect(smoke).not.toHaveBeenCalled();
  });

  it('rejects a data-root incoming directory before inspecting or consuming live files', async () => {
    const root = await makeTemp();
    const target = paths(root);
    await writePair(target.sourceDir, 'current', 'current archive');
    await writePair(target.sourceDir, 'previous', 'older archive');

    await expect(
      promoteSource({
        source: 'pois',
        dataDir: target.dataDir,
        incomingDir: target.dataDir,
      }),
    ).rejects.toThrow(/must not be the data directory/);

    expect(await readFile(path.join(target.sourceDir, 'current.pmtiles'), 'utf8')).toBe(
      'current archive',
    );
    expect(await readFile(path.join(target.sourceDir, 'previous.pmtiles'), 'utf8')).toBe(
      'older archive',
    );
  });

  it('rejects an incoming directory nested inside the live source directory', async () => {
    const root = await makeTemp();
    const target = paths(root);
    await writePair(target.sourceDir, 'current', 'current archive');
    await writeIncoming(path.join(target.sourceDir, 'incoming', 'pois'), 'new archive');

    await expect(
      promoteSource({
        source: 'pois',
        dataDir: target.dataDir,
        incomingDir: path.join(target.sourceDir, 'incoming'),
      }),
    ).rejects.toThrow(/overlaps the live source directory/);

    expect(await readFile(path.join(target.sourceDir, 'current.pmtiles'), 'utf8')).toBe(
      'current archive',
    );
  });

  it('uses the configured archiveDir instead of dataDir/<source>', async () => {
    const root = await makeTemp();
    const dataDir = path.join(root, 'data');
    const customArchiveDir = path.join(root, 'archives', 'pois');
    const incomingDir = path.join(root, 'incoming');
    await writePair(customArchiveDir, 'current', 'current archive');
    const incoming = await writeIncoming(path.join(incomingDir, 'pois'), 'new archive');

    const result = await promoteSource({
      source: 'pois',
      appDir: root,
      dataDir,
      incomingDir,
      layers: layersFor(customArchiveDir),
    });

    expect(result.buildId).toBe(incoming.buildId);
    expect(await readFile(path.join(customArchiveDir, 'current.pmtiles'), 'utf8')).toBe(
      'new archive',
    );
    expect(await exists(path.join(dataDir, 'pois'))).toBe(false);
  });

  it('rejects a source that is not configured in layers.json', async () => {
    const root = await makeTemp();
    const target = paths(root);
    await writePair(target.sourceDir, 'current', 'current archive');
    await writeIncoming(target.incomingSourceDir, 'new archive');

    await expect(
      promoteSource({
        source: 'pois',
        dataDir: target.dataDir,
        incomingDir: target.incomingDir,
        layers: layersFor(path.join(target.dataDir, 'routes'), 'routes'),
      }),
    ).rejects.toThrow(/Unknown source "pois"/);

    expect(await readFile(path.join(target.sourceDir, 'current.pmtiles'), 'utf8')).toBe(
      'current archive',
    );
  });

  it('rejects an archiveDir outside the app and data directories', async () => {
    const root = await makeTemp();
    const target = paths(root);
    await writePair(target.sourceDir, 'current', 'current archive');

    await expect(
      promoteSource({
        source: 'pois',
        appDir: root,
        dataDir: target.dataDir,
        incomingDir: target.incomingDir,
        layers: layersFor('/etc'),
      }),
    ).rejects.toThrow(/outside the app and data directories/);
  });

  it('keeps incoming files when the promoted source is not healthy', async () => {
    const root = await makeTemp();
    const target = paths(root);
    await writePair(target.sourceDir, 'current', 'current archive');
    await writeIncoming(target.incomingSourceDir, 'new archive');
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/ready')) {
        return { status: 200, json: async () => ({ status: 'ready' }) };
      }

      return {
        status: 200,
        json: async () => ({ sources: [{ name: 'pois', available: false, buildId: null }] }),
      };
    });

    await expect(
      promoteSource({
        source: 'pois',
        dataDir: target.dataDir,
        incomingDir: target.incomingDir,
        healthUrl: 'http://127.0.0.1:11010',
        fetchImpl,
      }),
    ).rejects.toThrow(/is not available/);

    expect(await readFile(path.join(target.sourceDir, 'current.pmtiles'), 'utf8')).toBe(
      'current archive',
    );
    expect(await exists(path.join(target.incomingSourceDir, 'current.pmtiles'))).toBe(true);
  });
});

describe('verifyPromotedSource', () => {
  const buildId = 'fixture-abcdef123456';
  const readyResponse = () => ({ status: 200, json: async () => ({ status: 'ready' }) });
  const sourcesResponse = () => ({
    status: 200,
    json: async () => ({ sources: [{ name: 'pois', available: true, buildId }] }),
  });

  it('retries when the first fetch rejects and succeeds once the server accepts requests', async () => {
    let readyAttempts = 0;
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/ready')) {
        readyAttempts += 1;

        if (readyAttempts === 1) {
          throw new TypeError('fetch failed');
        }

        return readyResponse();
      }

      return sourcesResponse();
    });

    const entry = await verifyPromotedSource({
      fetchImpl,
      healthUrl: 'http://127.0.0.1:11010',
      source: 'pois',
      buildId,
      sleep: async () => {},
    });

    expect(entry).toEqual({ name: 'pois', available: true, buildId });
    expect(readyAttempts).toBe(2);
  });

  it('retries a transient 503 from /ready before succeeding', async () => {
    let readyAttempts = 0;
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/ready')) {
        readyAttempts += 1;

        return readyAttempts === 1 ? { status: 503, json: async () => ({}) } : readyResponse();
      }

      return sourcesResponse();
    });

    const entry = await verifyPromotedSource({
      fetchImpl,
      healthUrl: 'http://127.0.0.1:11010',
      source: 'pois',
      buildId,
      sleep: async () => {},
    });

    expect(entry.buildId).toBe(buildId);
    expect(readyAttempts).toBe(2);
  });

  it('fails after the deadline when the server never answers', async () => {
    let clock = 0;
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const sleep = vi.fn(async (delayMs) => {
      clock += delayMs;
    });

    await expect(
      verifyPromotedSource({
        fetchImpl,
        healthUrl: 'http://127.0.0.1:11010',
        source: 'pois',
        buildId,
        timeoutMs: 1_000,
        retryDelayMs: 250,
        sleep,
        now: () => clock,
      }),
    ).rejects.toThrow(/did not become healthy within 1000ms.*fetch failed/);

    expect(sleep).toHaveBeenCalledTimes(4);
  });
});

describe('rollbackSource', () => {
  it('swaps current and previous and keeps the old current as previous', async () => {
    const root = await makeTemp();
    const target = paths(root);
    const current = await writePair(target.sourceDir, 'current', 'current archive');
    const previous = await writePair(target.sourceDir, 'previous', 'previous archive');
    const restart = vi.fn().mockResolvedValue(undefined);
    const smoke = vi.fn().mockResolvedValue(undefined);

    const result = await rollbackSource({
      source: 'pois',
      dataDir: target.dataDir,
      restart,
      smoke,
    });

    expect(result.buildId).toBe(previous.buildId);
    expect(await readFile(path.join(target.sourceDir, 'current.pmtiles'), 'utf8')).toBe(
      'previous archive',
    );
    expect(await readFile(path.join(target.sourceDir, 'previous.pmtiles'), 'utf8')).toBe(
      'current archive',
    );
    const currentSidecar = JSON.parse(
      await readFile(path.join(target.sourceDir, 'current.json'), 'utf8'),
    );
    expect(currentSidecar.buildId).toBe(previous.buildId);
    const previousSidecar = JSON.parse(
      await readFile(path.join(target.sourceDir, 'previous.json'), 'utf8'),
    );
    expect(previousSidecar.buildId).toBe(current.buildId);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(smoke).toHaveBeenCalledTimes(1);
  });

  it('fails safely when no previous pair exists', async () => {
    const root = await makeTemp();
    const target = paths(root);
    await writePair(target.sourceDir, 'current', 'current archive');
    const restart = vi.fn();
    const smoke = vi.fn();

    await expect(
      rollbackSource({ source: 'pois', dataDir: target.dataDir, restart, smoke }),
    ).rejects.toThrow(/previous archive is missing/);

    expect(await readFile(path.join(target.sourceDir, 'current.pmtiles'), 'utf8')).toBe(
      'current archive',
    );
    expect(restart).not.toHaveBeenCalled();
    expect(smoke).not.toHaveBeenCalled();
  });

  it('restores both pairs when rollback smoke fails', async () => {
    const root = await makeTemp();
    const target = paths(root);
    const current = await writePair(target.sourceDir, 'current', 'current archive');
    const previous = await writePair(target.sourceDir, 'previous', 'previous archive');
    const restart = vi.fn().mockResolvedValue(undefined);
    const smoke = vi
      .fn()
      .mockRejectedValueOnce(new Error('smoke failed'))
      .mockResolvedValue(undefined);

    await expect(
      rollbackSource({ source: 'pois', dataDir: target.dataDir, restart, smoke }),
    ).rejects.toThrow(/previous pair was restored/);

    expect(await readFile(path.join(target.sourceDir, 'current.pmtiles'), 'utf8')).toBe(
      'current archive',
    );
    expect(await readFile(path.join(target.sourceDir, 'previous.pmtiles'), 'utf8')).toBe(
      'previous archive',
    );
    const currentSidecar = JSON.parse(
      await readFile(path.join(target.sourceDir, 'current.json'), 'utf8'),
    );
    expect(currentSidecar.buildId).toBe(current.buildId);
    const previousSidecar = JSON.parse(
      await readFile(path.join(target.sourceDir, 'previous.json'), 'utf8'),
    );
    expect(previousSidecar.buildId).toBe(previous.buildId);
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it('does not claim restoration when the pair restore fails after a restart failure', async () => {
    const root = await makeTemp();
    const target = paths(root);
    await writePair(target.sourceDir, 'current', 'current archive');
    await writePair(target.sourceDir, 'previous', 'previous archive');
    const restart = vi
      .fn()
      .mockRejectedValueOnce(new Error('restart failed'))
      .mockResolvedValue(undefined);
    const smoke = vi.fn().mockResolvedValue(undefined);
    const err = makeErr();

    await expect(
      rollbackSource({
        source: 'pois',
        dataDir: target.dataDir,
        restart,
        smoke,
        fsImpl: failingRestoreFs(),
        err,
      }),
    ).rejects.toThrow(/Restoring the previous pair also failed: disk full/);

    expect(err.text()).toContain('Restoring the previous pair also failed: disk full');
    expect(await exists(path.join(target.sourceDir, 'current.pmtiles'))).toBe(false);
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it('verifies the restored source and rolls back when it is not healthy', async () => {
    const root = await makeTemp();
    const target = paths(root);
    await writePair(target.sourceDir, 'current', 'current archive');
    await writePair(target.sourceDir, 'previous', 'previous archive');
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith('/ready')) {
        return { status: 200, json: async () => ({ status: 'ready' }) };
      }

      return {
        status: 200,
        json: async () => ({ sources: [{ name: 'pois', available: false, buildId: null }] }),
      };
    });

    await expect(
      rollbackSource({
        source: 'pois',
        dataDir: target.dataDir,
        healthUrl: 'http://127.0.0.1:11010',
        fetchImpl,
      }),
    ).rejects.toThrow(/Restored source "pois" is not available/);

    expect(await readFile(path.join(target.sourceDir, 'current.pmtiles'), 'utf8')).toBe(
      'current archive',
    );
    expect(await readFile(path.join(target.sourceDir, 'previous.pmtiles'), 'utf8')).toBe(
      'previous archive',
    );
  });

  it('rejects a source that is not configured in layers.json', async () => {
    const root = await makeTemp();
    const target = paths(root);
    await writePair(target.sourceDir, 'current', 'current archive');
    await writePair(target.sourceDir, 'previous', 'previous archive');

    await expect(
      rollbackSource({
        source: 'pois',
        dataDir: target.dataDir,
        layers: layersFor(path.join(target.dataDir, 'routes'), 'routes'),
      }),
    ).rejects.toThrow(/Unknown source "pois"/);
  });

  it('makes no changes during a dry run', async () => {
    const root = await makeTemp();
    const target = paths(root);
    await writePair(target.sourceDir, 'current', 'current archive');
    const previous = await writePair(target.sourceDir, 'previous', 'previous archive');
    const restart = vi.fn();
    const smoke = vi.fn();

    const result = await rollbackSource({
      source: 'pois',
      dataDir: target.dataDir,
      restart,
      smoke,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.buildId).toBe(previous.buildId);
    expect(await readFile(path.join(target.sourceDir, 'current.pmtiles'), 'utf8')).toBe(
      'current archive',
    );
    expect(restart).not.toHaveBeenCalled();
    expect(smoke).not.toHaveBeenCalled();
  });

  it('uses the configured archiveDir for rollback', async () => {
    const root = await makeTemp();
    const dataDir = path.join(root, 'data');
    const customArchiveDir = path.join(root, 'archives', 'pois');
    await writePair(customArchiveDir, 'current', 'current archive');
    const previous = await writePair(customArchiveDir, 'previous', 'previous archive');

    const result = await rollbackSource({
      source: 'pois',
      appDir: root,
      dataDir,
      layers: layersFor(customArchiveDir),
    });

    expect(result.buildId).toBe(previous.buildId);
    expect(await readFile(path.join(customArchiveDir, 'current.pmtiles'), 'utf8')).toBe(
      'previous archive',
    );
    expect(await exists(path.join(dataDir, 'pois'))).toBe(false);
  });
});
