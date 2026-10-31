import { describe, expect, it } from 'vitest';

import {
  MAX_CLOUD_CONFIG_BYTES,
  NODE_SHA256,
  NODE_TARBALL_URL,
  NODE_VERSION,
} from '../../../src/provision/cloud-init.mjs';
import {
  BuildCloudInitError,
  PMTILES_SHA256,
  PMTILES_TARBALL_URL,
  PMTILES_VERSION,
  renderBuildBoxCloudInit,
  resolvePmtilesRelease,
} from '../../../src/build/remote-cloud-init.mjs';

const DEPLOY_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOdeployKeyExample deploy@example';

function render(overrides = {}) {
  return renderBuildBoxCloudInit({
    deployKeys: [DEPLOY_KEY],
    ...overrides,
  });
}

describe('renderBuildBoxCloudInit', () => {
  it('renders a cloud-config with the deploy key and no private material', () => {
    const output = render();

    expect(output.startsWith('#cloud-config\n')).toBe(true);
    expect(output).toContain('  - name: deploy');
    expect(output).not.toContain('NOPASSWD');
    expect(output.split(DEPLOY_KEY)).toHaveLength(3);
    expect(output).not.toContain('PRIVATE KEY');
  });

  it('pins Node.js and the pmtiles binary with checksums', () => {
    const output = render();

    expect(output).toContain(NODE_VERSION);
    expect(output).toContain(NODE_TARBALL_URL);
    expect(output).toContain(NODE_SHA256);
    expect(output).toContain(PMTILES_VERSION);
    expect(output).toContain(PMTILES_TARBALL_URL);
    expect(output).toContain(PMTILES_SHA256);
    expect(output.match(/sha256sum -c -/g)).toHaveLength(2);
    expect(output).toContain('tar -xzf');
    expect(output).toContain('/usr/local/bin/pmtiles version');
    expect(output).not.toContain('/usr/local/bin/pmtiles --version');
  });

  it('installs Java 21, osmium, rsync and the archive tools', () => {
    const output = render();

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
      expect(output).toContain(`  - ${name}`);
    }

    expect(output).toContain('java -version');
    expect(output).toContain('osmium --version');
    expect(output).toContain('rsync --version');
  });

  it('prepares the application directory and hardens SSH', () => {
    const output = render();

    expect(output).toContain("install -d -m 0750 '/opt/ogis-tiles'");
    expect(output).toContain("chown deploy:deploy '/opt/ogis-tiles'");
    expect(output).toContain("install -d -m 0700 -o deploy -g deploy '/opt/ogis-tiles/tmp'");
    expect(output).toContain('PasswordAuthentication no');
    expect(output).toContain('PermitRootLogin prohibit-password');
    expect(output).toContain('sshd -t');
    expect(output).toContain('systemctl reload ssh');
    expect(output).toContain('ufw default deny incoming');
    expect(output).toContain('ufw allow 22/tcp');
    expect(output).toContain('ufw --force enable');
  });

  it('uses a custom application directory instead of the default', () => {
    const output = render({ appDir: '/srv/ogis-tiles' });

    expect(output).toContain("install -d -m 0750 '/srv/ogis-tiles'");
    expect(output).toContain("chown deploy:deploy '/srv/ogis-tiles'");
    expect(output).toContain("'/srv/ogis-tiles/tmp'");
    expect(output).not.toContain('/opt/ogis-tiles');
  });

  it('rejects an unsafe application directory', () => {
    for (const appDir of ['relative/path', '/', '/srv/../etc', '/srv/ogis\nrm -rf /']) {
      expect(() => render({ appDir })).toThrow(/safe absolute build box directory/);
    }
  });

  it('derives the pmtiles download URL from the pinned version', () => {
    expect(PMTILES_TARBALL_URL).toContain(`/v${PMTILES_VERSION}/`);
    expect(PMTILES_TARBALL_URL).toContain(`go-pmtiles_${PMTILES_VERSION}_Linux_x86_64.tar.gz`);
  });

  it('rejects an unpinned pmtiles version', () => {
    expect(() => render({ pmtilesVersion: '9.9.9' })).toThrow(/not a pinned build-box release/);
  });

  it('resolves only own pinned pmtiles versions, not prototype members', () => {
    expect(resolvePmtilesRelease()).toEqual({
      version: PMTILES_VERSION,
      url: PMTILES_TARBALL_URL,
      sha256: PMTILES_SHA256,
    });

    for (const version of [
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
      '1.31.2/../../etc',
      '../1.31.2',
    ]) {
      expect(() => resolvePmtilesRelease(version)).toThrow(/not a pinned build-box release/);
    }
  });

  it('stays below the 32 KiB user_data limit', () => {
    expect(Buffer.byteLength(render(), 'utf8')).toBeLessThan(MAX_CLOUD_CONFIG_BYTES);
  });

  it('rejects private keys, invalid keys and the root user', () => {
    expect(() =>
      render({
        deployKeys: [
          '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----',
        ],
      }),
    ).toThrow(/private key material/i);

    expect(() => render({ deployKeys: ['not-a-key'] })).toThrow(BuildCloudInitError);
    expect(() => render({ deployKeys: [] })).toThrow(/At least one deploy SSH public key/);
    expect(() => render({ deployUser: 'root' })).toThrow(/must not be root/);
    expect(() => render({ deployUser: 'Root User' })).toThrow(/valid Linux user name/);
    expect(() =>
      render({
        deployKeys: ['sk-ssh-ed25519@openssh.com AAAAC3NzaC1lZDI1NTE5AAAAIOexample test'],
      }),
    ).toThrow(/hardware-backed/);
  });
});
