import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { runCommand } from '../build/exec.mjs';
import { loadConfig } from '../lib/config.mjs';
import { runStatus as runCloudStatus } from '../provision/provision.mjs';

import { DeployError } from './config.mjs';
import { remoteEnvironment } from './remote.mjs';
import { quoteIfNeeded, runRemote, shellQuote } from './ssh.mjs';

const defaultFs = { readFile, stat };

function archiveDirectory(source, appDir) {
  return path.isAbsolute(source.archiveDir)
    ? source.archiveDir
    : path.resolve(appDir, source.archiveDir);
}

async function readSidecar(fsImpl, target) {
  try {
    return JSON.parse(await fsImpl.readFile(target, 'utf8'));
  } catch {
    return null;
  }
}

async function readPair({ directory, kind, fsImpl }) {
  const archivePath = path.join(directory, `${kind}.pmtiles`);
  const sidecarPath = path.join(directory, `${kind}.json`);
  const sidecar = await readSidecar(fsImpl, sidecarPath);

  let available = false;
  let bytes = null;

  try {
    const info = await fsImpl.stat(archivePath);
    available = true;
    bytes = info.size ?? null;
  } catch {
    available = false;
  }

  return {
    buildId: sidecar?.buildId ?? (available ? kind : null),
    available,
    bytes,
    archivePath,
    sidecarPath,
    archiveSha256: sidecar?.archive?.sha256 ?? null,
  };
}

export async function readSourceState({ layers, appDir, fsImpl = defaultFs } = {}) {
  if (!layers?.sources) {
    throw new DeployError('A layers configuration is required to read source state');
  }

  const sources = [];

  for (const [name, source] of Object.entries(layers.sources)) {
    if (source?.kind !== 'pmtiles') {
      continue;
    }

    const directory = archiveDirectory(source, appDir);
    sources.push({
      name,
      directory,
      current: await readPair({ directory, kind: 'current', fsImpl }),
      previous: await readPair({ directory, kind: 'previous', fsImpl }),
    });
  }

  return sources;
}

export async function serviceStatus({
  serviceName,
  execImpl = runCommand,
  env = process.env,
} = {}) {
  try {
    const { stdout } = await execImpl('systemctl', ['is-active', serviceName], {
      encoding: 'utf8',
      env,
    });
    const state = String(stdout).trim();

    return { active: state === 'active', state: state || 'unknown' };
  } catch (error) {
    return { active: false, state: 'unknown', error: error.message };
  }
}

async function probe({ url, fetchImpl, timeoutMs }) {
  try {
    const response = await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    });

    let state = null;
    if (typeof response.json === 'function') {
      try {
        const body = await response.json();
        state = body?.status ?? null;
      } catch {
        state = null;
      }
    }

    return { url, status: response.status, ok: response.ok, state };
  } catch (error) {
    return { url, status: null, ok: false, state: null, error: error.message };
  }
}

export async function runServerStatus({
  config,
  layers,
  appDir,
  fsImpl = defaultFs,
  execImpl = runCommand,
  fetchImpl = globalThis.fetch,
  out = process.stdout,
  json = false,
  env = process.env,
  timeoutMs = 5_000,
} = {}) {
  if (!config) {
    throw new DeployError('Deployment configuration is required for server status');
  }

  const root = appDir ?? config.appDir;
  const configPath = path.resolve(root, config.configPath ?? 'config/layers.json');
  const effectiveLayers = layers ?? loadConfig(configPath, { repoRoot: root });

  const service = await serviceStatus({ serviceName: config.serviceName, execImpl, env });
  const sources = await readSourceState({ layers: effectiveLayers, appDir: root, fsImpl });
  const base = `http://127.0.0.1:${config.port}`;
  const health = await probe({ url: `${base}/health`, fetchImpl, timeoutMs });
  const ready = await probe({ url: `${base}/ready`, fetchImpl, timeoutMs });

  const result = { service, sources, health, ready };

  if (json) {
    out.write(`${JSON.stringify(result)}\n`);
    return result;
  }

  printServerStatus(result, out, { config });
  return result;
}

export function printServerStatus(result, out, { config } = {}) {
  const target = config ? ` (${config.deployUser}@${config.targetHost})` : '';
  out.write(`Server: reachable${target}\n`);
  out.write(
    `Service: ${result.service.active ? 'active' : result.service.state}${
      result.service.error ? ` (${result.service.error})` : ''
    }\n`,
  );
  out.write('Sources:\n');

  for (const source of result.sources) {
    out.write(
      `  ${source.name}: current ${source.current.buildId ?? 'none'} ` +
        `(available: ${source.current.available}); ` +
        `previous ${source.previous.buildId ?? 'none'} ` +
        `(available: ${source.previous.available})\n`,
    );
  }

  for (const [label, probeResult] of [
    ['Health', result.health],
    ['Ready', result.ready],
  ]) {
    const status = probeResult.status === null ? 'unreachable' : `HTTP ${probeResult.status}`;
    out.write(`${label}: ${probeResult.url} -> ${status}\n`);
  }
}

export function remoteServerStatusCommand(config) {
  return (
    `cd ${shellQuote(config.appDir)} && ` +
    `env ${remoteEnvironment(config).join(' ')} ` +
    `${quoteIfNeeded(config.nodeBin)} bin/ogis.mjs status --server-side --json`
  );
}

export async function fetchRemoteServerStatus({
  config,
  execImpl = runCommand,
  env = process.env,
  timeoutMs,
} = {}) {
  const { stdout } = await runRemote(config, remoteServerStatusCommand(config), {
    execImpl,
    env,
    timeoutMs,
    label: 'Server status',
  });

  try {
    return JSON.parse(String(stdout).trim());
  } catch (error) {
    throw new DeployError(`Server status returned invalid JSON: ${error.message}`, {
      cause: error,
    });
  }
}

export async function runDeployStatus({
  cloud = null,
  deployConfig = null,
  options = {},
  out = process.stdout,
  err = process.stderr,
  dnsImpl,
  fetchImpl = globalThis.fetch,
  execImpl = runCommand,
  env = process.env,
  timeoutMs = 5_000,
  cloudStatusImpl = runCloudStatus,
} = {}) {
  let cloudResult = null;

  if (cloud) {
    cloudResult = await cloudStatusImpl({
      config: cloud.config,
      client: cloud.client,
      dnsImpl,
      out,
      fetchImpl,
      timeoutMs,
      options: {
        server: options.server,
        host: options.host,
        health: options.health !== false,
      },
    });
  }

  if (options.cloudOnly) {
    return { cloud: cloudResult, server: null };
  }

  if (!deployConfig) {
    return { cloud: cloudResult, server: null };
  }

  if (!deployConfig.deployPrivateKeyPath) {
    if (options.serverOnly) {
      throw new DeployError('SSH_PRIVATE_KEY_PATH is required for server status');
    }

    err.write('Server status skipped: SSH_PRIVATE_KEY_PATH is not configured\n');
    return { cloud: cloudResult, server: null };
  }

  try {
    const result = await fetchRemoteServerStatus({
      config: deployConfig,
      execImpl,
      env,
      timeoutMs,
    });
    printServerStatus(result, out, { config: deployConfig });

    return { cloud: cloudResult, server: result };
  } catch (error) {
    if (options.serverOnly) {
      throw error;
    }

    out.write(`Server: unreachable (${error.message})\n`);
    return { cloud: cloudResult, server: null, serverError: error };
  }
}
