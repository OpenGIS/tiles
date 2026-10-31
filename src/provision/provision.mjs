import dns from 'node:dns';
import { readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runCommand } from '../build/exec.mjs';
import {
  cloudInitPaths,
  MAX_CLOUD_CONFIG_BYTES,
  NODE_SHA256,
  NODE_TARBALL_URL,
  NODE_VERSION,
  renderCloudInit,
} from './cloud-init.mjs';

const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
const SERVER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;
const USERNAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const PUBLIC_KEY_PATTERN =
  /^(?:ssh-|ecdsa-|sk-)[A-Za-z0-9@._-]+ [A-Za-z0-9+/]+={0,3}(?: [^\r\n]*)?$/;
const CHILD_ENV_ALLOWLIST = ['PATH', 'HOME', 'SSH_AUTH_SOCK', 'TERM'];
const ARM_SERVER_TYPE_PATTERN = /^cax/i;
const MIN_UNPRIVILEGED_PORT = 1024;
const MAX_PORT = 65_535;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_CLOUD_INIT_TIMEOUT_MS = 900_000;
const FAIL2BAN_ENABLE_COMMAND =
  'DEBIAN_FRONTEND=noninteractive apt-get update -o DPkg::Lock::Timeout=120 && ' +
  'DEBIAN_FRONTEND=noninteractive apt-get install -y -o DPkg::Lock::Timeout=120 fail2ban && ' +
  'systemctl enable --now fail2ban';

const defaultFs = { readFile, stat };

export class ProvisionError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'ProvisionError';
  }
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export function childEnvironment(env = process.env) {
  const filtered = {};

  for (const name of CHILD_ENV_ALLOWLIST) {
    const value = env?.[name];
    if (typeof value === 'string' && value !== '') {
      filtered[name] = value;
    }
  }

  return filtered;
}

async function runBounded(execImpl, command, args, options, timeoutMs, label) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return execImpl(command, args, options);
  }

  let timer;
  try {
    return await Promise.race([
      execImpl(command, args, { ...options, timeoutMs }),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          reject(new ProvisionError(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function requireValue(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ProvisionError(`${name} is required`);
  }

  return value.trim();
}

function optionalValue(env, name, fallback) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    return fallback;
  }

  return value.trim();
}

function validHostname(value) {
  return HOSTNAME_PATTERN.test(String(value ?? '').trim());
}

function validIPv4(value) {
  const parts = String(value ?? '')
    .trim()
    .split('.');
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  );
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function expandHome(value, homedir = os.homedir()) {
  if (value === '~') {
    return homedir;
  }

  if (value.startsWith('~/')) {
    return path.join(homedir, value.slice(2));
  }

  return value;
}

export function parseEnvFile(contents) {
  const values = {};

  for (const rawLine of String(contents).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    const name = match[1];
    let value = match[2].trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
    } else {
      const comment = value.indexOf(' #');
      if (comment !== -1) {
        value = value.slice(0, comment).trim();
      }
    }

    values[name] = value;
  }

  return values;
}

export async function loadEnvironment({ env = process.env, envPath, fsImpl = defaultFs } = {}) {
  let fileValues = {};

  if (envPath) {
    try {
      fileValues = parseEnvFile(await fsImpl.readFile(envPath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new ProvisionError(`Unable to read ${envPath}: ${error.message}`, { cause: error });
      }
    }
  }

  return { ...fileValues, ...env };
}

function keyPath(env, name, { required, homedir, fallback = '' }) {
  const raw = required ? requireValue(env, name) : optionalValue(env, name, fallback);

  return raw === '' ? '' : expandHome(raw, homedir);
}

export function resolveConfig({ env, homedir = os.homedir(), requireSshKeys = false } = {}) {
  if (env === undefined || env === null) {
    throw new ProvisionError('Provisioning environment is required');
  }

  const host = requireValue(env, 'TILE_SERVER_HOST');
  if (!validHostname(host)) {
    throw new ProvisionError(`TILE_SERVER_HOST "${host}" is not a valid hostname`);
  }

  const serverIp = optionalValue(env, 'TILE_SERVER_IP', '');
  if (serverIp !== '' && !validIPv4(serverIp)) {
    throw new ProvisionError(`TILE_SERVER_IP "${serverIp}" is not a valid IPv4 address`);
  }

  const serverName = optionalValue(env, 'SERVER_NAME', 'ogis-tiles');
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    throw new ProvisionError(`SERVER_NAME "${serverName}" is not a valid server name`);
  }

  const serverType = optionalValue(env, 'SERVER_TYPE', 'cx23');
  if (ARM_SERVER_TYPE_PATTERN.test(serverType)) {
    throw new ProvisionError(
      `SERVER_TYPE "${serverType}" is not x86; the image and Node tarball are x86 only`,
    );
  }

  const deployUser = optionalValue(env, 'DEPLOY_USER', 'deploy');
  const buildUser = optionalValue(env, 'BUILD_USER', 'build');
  if (!USERNAME_PATTERN.test(deployUser)) {
    throw new ProvisionError(`DEPLOY_USER "${deployUser}" is not a valid Linux user name`);
  }

  if (!USERNAME_PATTERN.test(buildUser)) {
    throw new ProvisionError(`BUILD_USER "${buildUser}" is not a valid Linux user name`);
  }

  if (deployUser === buildUser || deployUser === 'root' || buildUser === 'root') {
    throw new ProvisionError('DEPLOY_USER and BUILD_USER must be distinct non-root users');
  }

  const certbotEmail = optionalValue(env, 'CERTBOT_EMAIL', '');
  if (certbotEmail !== '' && !validEmail(certbotEmail)) {
    throw new ProvisionError(`CERTBOT_EMAIL "${certbotEmail}" is not a valid email address`);
  }

  const port = Number(optionalValue(env, 'PORT', '11010'));
  if (!Number.isInteger(port) || port < MIN_UNPRIVILEGED_PORT || port > MAX_PORT) {
    throw new ProvisionError(
      `PORT "${env.PORT}" must be an unprivileged port between ${MIN_UNPRIVILEGED_PORT} and ${MAX_PORT}`,
    );
  }

  const deployPrivateKeyPath = keyPath(env, 'SSH_PRIVATE_KEY_PATH', {
    required: requireSshKeys,
    homedir,
  });
  const buildPrivateKeyPath = keyPath(env, 'BUILD_SSH_PRIVATE_KEY_PATH', {
    required: requireSshKeys,
    homedir,
  });
  const deployPublicKeyPath = keyPath(env, 'SSH_PUBLIC_KEY_PATH', {
    required: false,
    homedir,
    fallback: deployPrivateKeyPath === '' ? '' : `${deployPrivateKeyPath}.pub`,
  });
  const buildPublicKeyPath = keyPath(env, 'BUILD_SSH_PUBLIC_KEY_PATH', {
    required: false,
    homedir,
    fallback: buildPrivateKeyPath === '' ? '' : `${buildPrivateKeyPath}.pub`,
  });

  return {
    token: requireValue(env, 'HCLOUD_TOKEN'),
    host,
    serverIp,
    serverName,
    serverType,
    location: optionalValue(env, 'LOCATION', 'nbg1'),
    image: optionalValue(env, 'IMAGE', 'ubuntu-26.04'),
    certbotEmail,
    deployUser,
    buildUser,
    port,
    deployPrivateKeyPath,
    deployPublicKeyPath,
    buildPrivateKeyPath,
    buildPublicKeyPath,
  };
}

async function pathExists(target, fsImpl) {
  try {
    await fsImpl.stat(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }

    throw error;
  }
}

function normalisePublicKey(value, label) {
  const key = String(value ?? '').trim();

  if (/PRIVATE KEY/.test(key)) {
    throw new ProvisionError(`${label} looks like private key material, not a public key`);
  }

  if (/^sk-/i.test(key)) {
    throw new ProvisionError(
      `${label} is a hardware-backed (sk-) key; provisioning needs a standard SSH public key`,
    );
  }

  if (key.split(/\r?\n/).length !== 1) {
    throw new ProvisionError(`${label} public key must be a single line`);
  }

  if (!PUBLIC_KEY_PATTERN.test(key)) {
    throw new ProvisionError(`${label} is not a valid SSH public key`);
  }

  return key;
}

function publicKeyMaterial(value) {
  return value.split(/\s+/).slice(0, 2).join(' ');
}

export async function resolvePublicKey({
  privateKeyPath,
  publicKeyPath = `${privateKeyPath}.pub`,
  label = 'SSH',
  fsImpl = defaultFs,
  execImpl = runCommand,
  env = process.env,
  timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
} = {}) {
  if (privateKeyPath === undefined || privateKeyPath === '') {
    throw new ProvisionError(`A private key path is required for the ${label} key`);
  }

  let derived;
  try {
    const { stdout } = await runBounded(
      execImpl,
      'ssh-keygen',
      ['-y', '-P', '', '-f', privateKeyPath],
      { encoding: 'utf8', env: childEnvironment(env) },
      timeoutMs,
      `${label} public key derivation`,
    );
    derived = normalisePublicKey(stdout, label);
  } catch (error) {
    if (error instanceof ProvisionError && !/timed out/.test(error.message)) {
      throw error;
    }

    throw new ProvisionError(
      `Unable to derive the ${label} public key from ${privateKeyPath}. ` +
        'Use an unencrypted deploy key: BatchMode SSH cannot prompt for a passphrase ' +
        `(${error.message})`,
      { cause: error },
    );
  }

  if (publicKeyPath && (await pathExists(publicKeyPath, fsImpl))) {
    let configured;
    try {
      configured = normalisePublicKey(await fsImpl.readFile(publicKeyPath, 'utf8'), label);
    } catch (error) {
      if (error instanceof ProvisionError) {
        throw error;
      }

      throw new ProvisionError(
        `Unable to read the ${label} public key at ${publicKeyPath}: ${error.message}`,
        { cause: error },
      );
    }

    if (publicKeyMaterial(configured) !== publicKeyMaterial(derived)) {
      throw new ProvisionError(
        `${label} public key at ${publicKeyPath} does not match the private key ` +
          `${privateKeyPath}; refusing to install a key the provisioner cannot use`,
      );
    }
  }

  return derived;
}

function serverIPv4(server) {
  return server?.public_net?.ipv4?.ip ?? null;
}

function serverIPv6(server) {
  return server?.public_net?.ipv6?.ip ?? null;
}

function serverLabel(server) {
  return `${server.name} (#${server.id}, ${server.server_type?.name ?? 'unknown type'}, ${
    serverIPv4(server) ?? 'no IPv4'
  })`;
}

async function resolveTarget({
  client,
  config,
  dnsImpl,
  serverOverride,
  verify = true,
  requireIPv4 = true,
  warn = () => {},
}) {
  let expectedIp = config.serverIp;
  let expectedName = config.serverName;
  let explicitTarget = false;

  if (serverOverride) {
    explicitTarget = true;
    if (validIPv4(serverOverride)) {
      expectedIp = serverOverride;
      expectedName = null;
    } else {
      expectedName = serverOverride;
      expectedIp = null;
    }
  }

  let dnsAddresses = null;
  try {
    dnsAddresses = await dnsImpl.resolve4(config.host);
  } catch (error) {
    if (!expectedIp) {
      warn(`Warning: unable to resolve ${config.host}: ${error.message}; using the server name`);
    } else {
      warn(`Warning: unable to resolve ${config.host}; using TILE_SERVER_IP ${expectedIp}`);
    }
  }

  if (!expectedIp && !explicitTarget && Array.isArray(dnsAddresses) && dnsAddresses.length > 0) {
    expectedIp = dnsAddresses[0];
  }

  if (
    !explicitTarget &&
    expectedIp &&
    Array.isArray(dnsAddresses) &&
    dnsAddresses.length > 0 &&
    !dnsAddresses.includes(expectedIp)
  ) {
    throw new ProvisionError(
      `DNS for ${config.host} (${dnsAddresses.join(', ')}) does not include ${expectedIp}`,
    );
  }

  if (!expectedIp && !expectedName) {
    throw new ProvisionError('No server IP or name is configured');
  }

  let server = expectedIp ? await client.findServerByIPv4(expectedIp) : null;
  if (!server && expectedName) {
    server = await client.findServerByName(expectedName);
  }

  if (!server) {
    throw new ProvisionError(
      expectedIp
        ? `No Hetzner Cloud server found for ${expectedIp}`
        : `No Hetzner Cloud server named "${expectedName}"`,
    );
  }

  const ipv4 = serverIPv4(server);
  if (requireIPv4 && !ipv4) {
    throw new ProvisionError(
      `Server ${server.name} (#${server.id}) has no public IPv4 address; refusing to rebuild`,
    );
  }

  if (expectedIp && ipv4 !== expectedIp) {
    throw new ProvisionError(
      `Server ${server.name} has IPv4 ${ipv4 ?? 'none'}, expected ${expectedIp}`,
    );
  }

  if (expectedName && server.name !== expectedName) {
    throw new ProvisionError(
      `Server ${server.id} is named "${server.name}", expected "${expectedName}"`,
    );
  }

  if (verify && server.server_type?.name !== config.serverType) {
    throw new ProvisionError(
      `Server ${server.name} is a ${server.server_type?.name ?? 'unknown type'}, expected ${config.serverType}`,
    );
  }

  if (verify) {
    const architecture = server.server_type?.architecture;
    if (architecture !== undefined && architecture !== null && architecture !== 'x86') {
      throw new ProvisionError(
        `Server ${server.name} is ${architecture}, but only x86 is supported`,
      );
    }

    if (
      (architecture === undefined || architecture === null) &&
      ARM_SERVER_TYPE_PATTERN.test(server.server_type?.name ?? '')
    ) {
      throw new ProvisionError(
        `Server ${server.name} is an ARM server type, but only x86 is supported`,
      );
    }

    if (config.location) {
      const location = server.datacenter?.location?.name;
      if (location !== config.location) {
        throw new ProvisionError(
          `Server ${server.name} is in ${location ?? 'an unknown location'}, expected ${config.location}`,
        );
      }
    }
  }

  return { server, expectedIp: ipv4 ?? expectedIp };
}

async function waitForActionIfPresent(client, action, options = {}) {
  if (!action?.id) {
    return null;
  }

  return client.waitForAction(action.id, options);
}

async function forgetKnownHost(execImpl, host, { env, timeoutMs }) {
  try {
    await runBounded(
      execImpl,
      'ssh-keygen',
      ['-R', host],
      { encoding: 'utf8', env },
      timeoutMs,
      `ssh-keygen -R ${host}`,
    );
  } catch {
    // An entry that does not exist is normal after a first provision.
  }
}

function sshArguments(privateKeyPath, ip) {
  return [
    '-i',
    privateKeyPath,
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=5',
    '-o',
    'ServerAliveInterval=15',
    '-o',
    'ServerAliveCountMax=4',
    `root@${ip}`,
  ];
}

async function waitForSsh({
  ip,
  privateKeyPath,
  execImpl,
  sleep,
  now,
  timeoutMs,
  intervalMs,
  env,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
}) {
  const deadline = now() + timeoutMs;
  const args = [...sshArguments(privateKeyPath, ip), 'true'];
  let lastError = null;

  for (;;) {
    try {
      await runBounded(
        execImpl,
        'ssh',
        args,
        { encoding: 'utf8', env },
        commandTimeoutMs,
        'SSH connection check',
      );
      return;
    } catch (error) {
      lastError = error;
    }

    if (now() >= deadline) {
      throw new ProvisionError(
        `SSH did not become available at ${ip} within ${timeoutMs}ms: ${
          lastError?.message ?? 'connection failed'
        }`,
        { cause: lastError ?? undefined },
      );
    }

    await sleep(intervalMs);
  }
}

function assertRebuildRetainedIdentity(before, after, expectedIp, config) {
  if (after?.id !== before.id) {
    throw new ProvisionError(
      `Rebuild changed the server id (${before.id} -> ${after?.id ?? 'none'})`,
    );
  }

  if (serverIPv4(after) !== expectedIp) {
    throw new ProvisionError(
      `Rebuild changed the IPv4 address (${expectedIp} -> ${serverIPv4(after) ?? 'none'})`,
    );
  }

  if (serverIPv6(after) !== serverIPv6(before)) {
    throw new ProvisionError(
      `Rebuild changed the IPv6 address (${serverIPv6(before) ?? 'none'} -> ${
        serverIPv6(after) ?? 'none'
      })`,
    );
  }

  if (after.server_type?.name !== before.server_type?.name) {
    throw new ProvisionError(
      `Rebuild changed the server type (${before.server_type?.name} -> ${
        after.server_type?.name ?? 'none'
      })`,
    );
  }

  if (after.image?.name !== config.image) {
    throw new ProvisionError(
      `Rebuild produced image ${after.image?.name ?? 'none'}, expected ${config.image}`,
    );
  }
}

function parseOsRelease(contents) {
  const fields = {};
  for (const line of String(contents).split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (match) {
      fields[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
    }
  }

  return fields;
}

export function provisionRunOptions(options = {}) {
  return {
    dryRun: options.yes !== true,
    yes: options.yes === true,
    snapshot: options.snapshot,
    noSnapshot: options.noSnapshot === true,
    server: options.server,
    host: options.host,
  };
}

function assertDistinctPublicKeys(deployPublicKey, buildPublicKey) {
  if (publicKeyMaterial(deployPublicKey) === publicKeyMaterial(buildPublicKey)) {
    throw new ProvisionError(
      'DEPLOY_USER and BUILD_USER must use different SSH key material; ' +
        'the deploy and build public keys are identical',
    );
  }
}

function createProtectionRestorer({ client, serverId, previousProtection, actionOptions }) {
  let restorePromise = null;

  return {
    restore() {
      if (restorePromise === null) {
        restorePromise = (async () => {
          const action = await client.changeProtection(serverId, previousProtection);
          await waitForActionIfPresent(client, action, actionOptions);
        })();
      }

      return restorePromise;
    },
  };
}

function settleWithin(promise, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    timer.unref?.();

    Promise.resolve(promise).then(
      () => finish({ kind: 'restored' }),
      (error) => finish({ kind: 'error', error }),
    );
  });
}

export function installProtectionSignalGuard({
  restore,
  err = process.stderr,
  processImpl = process,
  timeoutMs = 30_000,
  signals = ['SIGINT', 'SIGTERM'],
} = {}) {
  let receivedSignal = null;
  let disposed = false;
  const handlers = new Map();

  const exitCode = (signal) => (signal === 'SIGTERM' ? 143 : 130);

  const onSignal = (signal) => {
    if (receivedSignal) {
      return;
    }

    receivedSignal = signal;
    err.write(`Received ${signal}; restoring protection before exit\n`);

    settleWithin(
      Promise.resolve().then(() => restore()),
      timeoutMs,
    ).then((outcome) => {
      if (outcome.kind === 'error') {
        err.write(
          `Warning: unable to restore protection after ${signal}: ${outcome.error.message}\n`,
        );
      } else if (outcome.kind === 'timeout') {
        err.write(
          `Warning: protection restore after ${signal} did not finish within ${timeoutMs}ms; ` +
            'check the server\n',
        );
      } else {
        err.write('Restored protection before exit\n');
      }

      processImpl.exit(exitCode(signal));
    });
  };

  for (const signal of signals) {
    const handler = () => onSignal(signal);
    handlers.set(signal, handler);
    processImpl.on(signal, handler);
  }

  return {
    received() {
      return receivedSignal;
    },
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      for (const [signal, handler] of handlers) {
        processImpl.removeListener?.(signal, handler);
      }
    },
  };
}

function isTimeoutFailure(error) {
  return (
    error?.name === 'AbortError' ||
    /\btimed out\b/i.test(String(error?.message ?? '')) ||
    error?.code === 'ETIMEDOUT'
  );
}

async function describeRebuildState({ client, serverId }) {
  const details = [];

  try {
    const actions = await client.listServerActions(serverId);
    const rebuilds = actions.filter((action) => /rebuild/i.test(String(action.command ?? '')));

    if (rebuilds.length === 0) {
      details.push('no rebuild action is visible yet');
    } else {
      details.push(
        `recent rebuild actions: ${rebuilds
          .slice(0, 3)
          .map(
            (action) =>
              `${action.command}${action.status ? ` (${action.status})` : ''}${
                action.id ? ` #${action.id}` : ''
              }`,
          )
          .join(', ')}`,
      );
    }
  } catch (error) {
    details.push(`unable to list server actions (${error.message})`);
  }

  try {
    const current = await client.getServer(serverId);
    details.push(`server status: ${current?.status ?? 'unknown'}`);
  } catch (error) {
    details.push(`unable to read server state (${error.message})`);
  }

  return details.join('; ');
}

function planLines({
  config,
  server,
  expectedIp,
  image,
  cloudInitBytes,
  deployKeys,
  buildKeys,
  snapshotPlanned,
  snapshotReason,
}) {
  const paths = cloudInitPaths(config.host);
  const protection = server.protection ?? {};

  return [
    'ogis provision — dry run',
    '',
    `Server: ${serverLabel(server)}`,
    `Host: ${config.host} (${expectedIp})`,
    `Image: ${config.image} (#${image.id ?? 'unknown'})`,
    `Protection: delete=${Boolean(protection.delete)} rebuild=${Boolean(protection.rebuild)}`,
    `Rescue: ${server.rescue_enabled ? 'enabled' : 'disabled'}; ISO: ${
      server.iso ? server.iso.name : 'none'
    }`,
    `Snapshot before rebuild: ${
      snapshotPlanned ? `yes (${snapshotReason}; a real run would snapshot)` : 'no (--no-snapshot)'
    }`,
    `Snapshot during this dry run: no (a dry run makes no changes)`,
    '',
    `Cloud-init: ${cloudInitBytes} bytes (limit ${MAX_CLOUD_CONFIG_BYTES})`,
    `Deploy keys: ${deployKeys.length}; build keys: ${buildKeys.length}`,
    `Node: ${NODE_VERSION} (${NODE_TARBALL_URL})`,
    `Node SHA-256: ${NODE_SHA256}`,
    `App: ${paths.repoDir}; data: ${paths.dataDir}; incoming: ${paths.incomingDir}`,
    `Service: ${paths.serviceFile} (User=${config.deployUser}, PORT=${config.port})`,
    `Nginx: ${paths.nginxSiteFile} for ${config.host}`,
    '',
    'No changes were made. Run with --yes to perform the rebuild.',
  ];
}

export async function runProvision({
  config,
  client,
  options = {},
  dnsImpl = dns.promises,
  fsImpl = defaultFs,
  execImpl = runCommand,
  env = process.env,
  out = process.stdout,
  err = process.stderr,
  processImpl = process,
  sleep = defaultSleep,
  now = () => Date.now(),
} = {}) {
  if (!config) {
    throw new ProvisionError('Provisioning configuration is required');
  }

  if (!client) {
    throw new ProvisionError('A Hetzner Cloud client is required');
  }

  if (options.snapshot && options.noSnapshot) {
    throw new ProvisionError('--snapshot and --no-snapshot cannot be used together');
  }

  const dryRun = options.dryRun ?? !options.yes;
  if (!dryRun && options.yes !== true) {
    throw new ProvisionError('A real rebuild requires --yes');
  }

  const snapshotPlanned = options.noSnapshot !== true && options.snapshot !== false;
  const snapshot = !dryRun && snapshotPlanned;
  const snapshotReason =
    options.snapshot === true
      ? '--snapshot'
      : options.noSnapshot === true
        ? '--no-snapshot'
        : 'default';
  const host = options.host ? String(options.host).trim() : config.host;
  if (!validHostname(host)) {
    throw new ProvisionError(`--host "${options.host}" is not a valid hostname`);
  }

  const effectiveConfig = { ...config, host };
  const commandEnv = childEnvironment(env);
  const commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const actionOptions = {
    timeoutMs: options.actionTimeoutMs ?? 900_000,
    intervalMs: options.actionIntervalMs ?? 5_000,
  };
  const log = (line = '') => out.write(`${line}\n`);
  const warn = (line) => out.write(`${line}\n`);

  const deployPublicKey = await resolvePublicKey({
    privateKeyPath: config.deployPrivateKeyPath,
    publicKeyPath: config.deployPublicKeyPath,
    label: 'Deploy',
    fsImpl,
    execImpl,
    env,
    timeoutMs: commandTimeoutMs,
  });
  const buildPublicKey = await resolvePublicKey({
    privateKeyPath: config.buildPrivateKeyPath,
    publicKeyPath: config.buildPublicKeyPath,
    label: 'Build',
    fsImpl,
    execImpl,
    env,
    timeoutMs: commandTimeoutMs,
  });

  assertDistinctPublicKeys(deployPublicKey, buildPublicKey);

  const cloudInit = renderCloudInit({
    host,
    deployKeys: [deployPublicKey],
    buildKeys: [buildPublicKey],
    deployUser: config.deployUser,
    buildUser: config.buildUser,
    serverPort: config.port,
  });
  const cloudInitBytes = Buffer.byteLength(cloudInit, 'utf8');

  const { server, expectedIp } = await resolveTarget({
    client,
    config: effectiveConfig,
    dnsImpl,
    serverOverride: options.server,
    warn,
  });

  const image = await client.findImageByName(config.image, 'x86');
  if (!image) {
    throw new ProvisionError(`No available x86 system image named "${config.image}"`);
  }

  if (image.architecture !== undefined && image.architecture !== 'x86') {
    throw new ProvisionError(
      `Image "${config.image}" is ${image.architecture}, but only x86 is supported`,
    );
  }

  const runningActions = await client.listServerActions(server.id, { status: 'running' });
  const protection = server.protection ?? {};

  if (dryRun) {
    for (const line of planLines({
      config: effectiveConfig,
      server,
      expectedIp,
      image,
      cloudInitBytes,
      deployKeys: [deployPublicKey],
      buildKeys: [buildPublicKey],
      snapshotPlanned,
      snapshotReason,
    })) {
      log(line);
    }

    if (runningActions.length > 0) {
      log(`\nPending actions would be awaited first: ${runningActions.length}`);
    }

    return {
      dryRun: true,
      server,
      image,
      expectedIp,
      cloudInitBytes,
      snapshot,
      snapshotPlanned,
      protection,
    };
  }

  log(`Hetzner Cloud server: ${serverLabel(server)}`);
  log(`Image: ${config.image} (#${image.id ?? 'unknown'})`);
  log(`Host: ${host} -> ${expectedIp}`);
  log(`Cloud-init: ${cloudInitBytes} bytes for deploy user "${config.deployUser}"`);
  log(`Node: ${NODE_VERSION} sha256 ${NODE_SHA256}`);

  if (options.yes !== true) {
    throw new ProvisionError('A real rebuild requires --yes');
  }

  for (const action of runningActions) {
    await waitForActionIfPresent(client, action, actionOptions);
  }

  if (server.rescue_enabled) {
    log('Disabling rescue mode');
    const action = await client.disableRescue(server.id);
    await waitForActionIfPresent(client, action, actionOptions);
  }

  if (server.iso) {
    log('Detaching ISO');
    const action = await client.detachIso(server.id);
    await waitForActionIfPresent(client, action, actionOptions);
  }

  const previousProtection = {
    delete: Boolean(protection.delete),
    rebuild: Boolean(protection.rebuild),
  };
  let protectionDisabled = false;
  let protectionRestorer = null;
  let signalGuard = null;
  let completion = null;
  let primaryError = null;

  try {
    if (protection.rebuild) {
      protectionRestorer = createProtectionRestorer({
        client,
        serverId: server.id,
        previousProtection,
        actionOptions,
      });
      signalGuard = installProtectionSignalGuard({
        restore: () => protectionRestorer.restore(),
        err,
        processImpl,
        timeoutMs: options.signalRestoreTimeoutMs ?? 30_000,
      });

      if (protection.delete) {
        log('Disabling both rebuild and delete protection (Hetzner requires matching values)');
      } else {
        log('Disabling rebuild protection');
      }

      protectionDisabled = true;
      const action = await client.changeProtection(server.id, { delete: false, rebuild: false });
      await waitForActionIfPresent(client, action, actionOptions);
    }

    if (snapshot) {
      const description = `pre-rebuild ${new Date(now()).toISOString()}`;
      log(`Creating snapshot: ${description}`);
      const { action } = await client.createSnapshot(server.id, description);
      await waitForActionIfPresent(client, action, actionOptions);
    }

    log(`Rebuilding ${server.name} with ${config.image} and cloud-init`);
    let rebuildAction;
    try {
      rebuildAction = await client.rebuildServer(server.id, {
        image: image.id,
        userData: cloudInit,
      });
    } catch (error) {
      if (!isTimeoutFailure(error)) {
        throw error;
      }

      const state = await describeRebuildState({ client, serverId: server.id });
      const message =
        'The rebuild request timed out, so the server state is unknown, check the server ' +
        `before retrying (${state})`;
      err.write(`Warning: ${message}\n`);
      throw new ProvisionError(message, { cause: error });
    }

    if (!rebuildAction?.id) {
      throw new ProvisionError('The rebuild request did not return an action');
    }

    await client.waitForAction(rebuildAction.id, actionOptions);

    const rebuilt = await client.getServer(server.id);
    if (!rebuilt) {
      throw new ProvisionError(`Server ${server.id} disappeared after the rebuild`);
    }

    assertRebuildRetainedIdentity(server, rebuilt, expectedIp, config);
    log(`Rebuild retained ${rebuilt.name} (#${rebuilt.id}, ${expectedIp})`);

    for (const knownHost of [...new Set([host, expectedIp])]) {
      await forgetKnownHost(execImpl, knownHost, {
        env: commandEnv,
        timeoutMs: commandTimeoutMs,
      });
    }

    log(`Waiting for SSH at ${expectedIp}`);
    await waitForSsh({
      ip: expectedIp,
      privateKeyPath: config.deployPrivateKeyPath,
      execImpl,
      sleep,
      now,
      timeoutMs: options.sshTimeoutMs ?? 600_000,
      intervalMs: options.sshIntervalMs ?? 5_000,
      env: commandEnv,
      commandTimeoutMs,
    });

    const sshBase = sshArguments(config.deployPrivateKeyPath, expectedIp);
    log('Waiting for cloud-init to finish');
    await runBounded(
      execImpl,
      'ssh',
      [...sshBase, 'cloud-init status --wait'],
      { encoding: 'utf8', env: commandEnv },
      options.cloudInitTimeoutMs ?? DEFAULT_CLOUD_INIT_TIMEOUT_MS,
      'cloud-init status --wait',
    );

    const { stdout } = await runBounded(
      execImpl,
      'ssh',
      [...sshBase, 'cat /etc/os-release'],
      { encoding: 'utf8', env: commandEnv },
      commandTimeoutMs,
      'cat /etc/os-release',
    );
    const osRelease = parseOsRelease(stdout);
    if (osRelease.ID !== 'ubuntu' || !/^26\.04(?:\.|$)/.test(osRelease.VERSION_ID ?? '')) {
      throw new ProvisionError(
        `Rebuilt server reports ${osRelease.PRETTY_NAME ?? 'an unknown OS'}, expected Ubuntu 26.04`,
      );
    }

    log('Enabling fail2ban now that SSH is verified');
    await runBounded(
      execImpl,
      'ssh',
      [...sshBase, FAIL2BAN_ENABLE_COMMAND],
      { encoding: 'utf8', env: commandEnv },
      options.fail2banTimeoutMs ?? 300_000,
      'fail2ban setup',
    );

    completion = {
      dryRun: false,
      server: rebuilt,
      image,
      expectedIp,
      cloudInitBytes,
      snapshot,
      osRelease,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    signalGuard?.dispose();

    if (protectionDisabled && protectionRestorer) {
      try {
        await protectionRestorer.restore();
        log(
          `Restored protection: delete=${previousProtection.delete} rebuild=${previousProtection.rebuild}`,
        );
      } catch (error) {
        const message =
          `Unable to restore protection (delete=${previousProtection.delete}, ` +
          `rebuild=${previousProtection.rebuild}): ${error.message}. ` +
          'The server may be left unprotected; check it before retrying.';

        err.write(`${primaryError ? 'Warning' : 'Error'}: ${message}\n`);

        if (!primaryError) {
          primaryError = new ProvisionError(message, { cause: error });
        }
      }
    }
  }

  if (primaryError) {
    throw primaryError;
  }

  log(
    `Provisioned ${completion.server.name} (#${completion.server.id}) on Ubuntu ${completion.osRelease.VERSION_ID}`,
  );

  return completion;
}

export async function runStatus({
  config,
  client,
  options = {},
  dnsImpl = dns.promises,
  out = process.stdout,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5_000,
} = {}) {
  if (!config) {
    throw new ProvisionError('Provisioning configuration is required');
  }

  if (!client) {
    throw new ProvisionError('A Hetzner Cloud client is required');
  }

  const host = options.host ? String(options.host).trim() : config.host;
  if (!validHostname(host)) {
    throw new ProvisionError(`--host "${options.host}" is not a valid hostname`);
  }

  const effectiveConfig = { ...config, host };
  const { server, expectedIp } = await resolveTarget({
    client,
    config: effectiveConfig,
    dnsImpl,
    serverOverride: options.server,
    verify: false,
    requireIPv4: false,
  });

  const protection = server.protection ?? {};
  const log = (line = '') => out.write(`${line}\n`);

  log(`Server: ${server.name} (#${server.id})`);
  log(`IPv4: ${serverIPv4(server) ?? 'none'}`);
  log(`IPv6: ${serverIPv6(server) ?? 'none'}`);
  log(`Type: ${server.server_type?.name ?? 'unknown'}`);
  log(`Location: ${server.datacenter?.location?.name ?? 'unknown'}`);
  log(`Status: ${server.status ?? 'unknown'}`);
  log(`Image: ${server.image?.name ?? 'none'}`);
  log(`Protection: delete=${Boolean(protection.delete)} rebuild=${Boolean(protection.rebuild)}`);

  let health = null;
  let ready = null;

  if (options.health !== false) {
    const check = async (pathname, label) => {
      const url = `https://${host}${pathname}`;

      try {
        const response = await fetchImpl(url, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: { Accept: 'application/json' },
        });
        log(`${label}: ${url} -> HTTP ${response.status}`);
        return { url, status: response.status, ok: response.ok };
      } catch (error) {
        const result = { url, status: null, ok: false, error: error?.message ?? 'request failed' };
        log(`${label}: ${url} -> ${result.error}`);
        return result;
      }
    };

    health = await check('/health', 'Health');
    ready = await check('/ready', 'Ready');
  }

  return { server, expectedIp, health, ready };
}
