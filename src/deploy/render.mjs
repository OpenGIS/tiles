import { DeployError, validHostname, validUsername } from './config.mjs';

const SOURCE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const CACHE_BUDGET_GB = 20;
const CONTOUR_CACHE_GB = 2;

export const DEFAULT_NGINX_CACHE_ROOT = '/var/cache/nginx';
export const DEFAULT_NGINX_CACHE_OWNER = 'www-data';

export const EDGE_LIMITS = Object.freeze({
  tile: Object.freeze({
    requestZone: 'ogis_tiles',
    connectionZone: 'ogis_tile_conn',
    rate: '100r/s',
    burst: 200,
    connections: 40,
    readTimeout: '30s',
  }),
  contour: Object.freeze({
    requestZone: 'ogis_contours',
    connectionZone: 'ogis_contour_conn',
    rate: '10r/s',
    burst: 40,
    connections: 8,
    readTimeout: '75s',
  }),
  defaultReadTimeout: '60s',
  healthReadTimeout: '10s',
});

export function nginxCacheOwner(value = DEFAULT_NGINX_CACHE_OWNER) {
  const owner = String(value ?? '').trim();
  if (!validUsername(owner)) {
    throw new DeployError(`Nginx cache owner "${value}" is not a valid Linux user name`);
  }

  return owner;
}

function requirePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new DeployError(`Port "${value}" must be an unprivileged port between 1024 and 65535`);
  }

  return port;
}

function requireHost(value) {
  const host = String(value ?? '').trim();
  if (!validHostname(host)) {
    throw new DeployError(`"${value}" is not a valid hostname`);
  }

  return host;
}

function requirePath(value, label) {
  const path = String(value ?? '').trim();
  if (!path.startsWith('/') || /[\0\r\n]/.test(path)) {
    throw new DeployError(`${label} "${value}" must be an absolute path`);
  }

  return path;
}

function systemdQuotingNeeded(value) {
  return /[\s"'\\%]/.test(String(value));
}

function systemdQuote(value) {
  const escaped = String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%');

  return `"${escaped}"`;
}

function systemdPath(value) {
  return systemdQuotingNeeded(value) ? systemdQuote(value) : String(value);
}

function systemdAssignment(name, value) {
  const assignment = `${name}=${value}`;

  return systemdQuotingNeeded(assignment) ? systemdQuote(assignment) : assignment;
}

function sourceNames(sources) {
  const names = [];

  for (const [name, source] of Object.entries(sources ?? {})) {
    if (!SOURCE_NAME_PATTERN.test(name)) {
      throw new DeployError(`Source name "${name}" is not safe for nginx configuration`);
    }

    if (source?.kind === 'pmtiles' || source?.kind === 'contour') {
      names.push(name);
    }
  }

  return names;
}

export function nginxCacheDirectories(sources, { cacheRoot = DEFAULT_NGINX_CACHE_ROOT } = {}) {
  const root = requirePath(cacheRoot, 'Cache root');
  const names = sourceNames(sources);

  return [root, ...names.map((name) => `${root}/${name}`)];
}

function cacheSizes({ pmtiles, contourCount }) {
  const reserved = contourCount > 0 ? CONTOUR_CACHE_GB : 0;
  const remaining = CACHE_BUDGET_GB - reserved;
  const perSource = pmtiles.length > 0 ? Math.floor(remaining / pmtiles.length) : 0;
  const perContour = contourCount > 0 ? Math.floor(CONTOUR_CACHE_GB / contourCount) : 0;

  if (pmtiles.length > 0 && perSource < 1) {
    throw new DeployError(
      `Too many PMTiles sources for a ${CACHE_BUDGET_GB} GB cache budget; at least 1 GB per source is required`,
    );
  }

  if (contourCount > 0 && perContour < 1) {
    throw new DeployError(
      `Too many contour sources for a ${CONTOUR_CACHE_GB} GB cache budget; at least 1 GB per source is required`,
    );
  }

  return { pmtiles: perSource, contour: perContour };
}

function securityHeaders({ tls }) {
  const lines = [];

  if (tls) {
    lines.push(
      'add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;',
    );
  }

  lines.push(
    'add_header X-Content-Type-Options "nosniff" always;',
    'add_header X-Frame-Options "SAMEORIGIN" always;',
    'add_header Referrer-Policy "strict-origin-when-cross-origin" always;',
  );

  return lines;
}

function proxyHeaders({ readTimeout = EDGE_LIMITS.defaultReadTimeout } = {}) {
  return [
    'proxy_http_version 1.1;',
    'proxy_set_header Host $host;',
    'proxy_set_header X-Real-IP $remote_addr;',
    'proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    'proxy_set_header X-Forwarded-Proto $scheme;',
    'proxy_connect_timeout 5s;',
    'proxy_send_timeout 30s;',
    `proxy_read_timeout ${readTimeout};`,
  ];
}

function proxyPass(port) {
  return `proxy_pass http://127.0.0.1:${port};`;
}

function cacheLocation({ path, port, zone, lock = false, valid, tls, limits }) {
  const lines = [`  location ${path} {`, `    ${proxyPass(port)}`];

  if (limits) {
    lines.push(
      `    limit_req zone=${limits.requestZone} burst=${limits.burst} nodelay;`,
      `    limit_conn ${limits.connectionZone} ${limits.connections};`,
    );
  }

  for (const line of proxyHeaders({ readTimeout: limits?.readTimeout })) {
    lines.push(`    ${line}`);
  }

  lines.push(
    `    proxy_cache ${zone};`,
    '    proxy_cache_key "$scheme$request_method$host$request_uri";',
    `    proxy_cache_valid ${valid};`,
  );

  if (lock) {
    lines.push('    proxy_cache_lock on;', '    proxy_cache_lock_timeout 60s;');
  }

  if (limits) {
    lines.push('    add_header Retry-After $ogis_retry_after always;');
  }

  lines.push(
    '    add_header X-Cache-Status $upstream_cache_status always;',
    ...securityHeaders({ tls }).map((line) => `    ${line}`),
    '  }',
  );

  return lines;
}

function plainLocation({ path, port, tls, readTimeout = EDGE_LIMITS.defaultReadTimeout }) {
  const lines = [`  location ${path} {`, `    ${proxyPass(port)}`];

  for (const line of proxyHeaders({ readTimeout })) {
    lines.push(`    ${line}`);
  }

  lines.push(...securityHeaders({ tls }).map((line) => `    ${line}`), '  }');

  return lines;
}

function locations({ port, pmtiles, contours, tls }) {
  const lines = [];

  for (const name of pmtiles) {
    lines.push(
      ...cacheLocation({
        path: `= /${name}.json`,
        port,
        zone: `${name}_cache`,
        valid: '200 206 1h',
        tls,
      }),
    );
    lines.push(
      ...cacheLocation({
        path: `/${name}/`,
        port,
        zone: `${name}_cache`,
        valid: '200 206 1h',
        tls,
        limits: EDGE_LIMITS.tile,
      }),
    );
  }

  for (const name of contours) {
    lines.push(
      ...cacheLocation({
        path: `= /${name}.json`,
        port,
        zone: `${name}_cache`,
        lock: true,
        valid: '200 24h',
        tls,
      }),
    );
    lines.push(
      ...cacheLocation({
        path: `/${name}/`,
        port,
        zone: `${name}_cache`,
        lock: true,
        valid: '200 24h',
        tls,
        limits: EDGE_LIMITS.contour,
      }),
    );
  }

  for (const path of ['= /health', '= /ready']) {
    lines.push(...plainLocation({ path, port, tls, readTimeout: EDGE_LIMITS.healthReadTimeout }));
  }

  for (const path of ['= /sources', '= /']) {
    lines.push(...plainLocation({ path, port, tls }));
  }

  return lines;
}

function cachePaths({ pmtiles, contours, cacheRoot, sizes }) {
  const lines = [];

  for (const name of pmtiles) {
    lines.push(
      `proxy_cache_path ${cacheRoot}/${name} levels=1:2 keys_zone=${name}_cache:10m ` +
        `max_size=${sizes.pmtiles}g inactive=7d use_temp_path=off;`,
    );
  }

  for (const name of contours) {
    lines.push(
      `proxy_cache_path ${cacheRoot}/${name} levels=1:2 keys_zone=${name}_cache:10m ` +
        `max_size=${sizes.contour}g inactive=1d use_temp_path=off;`,
    );
  }

  return lines;
}

function edgePrelude() {
  return [
    `limit_req_zone $binary_remote_addr zone=${EDGE_LIMITS.tile.requestZone}:10m rate=${EDGE_LIMITS.tile.rate};`,
    `limit_req_zone $binary_remote_addr zone=${EDGE_LIMITS.contour.requestZone}:10m rate=${EDGE_LIMITS.contour.rate};`,
    `limit_conn_zone $binary_remote_addr zone=${EDGE_LIMITS.tile.connectionZone}:10m;`,
    `limit_conn_zone $binary_remote_addr zone=${EDGE_LIMITS.contour.connectionZone}:10m;`,
    'map $status $ogis_retry_after {',
    '  429 "1";',
    '  default "";',
    '}',
    `log_format ogis '$remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent "$http_referer" "$http_user_agent" rt=$request_time urt=$upstream_response_time cache=$upstream_cache_status';`,
  ];
}

function serverEdgeControls({ host }) {
  return [
    'client_max_body_size 64k;',
    'client_header_timeout 10s;',
    'client_body_timeout 10s;',
    'send_timeout 30s;',
    'keepalive_timeout 30s;',
    'limit_req_status 429;',
    'limit_conn_status 429;',
    'limit_req_log_level warn;',
    'limit_conn_log_level warn;',
    `access_log /var/log/nginx/${host}.access.log ogis;`,
  ];
}

export function renderSystemdUnit({
  deployUser = 'deploy',
  appDir = '/opt/ogis-tiles',
  dataDir = '/opt/ogis-tiles/data',
  nodeBin = '/usr/local/bin/node',
  port = 11010,
  configPath = 'config/layers.json',
  serviceName = 'ogis-tiles.service',
  publicBaseUrl = 'https://tile.ogis.app',
} = {}) {
  const user = String(deployUser ?? '').trim();
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user) || user === 'root') {
    throw new DeployError(`Deploy user "${deployUser}" is not a safe non-root Linux user`);
  }

  const workingDirectory = requirePath(appDir, 'App directory');
  const writableData = requirePath(dataDir, 'Data directory');
  const node = requirePath(nodeBin, 'Node binary');
  const pinnedPort = requirePort(port);

  if (!/^[A-Za-z0-9_.@-]+\.service$/.test(String(serviceName))) {
    throw new DeployError(`"${serviceName}" is not a valid systemd service name`);
  }

  if (/[\0\r\n]/.test(String(configPath))) {
    throw new DeployError('configPath must not contain newlines');
  }

  const baseUrl = String(publicBaseUrl ?? '').trim();
  if (!/^https?:\/\/[^\s\0\r\n]+$/.test(baseUrl)) {
    throw new DeployError(
      `Public base URL "${publicBaseUrl}" must be an absolute http or https URL`,
    );
  }

  return [
    '[Unit]',
    'Description=ogis-tiles tile server',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `User=${user}`,
    `WorkingDirectory=${systemdPath(workingDirectory)}`,
    `ExecStart=${systemdPath(node)} src/server.mjs`,
    'Environment=NODE_ENV=production',
    'Environment=HOST=127.0.0.1',
    `Environment=PORT=${pinnedPort}`,
    `Environment=${systemdAssignment('CONFIG_PATH', configPath)}`,
    `Environment=${systemdAssignment('PUBLIC_BASE_URL', baseUrl)}`,
    'Restart=always',
    'RestartSec=3',
    'NoNewPrivileges=true',
    'PrivateTmp=true',
    'ProtectSystem=strict',
    'ProtectHome=true',
    `ReadWritePaths=${systemdPath(writableData)}`,
    '',
    '[Install]',
    'WantedBy=multi-user.target',
    '',
  ].join('\n');
}

export function renderNginxConfig({
  host = 'tile.ogis.app',
  port = 11010,
  sources = {},
  tls = true,
  cacheRoot = DEFAULT_NGINX_CACHE_ROOT,
  certDir,
  certbotWebroot = '/var/www/certbot',
} = {}) {
  const domain = requireHost(host);
  const pinnedPort = requirePort(port);
  const root = requirePath(cacheRoot, 'Cache root');
  const webroot = requirePath(certbotWebroot, 'Certbot webroot');
  const names = sourceNames(sources);
  const pmtiles = names.filter((name) => sources[name].kind === 'pmtiles');
  const contours = names.filter((name) => sources[name].kind === 'contour');
  const sizes = cacheSizes({ pmtiles, contourCount: contours.length });
  const certificates = certDir
    ? requirePath(certDir, 'Certificate directory')
    : `/etc/letsencrypt/live/${domain}`;

  const lines = [
    '# Managed by ogis-tiles deployment. Do not edit on the server.',
    ...cachePaths({ pmtiles, contours, cacheRoot: root, sizes }),
    ...edgePrelude(),
    '',
  ];

  if (tls) {
    lines.push(
      'server {',
      '  listen 80;',
      '  listen [::]:80;',
      `  server_name ${domain};`,
      '',
      '  location /.well-known/acme-challenge/ {',
      `    root ${webroot};`,
      '  }',
      '',
      '  location / {',
      '    return 301 https://$host$request_uri;',
      '  }',
      '}',
      '',
      'server {',
      '  listen 443 ssl http2;',
      '  listen [::]:443 ssl http2;',
      `  server_name ${domain};`,
      '',
      `  ssl_certificate ${certificates}/fullchain.pem;`,
      `  ssl_certificate_key ${certificates}/privkey.pem;`,
      '  ssl_protocols TLSv1.2 TLSv1.3;',
      '  ssl_prefer_server_ciphers off;',
      '  ssl_session_cache shared:SSL:10m;',
      '  ssl_session_timeout 1d;',
      '',
      ...serverEdgeControls({ host: domain }).map((line) => `  ${line}`),
      '',
      ...securityHeaders({ tls: true }).map((line) => `  ${line}`),
      '',
      ...locations({ port: pinnedPort, pmtiles, contours, tls: true }),
      '}',
    );
  } else {
    lines.push(
      'server {',
      '  listen 80;',
      '  listen [::]:80;',
      `  server_name ${domain};`,
      '',
      '  location /.well-known/acme-challenge/ {',
      `    root ${webroot};`,
      '  }',
      '',
      ...serverEdgeControls({ host: domain }).map((line) => `  ${line}`),
      '',
      ...securityHeaders({ tls: false }).map((line) => `  ${line}`),
      '',
      ...locations({ port: pinnedPort, pmtiles, contours, tls: false }),
      '}',
    );
  }

  lines.push('');
  return lines.join('\n');
}
