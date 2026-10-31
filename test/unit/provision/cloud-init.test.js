import { describe, expect, it } from 'vitest';

import {
  CloudInitError,
  cloudInitPaths,
  MAX_CLOUD_CONFIG_BYTES,
  NODE_SHA256,
  NODE_TARBALL_URL,
  NODE_VERSION,
  renderCloudInit,
  RRSYNC_TARGET,
  rrsyncSetupScript,
} from '../../../src/provision/cloud-init.mjs';

const DEPLOY_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOdeployKeyExample deploy@example';
const BUILD_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIObuildKeyExample build@example';

function render(overrides = {}) {
  return renderCloudInit({
    host: 'tile.ogis.app',
    deployKeys: [DEPLOY_KEY],
    buildKeys: [BUILD_KEY],
    ...overrides,
  });
}

describe('renderCloudInit', () => {
  it('creates root, deploy and restricted build users', () => {
    const output = render();

    expect(output.startsWith('#cloud-config\n')).toBe(true);
    expect(output).toContain('  - name: root');
    expect(output).toContain('  - name: deploy');
    expect(output).toContain('  - name: build');
    expect(output).toContain('groups: [sudo, ogis]');
    expect(output).toContain('groups: [ogis]');

    expect(output.split(DEPLOY_KEY)).toHaveLength(3);
    expect(output).toContain(
      `command="${RRSYNC_TARGET} -wo /opt/ogis-tiles/data/incoming",restrict ${BUILD_KEY}`,
    );
    expect(output).toContain('install -d -m 2750 -o deploy -g ogis /opt/ogis-tiles/data');
    expect(output).toContain('install -d -m 2770 -o deploy -g ogis /opt/ogis-tiles/data/incoming');
    expect(output).toContain('install -d -m 0755 -o root -g root /home/build');
    expect(output).toContain('install -d -m 0755 -o root -g root /home/build/.ssh');
    expect(output).toContain(
      'install -m 0644 -o root -g root /opt/ogis-tiles/build-authorized-keys /home/build/.ssh/authorized_keys',
    );
  });

  it('keeps data non-group-writable and root-owns the build key', () => {
    const output = render();

    expect(output).toContain('install -d -m 2750 -o deploy -g ogis /opt/ogis-tiles/data');
    expect(output).not.toContain('-m 2775 -o deploy -g ogis /opt/ogis-tiles/data');
    expect(output).toContain('install -d -m 2770 -o deploy -g ogis /opt/ogis-tiles/data/incoming');
    expect(output).toContain('install -d -m 0755 -o root -g root /home/build/.ssh');
    expect(output).toContain('install -m 0644 -o root -g root');
  });

  it('links rrsync from the new path when it exists, with the legacy path as fallback', () => {
    const output = render();
    const script = rrsyncSetupScript();

    expect(output).toContain('/usr/bin/rrsync');
    expect(output).toContain('/usr/share/rsync/scripts/rrsync');
    expect(script).toContain('if [ -x /usr/bin/rrsync ]');
    expect(script).toContain('elif [ -x /usr/share/rsync/scripts/rrsync ]');
    expect(script).toContain('ln -sfn /usr/bin/rrsync /usr/local/bin/rrsync');
    expect(script).toContain('ln -sfn /usr/share/rsync/scripts/rrsync /usr/local/bin/rrsync');
  });

  it('keeps rrsync fail-closed when neither source path exists', () => {
    const script = rrsyncSetupScript();

    expect(script).toContain('else');
    expect(script).toContain('rrsync not found; build uploads will fail');
    expect(script).not.toContain('install -m 0755');
    expect(script.match(/ln -sfn/g)).toHaveLength(2);
  });

  it('pins Node.js 24 with the tarball and checksum', () => {
    const output = render();

    expect(NODE_VERSION).toMatch(/^v24\./);
    expect(NODE_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(output).toContain(NODE_VERSION);
    expect(output).toContain(NODE_TARBALL_URL);
    expect(output).toContain(NODE_SHA256);
    expect(output).toContain('sha256sum -c -');
    expect(output).toContain('tar -xJf');
    expect(output).toContain('/usr/local/bin/node --version');
  });

  it('installs the required packages', () => {
    const output = render();

    for (const name of [
      'curl',
      'ca-certificates',
      'rsync',
      'nginx',
      'certbot',
      'ufw',
      'python3',
      'unzip',
      'xz-utils',
    ]) {
      expect(output).toContain(`  - ${name}`);
    }
  });

  it('hardens the systemd unit', () => {
    const output = render();
    const paths = cloudInitPaths('tile.ogis.app');

    expect(output).toContain(`  - path: ${paths.serviceFile}`);
    expect(output).toContain('User=deploy');
    expect(output).toContain('WorkingDirectory=/opt/ogis-tiles');
    expect(output).toContain('ExecStart=/usr/local/bin/node src/server.mjs');
    expect(output).toContain('Environment=HOST=127.0.0.1');
    expect(output).toContain('Environment=PORT=11010');
    expect(output).toContain('Restart=always');
    expect(output).toContain('NoNewPrivileges=true');
    expect(output).toContain('PrivateTmp=true');
    expect(output).toContain('ProtectSystem=strict');
    expect(output).toContain('ReadWritePaths=/opt/ogis-tiles/data');
    expect(output).toContain('After=network-online.target');
    expect(output).toContain('systemctl enable ogis-tiles.service');
    expect(output).not.toContain('systemctl start ogis-tiles.service');
  });

  it('configures nginx as an HTTP placeholder with an ACME webroot', () => {
    const output = render();

    expect(output).toContain('  - path: /etc/nginx/sites-available/tile.ogis.app');
    expect(output).toContain('server_name tile.ogis.app;');
    expect(output).toContain('proxy_pass http://127.0.0.1:11010;');
    expect(output).toContain('location /.well-known/acme-challenge/ {');
    expect(output).toContain('root /var/www/certbot;');
    expect(output).not.toContain('ssl_certificate');
    expect(output).toContain('ln -sfn /etc/nginx/sites-available/tile.ogis.app');
  });

  it('enables the firewall, fail2ban and SSH hardening', () => {
    const output = render();

    expect(output).toContain('ufw default deny incoming');
    expect(output).toContain('ufw allow 22/tcp');
    expect(output).toContain('ufw allow 80/tcp');
    expect(output).toContain('ufw allow 443/tcp');
    expect(output).toContain('ufw --force enable');
    expect(output).toContain('  - path: /etc/fail2ban/jail.d/ogis.local');
    expect(output).toContain('enabled = true');
    expect(output).not.toContain('systemctl enable --now fail2ban');
    expect(output).not.toContain('  - fail2ban');
    expect(output).toContain('PasswordAuthentication no');
    expect(output).toContain('PermitRootLogin prohibit-password');
    expect(output).toContain('systemctl reload ssh');
    expect(output).toContain('timedatectl set-timezone UTC');
  });

  it('stays below the 32 KiB user_data limit', () => {
    const output = render();

    expect(Buffer.byteLength(output, 'utf8')).toBeLessThan(MAX_CLOUD_CONFIG_BYTES);
    expect(MAX_CLOUD_CONFIG_BYTES).toBe(32 * 1024);
  });

  it('never renders private key material', () => {
    expect(() =>
      render({
        deployKeys: [
          '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----',
        ],
      }),
    ).toThrow(/private key material/i);

    expect(render()).not.toContain('PRIVATE KEY');
  });

  it('rejects invalid hosts, users and keys', () => {
    expect(() => render({ host: 'tile ogis app' })).toThrow(CloudInitError);
    expect(() => render({ deployUser: 'Root User' })).toThrow(/valid Linux user name/);
    expect(() => render({ deployKeys: ['not-a-key'] })).toThrow(/valid SSH public key/);
    expect(() => render({ buildKeys: [] })).toThrow(/At least one build SSH public key/);
  });

  it('rejects root and equal deploy/build users in a direct render', () => {
    expect(() => render({ deployUser: 'root' })).toThrow(/distinct non-root users/);
    expect(() => render({ buildUser: 'root' })).toThrow(/distinct non-root users/);
    expect(() => render({ buildUser: 'deploy' })).toThrow(/distinct non-root users/);
  });

  it('rejects hardware-backed sk- public keys', () => {
    expect(() =>
      render({
        deployKeys: ['sk-ssh-ed25519@openssh.com AAAAC3NzaC1lZDI1NTE5AAAAIOexample test'],
      }),
    ).toThrow(/hardware-backed/);
  });

  it('deduplicates repeated keys', () => {
    const output = render({ deployKeys: [DEPLOY_KEY, DEPLOY_KEY] });

    expect(output.split(DEPLOY_KEY)).toHaveLength(3);
  });

  it('rejects unsafe renderer overrides', () => {
    expect(() => render({ nodeVersion: 'v24.1' })).toThrow(/valid Node.js version/);
    expect(() => render({ nodeUrl: 'https://example.com/a;touch /tmp/x' })).toThrow(
      /valid HTTPS Node.js tarball URL/,
    );
    expect(() => render({ nodeSha256: 'xyz' })).toThrow(/valid SHA-256 checksum/);
    expect(() => render({ serviceName: 'ogis-tiles; rm -rf /' })).toThrow(
      /valid systemd service name/,
    );
  });

  it('rejects privileged and web ports', () => {
    expect(() => render({ serverPort: 80 })).toThrow(/unprivileged port/);
    expect(() => render({ serverPort: 443 })).toThrow(/unprivileged port/);
    expect(() => render({ serverPort: 1023 })).toThrow(/unprivileged port/);
    expect(() => render({ serverPort: 65_536 })).toThrow(/unprivileged port/);
  });

  it('uses a validated service name for both the unit file and enablement', () => {
    const output = render({ serviceName: 'custom-tiles.service' });

    expect(output).toContain('  - path: /etc/systemd/system/custom-tiles.service');
    expect(output).toContain('systemctl enable custom-tiles.service');
  });

  it('accepts renderer overrides for the Node pin and port', () => {
    const output = render({
      nodeVersion: 'v24.99.0',
      nodeUrl: 'https://example.com/node.tar.xz',
      nodeSha256: 'a'.repeat(64),
      serverPort: 11099,
    });

    expect(output).toContain('v24.99.0');
    expect(output).toContain('https://example.com/node.tar.xz');
    expect(output).toContain('a'.repeat(64));
    expect(output).toContain('Environment=PORT=11099');
    expect(output).toContain('proxy_pass http://127.0.0.1:11099;');
  });
});
