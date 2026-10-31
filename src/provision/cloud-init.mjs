// Renders the cloud-config used when the tile server is rebuilt.
//
// The renderer is a plain string builder so provisioning has no YAML dependency. It is deliberately
// strict: hostnames, user names and public keys are validated before they reach the server, and the
// finished document must stay below Hetzner's 32 KiB user_data limit.

export const MAX_CLOUD_CONFIG_BYTES = 32 * 1024;

// Node.js 24.x LTS, pinned to the official Linux x64 tarball.
export const NODE_VERSION = 'v24.22.2';
export const NODE_TARBALL_URL = `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz`;
export const NODE_SHA256 = '48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75';

export const RRSYNC_SOURCES = Object.freeze(['/usr/bin/rrsync', '/usr/share/rsync/scripts/rrsync']);
export const RRSYNC_SOURCE = RRSYNC_SOURCES[1];
export const RRSYNC_TARGET = '/usr/local/bin/rrsync';
export const SERVICE_NAME = 'ogis-tiles.service';

const NODE_VERSION_PATTERN = /^v\d+\.\d+\.\d+$/;
const NODE_SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SERVICE_NAME_PATTERN = /^[A-Za-z0-9_.@-]+\.service$/;
const NODE_URL_PATTERN = /^https:\/\/[^\s'"`$;&|<>()\\]+$/;

const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
const USERNAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const PUBLIC_KEY_PATTERN =
  /^(?:ssh-|ecdsa-|sk-)[A-Za-z0-9@._-]+ [A-Za-z0-9+/]+={0,3}(?: [^\r\n]*)?$/;

export class CloudInitError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'CloudInitError';
  }
}

export function cloudInitPaths(host = 'tile.ogis.app') {
  return {
    repoDir: '/opt/ogis-tiles',
    dataDir: '/opt/ogis-tiles/data',
    incomingDir: '/opt/ogis-tiles/data/incoming',
    certbotWebroot: '/var/www/certbot',
    nodeBin: '/usr/local/bin/node',
    serviceFile: `/etc/systemd/system/${SERVICE_NAME}`,
    nginxSiteFile: `/etc/nginx/sites-available/${host}`,
    nginxEnabledFile: `/etc/nginx/sites-enabled/${host}`,
  };
}

export const DEFAULT_PATHS = Object.freeze(cloudInitPaths());

function requireHostname(value) {
  const host = String(value ?? '').trim();
  if (!HOSTNAME_PATTERN.test(host)) {
    throw new CloudInitError(`"${value}" is not a valid hostname`);
  }

  return host;
}

function requireUsername(value, label) {
  const user = String(value ?? '').trim();
  if (!USERNAME_PATTERN.test(user)) {
    throw new CloudInitError(`${label} "${value}" is not a valid Linux user name`);
  }

  return user;
}

function normalisePublicKey(value, label) {
  const key = String(value ?? '').trim();

  if (/PRIVATE KEY/.test(key)) {
    throw new CloudInitError(`${label} looks like private key material; a public key is required`);
  }

  if (/^sk-/i.test(key)) {
    throw new CloudInitError(
      `${label} is a hardware-backed (sk-) key; provisioning needs a standard SSH public key`,
    );
  }

  if (key.split(/\r?\n/).length !== 1) {
    throw new CloudInitError(`${label} must be a single-line SSH public key`);
  }

  if (!PUBLIC_KEY_PATTERN.test(key)) {
    throw new CloudInitError(`${label} is not a valid SSH public key`);
  }

  return key;
}

function normaliseKeys(values, label) {
  const list = Array.isArray(values) ? values : [values];
  const keys = list.filter((value) => value !== undefined && value !== null && value !== '');
  if (keys.length === 0) {
    throw new CloudInitError(`At least one ${label} SSH public key is required`);
  }

  return [...new Set(keys.map((value) => normalisePublicKey(value, label)))];
}

function requireNodeVersion(value) {
  const version = String(value ?? '').trim();
  if (!NODE_VERSION_PATTERN.test(version)) {
    throw new CloudInitError(`"${value}" is not a valid Node.js version`);
  }

  return version;
}

function requireNodeUrl(value) {
  const url = String(value ?? '').trim();
  if (!NODE_URL_PATTERN.test(url)) {
    throw new CloudInitError(`"${value}" is not a valid HTTPS Node.js tarball URL`);
  }

  return url;
}

function requireNodeSha256(value) {
  const sha256 = String(value ?? '').trim();
  if (!NODE_SHA256_PATTERN.test(sha256)) {
    throw new CloudInitError(`"${value}" is not a valid SHA-256 checksum`);
  }

  return sha256;
}

function requireServiceName(value) {
  const name = String(value ?? '').trim();
  if (!SERVICE_NAME_PATTERN.test(name)) {
    throw new CloudInitError(`"${value}" is not a valid systemd service name`);
  }

  return name;
}

function requireServerPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
    throw new CloudInitError(`"${value}" must be an unprivileged port between 1024 and 65535`);
  }

  return port;
}

export function rrsyncSetupScript() {
  const [primary, fallback] = RRSYNC_SOURCES;

  return [
    `if [ -x ${primary} ]; then`,
    `  ln -sfn ${primary} ${RRSYNC_TARGET}`,
    `elif [ -x ${fallback} ]; then`,
    `  ln -sfn ${fallback} ${RRSYNC_TARGET}`,
    'else',
    '  echo "rrsync not found; build uploads will fail" >&2',
    'fi',
  ].join('\n');
}

function yamlString(value) {
  return JSON.stringify(String(value));
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

function pushUser(lines, { name, groups, sudo, keys, gecos }) {
  lines.push(`  - name: ${name}`);
  lines.push(`    gecos: ${yamlString(gecos)}`);
  lines.push('    shell: /bin/bash');
  lines.push('    lock_passwd: true');
  if (groups.length > 0) {
    lines.push(`    groups: [${groups.join(', ')}]`);
  }
  if (sudo) {
    lines.push(`    sudo: ${yamlString(sudo)}`);
  }
  if (keys.length > 0) {
    lines.push('    ssh_authorized_keys:');
    for (const key of keys) {
      lines.push(`      - ${yamlString(key)}`);
    }
  }
}

function pushRuncmd(lines, command) {
  lines.push(`  - ${yamlString(command)}`);
}

function sshdConfig() {
  return [
    '# Managed by ogis-tiles provisioning.',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'ChallengeResponseAuthentication no',
    'PermitRootLogin prohibit-password',
    'PubkeyAuthentication yes',
    'UsePAM yes',
    '',
  ].join('\n');
}

function systemdUnit({ deployUser, serverPort }) {
  return [
    '[Unit]',
    'Description=ogis-tiles tile server',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `User=${deployUser}`,
    'WorkingDirectory=/opt/ogis-tiles',
    'ExecStart=/usr/local/bin/node src/server.mjs',
    'Environment=HOST=127.0.0.1',
    `Environment=PORT=${serverPort}`,
    'Restart=always',
    'RestartSec=3',
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'ProtectSystem=strict',
    'ProtectHome=true',
    'ReadWritePaths=/opt/ogis-tiles/data',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

function nginxSite(host, serverPort) {
  return [
    '# Managed by ogis-tiles provisioning. TLS is installed by the deploy command after rebuild.',
    'server {',
    '  listen 80;',
    '  listen [::]:80;',
    `  server_name ${host};`,
    '',
    '  location /.well-known/acme-challenge/ {',
    '    root /var/www/certbot;',
    '  }',
    '',
    '  location / {',
    `    proxy_pass http://127.0.0.1:${serverPort};`,
    '    proxy_http_version 1.1;',
    '    proxy_set_header Host $host;',
    '    proxy_set_header X-Real-IP $remote_addr;',
    '    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '    proxy_set_header X-Forwarded-Proto $scheme;',
    '    proxy_read_timeout 60s;',
    '  }',
    '}',
    '',
  ].join('\n');
}

function fail2banJail() {
  return ['[sshd]', 'enabled = true', 'port = ssh', 'backend = systemd', ''].join('\n');
}

export function renderCloudInit({
  host = 'tile.ogis.app',
  deployKeys,
  buildKeys,
  deployUser = 'deploy',
  buildUser = 'build',
  nodeVersion = NODE_VERSION,
  nodeUrl = NODE_TARBALL_URL,
  nodeSha256 = NODE_SHA256,
  serverPort = 11010,
  serviceName = SERVICE_NAME,
} = {}) {
  const domain = requireHostname(host);
  const deploy = requireUsername(deployUser, 'Deploy user');
  const build = requireUsername(buildUser, 'Build user');
  if (deploy === build || deploy === 'root' || build === 'root') {
    throw new CloudInitError('Deploy and build users must be distinct non-root users');
  }

  const rootKeys = normaliseKeys(deployKeys, 'deploy');
  const buildPublicKeys = normaliseKeys(buildKeys, 'build');
  const pinnedNodeVersion = requireNodeVersion(nodeVersion);
  const pinnedNodeUrl = requireNodeUrl(nodeUrl);
  const pinnedNodeSha256 = requireNodeSha256(nodeSha256);
  const pinnedPort = requireServerPort(serverPort);
  const pinnedServiceName = requireServiceName(serviceName);

  const paths = cloudInitPaths(domain);
  const serviceFile = `/etc/systemd/system/${pinnedServiceName}`;
  const nodeFile = `/var/tmp/node-${pinnedNodeVersion}-linux-x64.tar.xz`;
  const buildAuthorizedKeys = buildPublicKeys
    .map((key) => `command="${RRSYNC_TARGET} -wo ${paths.incomingDir}",restrict ${key}`)
    .join('\n');

  const lines = [];
  lines.push('#cloud-config');
  lines.push('# Managed by ogis-tiles provisioning. Do not edit on the server.');
  lines.push(`# Node.js ${pinnedNodeVersion} is pinned to ${pinnedNodeSha256}.`);
  lines.push('');
  lines.push('package_update: true');
  lines.push('package_upgrade: true');
  lines.push('timezone: UTC');
  lines.push('ssh_pwauth: false');
  lines.push('disable_root: false');
  lines.push('');
  lines.push('packages:');
  for (const name of [
    'curl',
    'ca-certificates',
    'rsync',
    'nginx',
    'certbot',
    'python3-certbot-nginx',
    'ufw',
    'python3',
    'unzip',
    'xz-utils',
  ]) {
    lines.push(`  - ${name}`);
  }
  lines.push('');
  lines.push('groups:');
  lines.push('  - ogis');
  lines.push('');
  lines.push('users:');
  pushUser(lines, {
    name: 'root',
    gecos: 'root',
    groups: [],
    keys: rootKeys,
  });
  pushUser(lines, {
    name: deploy,
    gecos: 'ogis-tiles deployment',
    groups: ['sudo', 'ogis'],
    sudo: 'ALL=(ALL) NOPASSWD:ALL',
    keys: rootKeys,
  });
  pushUser(lines, {
    name: build,
    gecos: 'ogis-tiles build uploader',
    groups: ['ogis'],
    keys: [],
  });
  lines.push('');

  lines.push('write_files:');
  pushFile(lines, {
    path: '/etc/ssh/sshd_config.d/99-ogis-hardening.conf',
    content: sshdConfig(),
  });
  pushFile(lines, {
    path: serviceFile,
    content: systemdUnit({ deployUser: deploy, serverPort: pinnedPort }),
  });
  pushFile(lines, {
    path: paths.nginxSiteFile,
    content: nginxSite(domain, pinnedPort),
  });
  pushFile(lines, {
    path: '/etc/fail2ban/jail.d/ogis.local',
    content: fail2banJail(),
  });
  pushFile(lines, {
    path: '/opt/ogis-tiles/build-authorized-keys',
    permissions: '0600',
    content: `${buildAuthorizedKeys}\n`,
  });
  lines.push('');

  lines.push('runcmd:');
  for (const command of [
    `install -d -m 0755 ${paths.repoDir}`,
    `chown ${deploy}:${deploy} ${paths.repoDir}`,
    `install -d -m 2750 -o ${deploy} -g ogis ${paths.dataDir}`,
    `install -d -m 2770 -o ${deploy} -g ogis ${paths.incomingDir}`,
    `install -d -m 0755 ${paths.certbotWebroot}`,
    `install -d -m 0755 -o root -g root /home/${build}`,
    `install -d -m 0755 -o root -g root /home/${build}/.ssh`,
    `install -m 0644 -o root -g root /opt/ogis-tiles/build-authorized-keys /home/${build}/.ssh/authorized_keys`,
    'rm -f /opt/ogis-tiles/build-authorized-keys',
    `curl -fsSLo ${nodeFile} ${pinnedNodeUrl}`,
    `echo ${yamlString(`${pinnedNodeSha256}  ${nodeFile}`)} | sha256sum -c -`,
    `tar -xJf ${nodeFile} -C /usr/local --strip-components=1 --no-same-owner`,
    `rm -f ${nodeFile}`,
    '/usr/local/bin/node --version',
    rrsyncSetupScript(),
    'rm -f /etc/nginx/sites-enabled/default',
    `ln -sfn ${paths.nginxSiteFile} ${paths.nginxEnabledFile}`,
    'nginx -t',
    'systemctl enable --now nginx',
    'systemctl daemon-reload',
    `systemctl enable ${pinnedServiceName}`,
    'sshd -t',
    'systemctl reload ssh',
    'timedatectl set-timezone UTC',
    'ufw default deny incoming',
    'ufw default allow outgoing',
    'ufw allow 22/tcp',
    'ufw allow 80/tcp',
    'ufw allow 443/tcp',
    'ufw --force enable',
  ]) {
    pushRuncmd(lines, command);
  }

  const rendered = `${lines.join('\n')}\n`;
  const bytes = Buffer.byteLength(rendered, 'utf8');
  if (bytes > MAX_CLOUD_CONFIG_BYTES) {
    throw new CloudInitError(
      `Rendered cloud-config is ${bytes} bytes; the limit is ${MAX_CLOUD_CONFIG_BYTES} bytes`,
    );
  }

  return rendered;
}
