import { describe, expect, it } from 'vitest';

import { sourceRemoteCommand } from '../../../src/deploy/remote.mjs';

const CONFIG = {
  appDir: '/opt/ogis-tiles',
  dataDir: '/opt/ogis-tiles/data',
  incomingDir: '/opt/ogis-tiles/data/incoming',
  configPath: 'config/layers.json',
  serviceName: 'ogis-tiles.service',
  nodeBin: '/usr/local/bin/node',
  port: 11010,
};

describe('sourceRemoteCommand', () => {
  it('forwards paths, the port, service, node and config to the remote command', () => {
    const command = sourceRemoteCommand(CONFIG, 'promote', { source: 'pois' });

    expect(command).toContain("cd '/opt/ogis-tiles' &&");
    expect(command).toContain("PORT='11010'");
    expect(command).toContain("SERVICE_NAME='ogis-tiles.service'");
    expect(command).toContain("NODE_BIN='/usr/local/bin/node'");
    expect(command).toContain("CONFIG_PATH='config/layers.json'");
    expect(command).toContain("TILE_APP_DIR='/opt/ogis-tiles'");
    expect(command).toContain("TILE_DATA_DIR='/opt/ogis-tiles/data'");
    expect(command).toContain("TILE_INCOMING_DIR='/opt/ogis-tiles/data/incoming'");
    expect(command).toContain("--app-dir '/opt/ogis-tiles'");
    expect(command).toContain("--data-dir '/opt/ogis-tiles/data'");
    expect(command).toContain("--incoming-dir '/opt/ogis-tiles/data/incoming'");
    expect(command).toContain('/usr/local/bin/node bin/ogis.mjs promote --server-side');
    expect(command).toContain("--source 'pois'");
    expect(command).not.toContain('--skip-smoke');
  });

  it('honours client overrides and skip-smoke', () => {
    const command = sourceRemoteCommand(CONFIG, 'rollback', {
      source: 'pois',
      appDir: '/srv/ogis-tiles',
      dataDir: '/srv/tiles',
      incomingDir: '/srv/tiles/incoming',
      skipSmoke: true,
    });

    expect(command).toContain("cd '/srv/ogis-tiles' &&");
    expect(command).toContain("TILE_APP_DIR='/srv/ogis-tiles'");
    expect(command).toContain("TILE_DATA_DIR='/srv/tiles'");
    expect(command).toContain("TILE_INCOMING_DIR='/srv/tiles/incoming'");
    expect(command).toContain('/srv/ogis-tiles');
    expect(command).toContain('--skip-smoke');
  });

  it('quotes a node binary path containing spaces', () => {
    const command = sourceRemoteCommand(
      { ...CONFIG, nodeBin: '/opt/my node/bin/node' },
      'promote',
      {
        source: 'pois',
      },
    );

    expect(command).toContain("NODE_BIN='/opt/my node/bin/node'");
    expect(command).toContain("'/opt/my node/bin/node' bin/ogis.mjs promote");
  });
});
