import { describe, expect, it } from 'vitest';

import { resolveDeployConfig, withServerOverride } from '../../../src/deploy/config.mjs';

const BASE_ENV = {
  TILE_SERVER_HOST: 'tile.ogis.app',
  TILE_SERVER_IP: '128.140.70.114',
  SSH_PRIVATE_KEY_PATH: '/home/joe/.ssh/ogis_tiles',
  DEPLOY_USER: 'deploy',
  CERTBOT_EMAIL: 'ops@example.com',
  PORT: '11010',
};

function configFor(overrides = {}) {
  return resolveDeployConfig({ env: { ...BASE_ENV, ...overrides } });
}

describe('resolveDeployConfig', () => {
  it('resolves default paths, service and certificate locations', () => {
    const config = configFor();

    expect(config).toMatchObject({
      host: 'tile.ogis.app',
      serverIp: '128.140.70.114',
      deployUser: 'deploy',
      port: 11010,
      appDir: '/opt/ogis-tiles',
      dataDir: '/opt/ogis-tiles/data',
      incomingDir: '/opt/ogis-tiles/data/incoming',
      configPath: 'config/layers.json',
      serviceName: 'ogis-tiles.service',
      nodeBin: '/usr/local/bin/node',
      serviceFile: '/etc/systemd/system/ogis-tiles.service',
      nginxSiteFile: '/etc/nginx/sites-available/tile.ogis.app',
      nginxEnabledFile: '/etc/nginx/sites-enabled/tile.ogis.app',
      deployPrivateKeyPath: '/home/joe/.ssh/ogis_tiles',
    });
  });

  it('honours an incoming directory override', () => {
    const config = configFor({ TILE_INCOMING_DIR: '/srv/tiles/incoming' });

    expect(config.incomingDir).toBe('/srv/tiles/incoming');
  });

  it('rejects invalid hosts, users, ports and service names', () => {
    expect(() => configFor({ TILE_SERVER_HOST: 'not a host' })).toThrow(/valid hostname/);
    expect(() => configFor({ DEPLOY_USER: 'root' })).toThrow(/must not be root/);
    expect(() => configFor({ DEPLOY_USER: 'bad user' })).toThrow(/valid Linux user/);
    expect(() => configFor({ PORT: '80' })).toThrow(/unprivileged port/);
    expect(() => configFor({ SERVICE_NAME: 'ogis-tiles' })).toThrow(/valid systemd service/);
  });

  it('rejects unsafe directories and config paths', () => {
    expect(() => configFor({ TILE_APP_DIR: 'relative' })).toThrow(/absolute path/);
    expect(() => configFor({ TILE_DATA_DIR: '/opt/../etc' })).toThrow(/safe absolute path/);
    expect(() => configFor({ TILE_INCOMING_DIR: '/' })).toThrow(/safe absolute path/);
    expect(() => configFor({ CONFIG_PATH: '../layers.json' })).toThrow(/must not contain/);
    expect(() => configFor({ CONFIG_PATH: '/etc/../layers.json' })).toThrow(/safe absolute path/);
  });

  it('allows a missing host only when host checks are relaxed', () => {
    const env = { ...BASE_ENV };
    delete env.TILE_SERVER_HOST;

    expect(() => resolveDeployConfig({ env })).toThrow(/TILE_SERVER_HOST is required/);
    expect(resolveDeployConfig({ env, requireHost: false }).host).toBe('tile.ogis.app');
  });
});

describe('withServerOverride', () => {
  it('overrides the SSH target for hostnames and IPv4 addresses', () => {
    const config = configFor();

    expect(withServerOverride(config, '192.0.2.10').targetHost).toBe('192.0.2.10');
    expect(withServerOverride(config, 'staging.example.com').targetHost).toBe(
      'staging.example.com',
    );
    expect(withServerOverride(config, '').targetHost).toBe('tile.ogis.app');
  });

  it('rejects unsafe server targets', () => {
    expect(() => withServerOverride(configFor(), 'bad host')).toThrow(/not a valid hostname/);
    expect(() => withServerOverride(configFor(), 'host;rm -rf /')).toThrow(/not a valid hostname/);
  });
});
