import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchRemoteServerStatus,
  readSourceState,
  runDeployStatus,
  runServerStatus,
} from '../../../src/deploy/status.mjs';
import { sha256Text } from '../../../src/build/fs.mjs';
import { createTempDirectory, removeTempDirectory } from '../../helpers/temp.mjs';

const created = [];

async function makeTemp() {
  const root = await createTempDirectory('tiles-deploy-status-');
  created.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => removeTempDirectory(directory)));
});

function makeOut() {
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

function buildIdFor(contents) {
  return `fixture-${sha256Text(contents).slice(0, 12)}`;
}

async function writePair(directory, kind, contents) {
  await mkdir(directory, { recursive: true });
  const buildId = buildIdFor(contents);
  await writeFile(path.join(directory, `${kind}.pmtiles`), contents, 'utf8');
  await writeFile(
    path.join(directory, `${kind}.json`),
    JSON.stringify({ buildId, archive: { sha256: sha256Text(contents) } }),
    'utf8',
  );
  return buildId;
}

function makeConfig(root) {
  return {
    host: 'tile.ogis.app',
    targetHost: 'tile.ogis.app',
    deployUser: 'deploy',
    deployPrivateKeyPath: '/home/joe/.ssh/ogis_tiles',
    appDir: root,
    dataDir: path.join(root, 'data'),
    incomingDir: path.join(root, 'data', 'incoming'),
    configPath: 'config/layers.json',
    serviceName: 'ogis-tiles.service',
    nodeBin: '/usr/local/bin/node',
    port: 11010,
  };
}

function makeLayers(dataDir) {
  return {
    sources: {
      pois: { kind: 'pmtiles', archiveDir: path.join(dataDir, 'pois') },
      contours: { kind: 'contour' },
    },
  };
}

function makeFetch(statuses = {}) {
  const values = { health: 200, ready: 503, ...statuses };

  return vi.fn(async (url) => {
    const key = url.endsWith('/health') ? 'health' : 'ready';
    const status = values[key];
    return {
      status,
      ok: status < 400,
      json: async () => ({ status: status === 200 ? 'ok' : 'degraded' }),
    };
  });
}

describe('readSourceState', () => {
  it('reports current and previous build IDs and archive availability', async () => {
    const root = await makeTemp();
    const dataDir = path.join(root, 'data');
    const current = await writePair(path.join(dataDir, 'pois'), 'current', 'current archive');
    const previous = await writePair(path.join(dataDir, 'pois'), 'previous', 'previous archive');

    const state = await readSourceState({ layers: makeLayers(dataDir), appDir: root });

    expect(state).toHaveLength(1);
    expect(state[0]).toMatchObject({
      name: 'pois',
      current: { buildId: current, available: true },
      previous: { buildId: previous, available: true },
    });
  });

  it('marks missing archives unavailable while still reporting a sidecar build ID', async () => {
    const root = await makeTemp();
    const dataDir = path.join(root, 'data');
    const directory = path.join(dataDir, 'pois');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'current.json'), '{"buildId":"fixture-aaaaaaaaaaaa"}');

    const state = await readSourceState({ layers: makeLayers(dataDir), appDir: root });

    expect(state[0].current.buildId).toBe('fixture-aaaaaaaaaaaa');
    expect(state[0].current.available).toBe(false);
    expect(state[0].previous.buildId).toBeNull();
  });
});

describe('runServerStatus', () => {
  it('prints service state, source state and health probes', async () => {
    const root = await makeTemp();
    const dataDir = path.join(root, 'data');
    const current = await writePair(path.join(dataDir, 'pois'), 'current', 'current archive');
    const out = makeOut();
    const execImpl = vi.fn().mockResolvedValue({ stdout: 'active\n', stderr: '' });

    const result = await runServerStatus({
      config: makeConfig(root),
      layers: makeLayers(dataDir),
      execImpl,
      fetchImpl: makeFetch(),
      out,
    });

    expect(execImpl).toHaveBeenCalledWith('systemctl', ['is-active', 'ogis-tiles.service'], {
      encoding: 'utf8',
      env: process.env,
    });
    expect(result.service).toEqual({ active: true, state: 'active' });
    expect(result.sources[0].current.buildId).toBe(current);
    expect(result.health.status).toBe(200);
    expect(result.ready.status).toBe(503);
    expect(out.text()).toContain('Service: active');
    expect(out.text()).toContain(`current ${current}`);
    expect(out.text()).toContain('/health -> HTTP 200');
    expect(out.text()).toContain('/ready -> HTTP 503');
  });

  it('prints JSON for the remote status command', async () => {
    const root = await makeTemp();
    const out = makeOut();

    await runServerStatus({
      config: makeConfig(root),
      layers: makeLayers(path.join(root, 'data')),
      execImpl: vi.fn().mockResolvedValue({ stdout: 'inactive\n' }),
      fetchImpl: makeFetch(),
      out,
      json: true,
    });

    const parsed = JSON.parse(out.text());
    expect(parsed.service.active).toBe(false);
    expect(parsed.sources).toHaveLength(1);
    expect(parsed.sources[0].name).toBe('pois');
  });
});

describe('fetchRemoteServerStatus', () => {
  it('runs the server-side status command over SSH and parses JSON', async () => {
    const payload = {
      service: { active: true, state: 'active' },
      sources: [],
      health: {},
      ready: {},
    };
    const execImpl = vi.fn().mockResolvedValue({ stdout: `${JSON.stringify(payload)}\n` });

    const result = await fetchRemoteServerStatus({
      config: makeConfig('/opt/ogis-tiles'),
      execImpl,
    });

    expect(result).toEqual(payload);
    const [, args] = execImpl.mock.calls[0];
    expect(args.at(-1)).toContain('status --server-side --json');
    expect(args.at(-1)).toContain('/opt/ogis-tiles');
  });

  it('propagates the deployment environment to the remote status command', async () => {
    const execImpl = vi.fn().mockResolvedValue({ stdout: '{}' });

    await fetchRemoteServerStatus({
      config: {
        ...makeConfig('/srv/ogis tiles'),
        dataDir: '/srv/tiles data',
        incomingDir: '/srv/tiles incoming',
        configPath: 'config/custom layers.json',
        serviceName: 'tiles.service',
        nodeBin: '/opt/my node/bin/node',
        port: 12001,
      },
      execImpl,
    });

    const [, args] = execImpl.mock.calls[0];
    const remote = args.at(-1);

    expect(remote).toContain("PORT='12001'");
    expect(remote).toContain("SERVICE_NAME='tiles.service'");
    expect(remote).toContain("CONFIG_PATH='config/custom layers.json'");
    expect(remote).toContain("TILE_DATA_DIR='/srv/tiles data'");
    expect(remote).toContain("TILE_INCOMING_DIR='/srv/tiles incoming'");
    expect(remote).toContain("NODE_BIN='/opt/my node/bin/node'");
    expect(remote).toContain("'/opt/my node/bin/node' bin/ogis.mjs status --server-side --json");
  });

  it('rejects invalid JSON from the server', async () => {
    const execImpl = vi.fn().mockResolvedValue({ stdout: 'not json' });

    await expect(
      fetchRemoteServerStatus({ config: makeConfig('/opt/ogis-tiles'), execImpl }),
    ).rejects.toThrow(/invalid JSON/);
  });
});

describe('runDeployStatus', () => {
  it('does not run SSH checks with --cloud-only', async () => {
    const execImpl = vi.fn();
    const cloudStatusImpl = vi.fn().mockResolvedValue({ server: { id: 42 } });
    const out = makeOut();

    await runDeployStatus({
      cloud: { config: { host: 'tile.ogis.app' }, client: {} },
      deployConfig: makeConfig('/opt/ogis-tiles'),
      options: { cloudOnly: true },
      out,
      execImpl,
      cloudStatusImpl,
    });

    expect(cloudStatusImpl).toHaveBeenCalledTimes(1);
    expect(execImpl).not.toHaveBeenCalled();
  });

  it('reports server status with --server-only without a cloud client', async () => {
    const payload = {
      service: { active: true, state: 'active' },
      sources: [
        {
          name: 'pois',
          current: { buildId: 'fixture-aaaaaaaaaaaa', available: true },
          previous: { buildId: null, available: false },
        },
      ],
      health: { url: 'http://127.0.0.1:11010/health', status: 200, ok: true },
      ready: { url: 'http://127.0.0.1:11010/ready', status: 503, ok: false },
    };
    const execImpl = vi.fn().mockResolvedValue({ stdout: JSON.stringify(payload) });
    const cloudStatusImpl = vi.fn();
    const out = makeOut();

    const result = await runDeployStatus({
      deployConfig: makeConfig('/opt/ogis-tiles'),
      options: { serverOnly: true },
      out,
      execImpl,
      cloudStatusImpl,
    });

    expect(cloudStatusImpl).not.toHaveBeenCalled();
    expect(result.server).toEqual(payload);
    expect(out.text()).toContain('Server: reachable');
    expect(out.text()).toContain('fixture-aaaaaaaaaaaa');
    expect(out.text()).toContain('/ready -> HTTP 503');
  });

  it('requires an SSH key for --server-only', async () => {
    await expect(
      runDeployStatus({
        deployConfig: { ...makeConfig('/opt/ogis-tiles'), deployPrivateKeyPath: '' },
        options: { serverOnly: true },
      }),
    ).rejects.toThrow(/SSH_PRIVATE_KEY_PATH is required/);
  });

  it('reports an unreachable server without failing a combined status', async () => {
    const execImpl = vi.fn().mockRejectedValue(new Error('connection refused'));
    const out = makeOut();

    const result = await runDeployStatus({
      deployConfig: makeConfig('/opt/ogis-tiles'),
      options: {},
      out,
      execImpl,
    });

    expect(result.server).toBeNull();
    expect(out.text()).toContain('Server: unreachable');
  });
});
