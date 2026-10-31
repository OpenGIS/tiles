// Renders the cloud-config for a remote build box.
//
// The build box is disposable: it receives the repository over rsync, runs the Phase 4 build
// pipeline, and writes archives to the tile server with the restricted build key. Cloud-init must
// therefore install the pinned toolchain without any secret material. The deploy public key is the
// only credential it contains.

import path from 'node:path';

import { shellQuote } from '../deploy/ssh.mjs';
import {
  MAX_CLOUD_CONFIG_BYTES,
  NODE_SHA256,
  NODE_TARBALL_URL,
  NODE_VERSION,
} from '../provision/cloud-init.mjs';

export const PMTILES_VERSION = '1.31.2';

const PMTILES_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/;

const PMTILES_SHA256_BY_VERSION = Object.freeze({
  '1.31.2': '3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f',
});

export function pmtilesTarballUrl(version) {
  return (
    `https://github.com/protomaps/go-pmtiles/releases/download/v${version}/` +
    `go-pmtiles_${version}_Linux_x86_64.tar.gz`
  );
}

export function resolvePmtilesRelease(version = PMTILES_VERSION) {
  const requested = String(version ?? '');

  if (
    !PMTILES_VERSION_PATTERN.test(requested) ||
    !Object.hasOwn(PMTILES_SHA256_BY_VERSION, requested)
  ) {
    throw new BuildCloudInitError(`pmtiles ${version} is not a pinned build-box release`);
  }

  return {
    version: requested,
    url: pmtilesTarballUrl(requested),
    sha256: PMTILES_SHA256_BY_VERSION[requested],
  };
}

export const PMTILES_TARBALL_URL = pmtilesTarballUrl(PMTILES_VERSION);
export const PMTILES_SHA256 = PMTILES_SHA256_BY_VERSION[PMTILES_VERSION];
export const BUILD_BOX_APP_DIR = '/opt/ogis-tiles';

const USERNAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const APP_DIR_PATTERN = /^\/[^\0\r\n]*$/;
const PUBLIC_KEY_PATTERN =
  /^(?:ssh-|ecdsa-|sk-)[A-Za-z0-9@._-]+ [A-Za-z0-9+/]+={0,3}(?: [^\r\n]*)?$/;

export class BuildCloudInitError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'BuildCloudInitError';
  }
}

function requireUsername(value) {
  const user = String(value ?? '').trim();
  if (!USERNAME_PATTERN.test(user)) {
    throw new BuildCloudInitError(`"${value}" is not a valid Linux user name`);
  }

  if (user === 'root') {
    throw new BuildCloudInitError('The build box user must not be root');
  }

  return user;
}

function normalisePublicKey(value) {
  const key = String(value ?? '').trim();

  if (/PRIVATE KEY/.test(key)) {
    throw new BuildCloudInitError(
      'The build box cloud-init contains private key material; a public key is required',
    );
  }

  if (/^sk-/i.test(key)) {
    throw new BuildCloudInitError(
      'The build box cloud-init needs a standard SSH public key, not a hardware-backed key',
    );
  }

  if (key.split(/\r?\n/).length !== 1 || !PUBLIC_KEY_PATTERN.test(key)) {
    throw new BuildCloudInitError('The build box cloud-init public key is not valid');
  }

  return key;
}

function requireAppDir(value) {
  const directory = String(value ?? '').trim();
  const normalised = path.posix.normalize(directory);

  if (
    !APP_DIR_PATTERN.test(directory) ||
    normalised === '/' ||
    directory.split('/').includes('..') ||
    normalised.split('/').includes('..')
  ) {
    throw new BuildCloudInitError(`"${value}" is not a safe absolute build box directory`);
  }

  return normalised;
}

function normaliseKeys(values) {
  const list = Array.isArray(values) ? values : [values];
  const keys = list.filter((value) => value !== undefined && value !== null && value !== '');
  if (keys.length === 0) {
    throw new BuildCloudInitError(
      'At least one deploy SSH public key is required for the build box',
    );
  }

  return [...new Set(keys.map((key) => normalisePublicKey(key)))];
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function pushUser(lines, { name, keys }) {
  lines.push(`  - name: ${name}`);
  lines.push(`    gecos: ${yamlString('ogis-tiles build box')}`);
  lines.push('    shell: /bin/bash');
  lines.push('    lock_passwd: true');
  lines.push('    ssh_authorized_keys:');
  for (const key of keys) {
    lines.push(`      - ${yamlString(key)}`);
  }
}

function pushFile(lines, { path, permissions = '0644', owner = 'root:root', content }) {
  lines.push(`  - path: ${path}`);
  lines.push(`    permissions: '${permissions}'`);
  lines.push(`    owner: ${owner}`);
  lines.push('    content: |');
  for (const line of String(content).replace(/\n$/, '').split('\n')) {
    lines.push(line === '' ? '' : `      ${line}`);
  }
}

function pushRuncmd(lines, command) {
  lines.push(`  - ${yamlString(command)}`);
}

function sshdConfig() {
  return [
    '# Managed by ogis-tiles remote builds.',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'ChallengeResponseAuthentication no',
    'PermitRootLogin prohibit-password',
    'PubkeyAuthentication yes',
    'UsePAM yes',
    '',
  ].join('\n');
}

export function renderBuildBoxCloudInit({
  deployKeys,
  deployUser = 'deploy',
  nodeVersion = NODE_VERSION,
  nodeUrl = NODE_TARBALL_URL,
  nodeSha256 = NODE_SHA256,
  pmtilesVersion = PMTILES_VERSION,
  pmtilesUrl,
  pmtilesSha256,
  appDir = BUILD_BOX_APP_DIR,
} = {}) {
  const user = requireUsername(deployUser);
  const keys = normaliseKeys(deployKeys);
  const directory = requireAppDir(appDir);
  const release = resolvePmtilesRelease(pmtilesVersion);
  const resolvedPmtilesUrl = pmtilesUrl ?? release.url;
  const resolvedPmtilesSha256 = pmtilesSha256 ?? release.sha256;
  const nodeFile = `/var/tmp/node-${nodeVersion}-linux-x64.tar.xz`;
  const pmtilesFile = `/var/tmp/pmtiles-${pmtilesVersion}-linux-x64.tar.gz`;

  const lines = [];
  lines.push('#cloud-config');
  lines.push('# Managed by ogis-tiles remote builds. Do not edit on the build box.');
  lines.push(`# Node.js ${nodeVersion} is pinned to ${nodeSha256}.`);
  lines.push(`# pmtiles ${pmtilesVersion} is pinned to ${resolvedPmtilesSha256}.`);
  lines.push('');
  lines.push('package_update: true');
  lines.push('package_upgrade: true');
  lines.push('timezone: UTC');
  lines.push('ssh_pwauth: false');
  lines.push('disable_root: false');
  lines.push('');
  lines.push('packages:');
  for (const name of [
    'ca-certificates',
    'curl',
    'openjdk-21-jre-headless',
    'osmium-tool',
    'rsync',
    'tar',
    'ufw',
    'xz-utils',
  ]) {
    lines.push(`  - ${name}`);
  }
  lines.push('');
  lines.push('users:');
  pushUser(lines, { name: 'root', keys });
  pushUser(lines, { name: user, keys });
  lines.push('');
  lines.push('write_files:');
  pushFile(lines, {
    path: '/etc/ssh/sshd_config.d/99-ogis-hardening.conf',
    content: sshdConfig(),
  });
  lines.push('');
  lines.push('runcmd:');
  for (const command of [
    `install -d -m 0750 ${shellQuote(directory)}`,
    `chown ${user}:${user} ${shellQuote(directory)}`,
    `install -d -m 0700 -o ${user} -g ${user} ${shellQuote(path.posix.join(directory, 'tmp'))}`,
    `install -d -m 0700 -o ${user} -g ${user} /home/${user}/.ssh`,
    `curl -fsSLo ${nodeFile} ${nodeUrl}`,
    `echo ${yamlString(`${nodeSha256}  ${nodeFile}`)} | sha256sum -c -`,
    `tar -xJf ${nodeFile} -C /usr/local --strip-components=1 --no-same-owner`,
    `rm -f ${nodeFile}`,
    `/usr/local/bin/node --version`,
    `curl -fsSLo ${pmtilesFile} ${resolvedPmtilesUrl}`,
    `echo ${yamlString(`${resolvedPmtilesSha256}  ${pmtilesFile}`)} | sha256sum -c -`,
    `tar -xzf ${pmtilesFile} -C /usr/local/bin pmtiles`,
    `chmod 0755 /usr/local/bin/pmtiles`,
    `rm -f ${pmtilesFile}`,
    '/usr/local/bin/pmtiles version',
    'java -version',
    'osmium --version',
    'rsync --version',
    'sshd -t',
    'systemctl reload ssh',
    'ufw default deny incoming',
    'ufw default allow outgoing',
    'ufw allow 22/tcp',
    'ufw --force enable',
    'timedatectl set-timezone UTC',
  ]) {
    pushRuncmd(lines, command);
  }

  const rendered = `${lines.join('\n')}\n`;
  const bytes = Buffer.byteLength(rendered, 'utf8');
  if (bytes > MAX_CLOUD_CONFIG_BYTES) {
    throw new BuildCloudInitError(
      `Rendered build cloud-config is ${bytes} bytes; the limit is ${MAX_CLOUD_CONFIG_BYTES} bytes`,
    );
  }

  return rendered;
}
