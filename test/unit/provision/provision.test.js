import { describe, expect, it, vi } from 'vitest';

import {
  childEnvironment,
  installProtectionSignalGuard,
  loadEnvironment,
  parseEnvFile,
  provisionRunOptions,
  resolveConfig,
  resolvePublicKey,
  runProvision,
  runStatus,
} from '../../../src/provision/provision.mjs';

const DEPLOY_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOdeployKeyExample deploy@example';
const BUILD_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIObuildKeyExample build@example';
const UBUNTU_OS_RELEASE = 'ID=ubuntu\nVERSION_ID="26.04"\nPRETTY_NAME="Ubuntu 26.04 LTS"\n';

function validEnv(overrides = {}) {
  return {
    HCLOUD_TOKEN: 'test-token',
    TILE_SERVER_HOST: 'tile.ogis.app',
    TILE_SERVER_IP: '128.140.70.114',
    SSH_PRIVATE_KEY_PATH: '/home/joe/.ssh/ogis_tiles',
    BUILD_SSH_PRIVATE_KEY_PATH: '/home/joe/.ssh/ogis_tiles_build',
    ...overrides,
  };
}

function baseConfig(overrides = {}) {
  return {
    token: 'test-token',
    host: 'tile.ogis.app',
    serverIp: '128.140.70.114',
    serverName: 'ogis-tiles',
    serverType: 'cx23',
    location: 'nbg1',
    image: 'ubuntu-26.04',
    certbotEmail: '',
    deployUser: 'deploy',
    buildUser: 'build',
    port: 11010,
    deployPrivateKeyPath: '/home/joe/.ssh/ogis_tiles',
    deployPublicKeyPath: '/home/joe/.ssh/ogis_tiles.pub',
    buildPrivateKeyPath: '/home/joe/.ssh/ogis_tiles_build',
    buildPublicKeyPath: '/home/joe/.ssh/ogis_tiles_build.pub',
    ...overrides,
  };
}

function makeServer(overrides = {}) {
  return {
    id: 42,
    name: 'ogis-tiles',
    status: 'running',
    public_net: {
      ipv4: { ip: '128.140.70.114' },
      ipv6: { ip: '2a01:4f8:1:2::/64' },
    },
    server_type: { name: 'cx23' },
    location: { name: 'nbg1' },
    datacenter: { location: { name: 'nbg1' } },
    image: { name: 'ubuntu-26.04' },
    protection: { delete: false, rebuild: false },
    rescue_enabled: false,
    iso: null,
    ...overrides,
  };
}

function makeClient({
  server = makeServer(),
  after,
  image = {
    id: 387894169,
    name: 'ubuntu-26.04',
    type: 'system',
    architecture: 'x86',
    status: 'available',
  },
} = {}) {
  return {
    findServerByIPv4: vi.fn().mockResolvedValue(server),
    findServerByName: vi.fn().mockResolvedValue(server),
    getServer: vi.fn().mockResolvedValue(after ?? server),
    findImageByName: vi.fn().mockResolvedValue(image),
    listServerActions: vi.fn().mockResolvedValue([]),
    disableRescue: vi.fn().mockResolvedValue({ id: 1, status: 'running' }),
    detachIso: vi.fn().mockResolvedValue({ id: 2, status: 'running' }),
    changeProtection: vi.fn().mockResolvedValue({ id: 3, status: 'running' }),
    createSnapshot: vi
      .fn()
      .mockResolvedValue({ action: { id: 4, status: 'running' }, image: { id: 5 } }),
    rebuildServer: vi.fn().mockResolvedValue({ id: 6, status: 'running' }),
    waitForAction: vi.fn().mockResolvedValue({ id: 6, status: 'success' }),
  };
}

function makeFs({ missing = [] } = {}) {
  return {
    stat: vi.fn(async (target) => {
      if (missing.includes(target)) {
        const error = new Error('missing');
        error.code = 'ENOENT';
        throw error;
      }

      return {};
    }),
    readFile: vi.fn(async (target) => {
      if (target.includes('ogis_tiles_build')) {
        return `${BUILD_KEY}\n`;
      }

      return `${DEPLOY_KEY}\n`;
    }),
  };
}

function makeExec({
  osRelease = UBUNTU_OS_RELEASE,
  sshFailures = 0,
  deployKey = DEPLOY_KEY,
  buildKey = BUILD_KEY,
} = {}) {
  let failures = sshFailures;

  return vi.fn(async (command, args) => {
    if (command === 'ssh-keygen') {
      if (args[0] === '-y') {
        const keyPath = args[args.indexOf('-f') + 1] ?? '';
        return {
          stdout: `${keyPath.includes('build') ? buildKey : deployKey}\n`,
          stderr: '',
        };
      }

      return { stdout: '', stderr: '' };
    }

    if (command === 'ssh') {
      const remote = args[args.length - 1];

      if (remote === 'true' && failures > 0) {
        failures -= 1;
        throw new Error('connection refused');
      }

      if (remote === 'cat /etc/os-release') {
        return { stdout: osRelease, stderr: '' };
      }

      return { stdout: '', stderr: '' };
    }

    throw new Error(`Unexpected command ${command}`);
  });
}

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

function dnsFor(addresses = ['128.140.70.114']) {
  return { resolve4: vi.fn().mockResolvedValue(addresses) };
}

function makeSignalProcess() {
  const handlers = new Map();

  return {
    on: vi.fn((signal, handler) => {
      handlers.set(signal, handler);
    }),
    removeListener: vi.fn((signal, handler) => {
      if (handlers.get(signal) === handler) {
        handlers.delete(signal);
      }
    }),
    exit: vi.fn(),
    emit(signal) {
      handlers.get(signal)?.();
    },
    handlers,
  };
}

const TEST_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/joe',
  HCLOUD_TOKEN: 'environment-secret',
  TERM: 'xterm',
};

function baseRun(overrides = {}) {
  return {
    config: baseConfig(),
    client: makeClient(),
    dnsImpl: dnsFor(),
    fsImpl: makeFs(),
    execImpl: makeExec(),
    env: TEST_ENV,
    out: makeOut(),
    err: makeOut(),
    ...overrides,
  };
}

describe('parseEnvFile and loadEnvironment', () => {
  it('parses plain, quoted and commented values', () => {
    expect(
      parseEnvFile(
        [
          '# comment',
          'PLAIN=value',
          'export QUOTED="a b"',
          "SINGLE='c d'",
          'TRAILING=value # trailing comment',
          '',
        ].join('\n'),
      ),
    ).toEqual({
      PLAIN: 'value',
      QUOTED: 'a b',
      SINGLE: 'c d',
      TRAILING: 'value',
    });
  });

  it('lets the process environment win over the file', async () => {
    const fsImpl = {
      readFile: vi.fn().mockResolvedValue('TILE_SERVER_HOST=file.example\nEXTRA=1\n'),
    };

    await expect(
      loadEnvironment({ env: { TILE_SERVER_HOST: 'env.example' }, envPath: '.env', fsImpl }),
    ).resolves.toEqual({ TILE_SERVER_HOST: 'env.example', EXTRA: '1' });
  });

  it('ignores a missing env file', async () => {
    const error = new Error('missing');
    error.code = 'ENOENT';
    const fsImpl = { readFile: vi.fn().mockRejectedValue(error) };

    await expect(loadEnvironment({ env: {}, envPath: '.env', fsImpl })).resolves.toEqual({});
  });
});

describe('childEnvironment', () => {
  it('keeps only the allowed child-process variables', () => {
    expect(
      childEnvironment({
        PATH: '/usr/bin',
        HOME: '/home/joe',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        TERM: 'xterm',
        HCLOUD_TOKEN: 'secret',
        AWS_SECRET_ACCESS_KEY: 'secret',
      }),
    ).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/joe',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      TERM: 'xterm',
    });
  });
});

describe('installProtectionSignalGuard', () => {
  it('restores protection before exiting on SIGINT', async () => {
    const restore = vi.fn().mockResolvedValue(undefined);
    const err = makeOut();
    const processImpl = makeSignalProcess();
    const guard = installProtectionSignalGuard({ restore, err, processImpl, timeoutMs: 500 });

    processImpl.emit('SIGINT');

    await vi.waitFor(() => expect(processImpl.exit).toHaveBeenCalledWith(130));
    expect(restore).toHaveBeenCalledTimes(1);
    expect(err.text()).toContain('Received SIGINT');
    expect(err.text()).toContain('Restored protection before exit');

    guard.dispose();
    expect(processImpl.handlers.size).toBe(0);
  });

  it('bounds the restore attempt before exiting on SIGTERM', async () => {
    let release;
    const restore = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const err = makeOut();
    const processImpl = makeSignalProcess();
    const guard = installProtectionSignalGuard({ restore, err, processImpl, timeoutMs: 10 });

    processImpl.emit('SIGTERM');

    await vi.waitFor(() => expect(processImpl.exit).toHaveBeenCalledWith(143));
    expect(err.text()).toContain('did not finish within 10ms');
    expect(err.text()).toContain('check the server');

    release();
    guard.dispose();
  });
});

describe('resolveConfig', () => {
  it.each(['HCLOUD_TOKEN', 'TILE_SERVER_HOST'])('fails clearly when %s is missing', (name) => {
    const env = validEnv();
    delete env[name];

    expect(() => resolveConfig({ env })).toThrow(new RegExp(`${name} is required`));
  });

  it.each(['SSH_PRIVATE_KEY_PATH', 'BUILD_SSH_PRIVATE_KEY_PATH'])(
    'requires %s when provisioning',
    (name) => {
      const env = validEnv();
      delete env[name];

      expect(() => resolveConfig({ env, requireSshKeys: true })).toThrow(
        new RegExp(`${name} is required`),
      );
    },
  );

  it('applies defaults and expands the home directory', () => {
    const config = resolveConfig({
      env: {
        ...validEnv(),
        SSH_PRIVATE_KEY_PATH: '~/.ssh/ogis_tiles',
        BUILD_SSH_PRIVATE_KEY_PATH: '~/.ssh/ogis_tiles_build',
      },
      homedir: '/home/joe',
    });

    expect(config.serverType).toBe('cx23');
    expect(config.location).toBe('nbg1');
    expect(config.image).toBe('ubuntu-26.04');
    expect(config.deployUser).toBe('deploy');
    expect(config.buildUser).toBe('build');
    expect(config.port).toBe(11010);
    expect(config.deployPrivateKeyPath).toBe('/home/joe/.ssh/ogis_tiles');
    expect(config.deployPublicKeyPath).toBe('/home/joe/.ssh/ogis_tiles.pub');
    expect(config.buildPublicKeyPath).toBe('/home/joe/.ssh/ogis_tiles_build.pub');
  });

  it('allows status to resolve without SSH key configuration', () => {
    const config = resolveConfig({
      env: {
        HCLOUD_TOKEN: 'test-token',
        TILE_SERVER_HOST: 'tile.ogis.app',
      },
    });

    expect(config.token).toBe('test-token');
    expect(config.host).toBe('tile.ogis.app');
    expect(config.deployPrivateKeyPath).toBe('');
    expect(config.deployPublicKeyPath).toBe('');
    expect(config.buildPrivateKeyPath).toBe('');
    expect(config.buildPublicKeyPath).toBe('');
  });

  it('restricts PORT to an unprivileged non-web port', () => {
    for (const port of ['80', '443', '1023', '0', '65536']) {
      expect(() => resolveConfig({ env: validEnv({ PORT: port }) })).toThrow(
        /unprivileged port between 1024 and 65535/,
      );
    }

    expect(resolveConfig({ env: validEnv({ PORT: '65535' }) }).port).toBe(65_535);
  });

  it('rejects non-x86 server types but keeps the certbot email for Phase 5b', () => {
    expect(() => resolveConfig({ env: validEnv({ SERVER_TYPE: 'cax21' }) })).toThrow(/not x86/);

    expect(
      resolveConfig({ env: validEnv({ CERTBOT_EMAIL: 'ops@example.com' }) }).certbotEmail,
    ).toBe('ops@example.com');
  });

  it('rejects an invalid IPv4 address and invalid users', () => {
    expect(() => resolveConfig({ env: validEnv({ TILE_SERVER_IP: 'not-an-ip' }) })).toThrow(
      /valid IPv4/,
    );
    expect(() => resolveConfig({ env: validEnv({ DEPLOY_USER: 'deploy user' }) })).toThrow(
      /valid Linux user name/,
    );
    expect(() => resolveConfig({ env: validEnv({ DEPLOY_USER: 'build' }) })).toThrow(
      /distinct non-root users/,
    );
  });
});

describe('resolvePublicKey', () => {
  const TEST_KEY_ENV = { PATH: '/usr/bin', HCLOUD_TOKEN: 'secret' };

  it('derives the private key public half and verifies the .pub file matches', async () => {
    const fsImpl = makeFs();

    await expect(
      resolvePublicKey({
        privateKeyPath: '/home/joe/.ssh/ogis_tiles',
        publicKeyPath: '/home/joe/.ssh/ogis_tiles.pub',
        label: 'Deploy',
        fsImpl,
        execImpl: makeExec(),
      }),
    ).resolves.toBe(DEPLOY_KEY);
  });

  it('treats a different comment on the same key material as a match', async () => {
    const keyBody = DEPLOY_KEY.split(' ').slice(0, 2).join(' ');
    const fsImpl = {
      stat: vi.fn().mockResolvedValue({}),
      readFile: vi.fn().mockResolvedValue(`${keyBody} another@host\n`),
    };

    await expect(
      resolvePublicKey({
        privateKeyPath: '/home/joe/.ssh/ogis_tiles',
        publicKeyPath: '/home/joe/.ssh/ogis_tiles.pub',
        label: 'Deploy',
        fsImpl,
        execImpl: makeExec(),
      }),
    ).resolves.toBe(DEPLOY_KEY);
  });

  it('derives the public key with ssh-keygen when the .pub file is missing', async () => {
    const execImpl = makeExec();
    const fsImpl = makeFs({ missing: ['/home/joe/.ssh/ogis_tiles.pub'] });

    await expect(
      resolvePublicKey({
        privateKeyPath: '/home/joe/.ssh/ogis_tiles',
        publicKeyPath: '/home/joe/.ssh/ogis_tiles.pub',
        label: 'Deploy',
        fsImpl,
        execImpl,
        env: TEST_KEY_ENV,
      }),
    ).resolves.toBe(DEPLOY_KEY);

    expect(execImpl).toHaveBeenCalledWith(
      'ssh-keygen',
      ['-y', '-P', '', '-f', '/home/joe/.ssh/ogis_tiles'],
      {
        encoding: 'utf8',
        env: { PATH: '/usr/bin' },
        timeoutMs: 60_000,
      },
    );
  });

  it('aborts when the .pub file does not match the private key', async () => {
    const fsImpl = {
      stat: vi.fn().mockResolvedValue({}),
      readFile: vi.fn().mockResolvedValue(`${BUILD_KEY}\n`),
    };

    await expect(
      resolvePublicKey({
        privateKeyPath: '/home/joe/.ssh/ogis_tiles',
        publicKeyPath: '/home/joe/.ssh/ogis_tiles.pub',
        label: 'Deploy',
        fsImpl,
        execImpl: makeExec(),
      }),
    ).rejects.toThrow(/does not match the private key/);
  });

  it('aborts with deploy-key instructions when the private key is encrypted or unreadable', async () => {
    const execImpl = vi
      .fn()
      .mockRejectedValue(
        new Error('Load key "/home/joe/.ssh/ogis_tiles": incorrect passphrase supplied'),
      );

    await expect(
      resolvePublicKey({
        privateKeyPath: '/home/joe/.ssh/ogis_tiles',
        publicKeyPath: '/home/joe/.ssh/ogis_tiles.pub',
        label: 'Deploy',
        fsImpl: makeFs(),
        execImpl,
      }),
    ).rejects.toThrow(/unencrypted deploy key.*BatchMode SSH cannot prompt/s);
  });

  it('rejects a hardware-backed sk- public key', async () => {
    const execImpl = vi.fn().mockResolvedValue({
      stdout: 'sk-ssh-ed25519@openssh.com AAAAC3NzaC1lZDI1NTE5AAAAIOexample test\n',
      stderr: '',
    });

    await expect(
      resolvePublicKey({
        privateKeyPath: '/home/joe/.ssh/ogis_tiles',
        publicKeyPath: '/home/joe/.ssh/ogis_tiles.pub',
        label: 'Deploy',
        fsImpl: makeFs(),
        execImpl,
      }),
    ).rejects.toThrow(/hardware-backed/);
  });

  it('rejects private key material', async () => {
    const fsImpl = {
      stat: vi.fn().mockResolvedValue({}),
      readFile: vi.fn().mockResolvedValue('-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n'),
    };

    await expect(
      resolvePublicKey({
        privateKeyPath: '/home/joe/.ssh/ogis_tiles',
        publicKeyPath: '/home/joe/.ssh/ogis_tiles.pub',
        fsImpl,
        execImpl: makeExec(),
      }),
    ).rejects.toThrow(/private key material/);
  });
});

describe('runProvision', () => {
  it('defaults to a dry run and makes no mutating API calls', async () => {
    const client = makeClient();
    const out = makeOut();

    const result = await runProvision(baseRun({ client, out, options: {} }));

    expect(result.dryRun).toBe(true);
    expect(client.findServerByIPv4).toHaveBeenCalledWith('128.140.70.114');
    expect(client.findImageByName).toHaveBeenCalledWith('ubuntu-26.04', 'x86');
    expect(client.rebuildServer).not.toHaveBeenCalled();
    expect(client.changeProtection).not.toHaveBeenCalled();
    expect(client.createSnapshot).not.toHaveBeenCalled();
    expect(client.disableRescue).not.toHaveBeenCalled();
    expect(client.detachIso).not.toHaveBeenCalled();
    expect(out.text()).toContain('dry run');
    expect(out.text()).toContain('Cloud-init');
    expect(out.text()).toContain('Node');
    expect(out.text()).toContain('No changes were made');
  });

  it('requires --yes before a real rebuild and makes no API calls', async () => {
    const client = makeClient();

    await expect(
      runProvision(baseRun({ client, options: { dryRun: false, yes: false } })),
    ).rejects.toThrow(/requires --yes/);

    expect(client.findServerByIPv4).not.toHaveBeenCalled();
  });

  it('rejects conflicting snapshot flags', async () => {
    await expect(
      runProvision(baseRun({ options: { snapshot: true, noSnapshot: true } })),
    ).rejects.toThrow(/cannot be used together/);
  });

  it('maps --yes without --snapshot through the CLI boundary so the snapshot default stays on', async () => {
    expect(provisionRunOptions({ yes: true })).toMatchObject({
      dryRun: false,
      yes: true,
      snapshot: undefined,
      noSnapshot: false,
    });

    const client = makeClient();

    await runProvision(baseRun({ client, options: provisionRunOptions({ yes: true }) }));

    expect(client.createSnapshot).toHaveBeenCalledTimes(1);
  });

  it('maps --no-snapshot through the CLI boundary so it still opts out', async () => {
    const mapping = provisionRunOptions({ yes: true, noSnapshot: true });
    expect(mapping.snapshot).toBeUndefined();
    expect(mapping.noSnapshot).toBe(true);

    const client = makeClient();

    await runProvision(baseRun({ client, options: mapping }));

    expect(client.createSnapshot).not.toHaveBeenCalled();
  });

  it('shows the planned snapshot default separately from the dry-run mutation flag', async () => {
    const client = makeClient();
    const out = makeOut();

    const result = await runProvision(baseRun({ client, out, options: { dryRun: true } }));

    expect(result.snapshot).toBe(false);
    expect(result.snapshotPlanned).toBe(true);
    expect(out.text()).toContain(
      'Snapshot before rebuild: yes (default; a real run would snapshot)',
    );
    expect(out.text()).toContain('Snapshot during this dry run: no (a dry run makes no changes)');
    expect(client.createSnapshot).not.toHaveBeenCalled();
  });

  it('reports --no-snapshot in the dry-run plan', async () => {
    const out = makeOut();

    await runProvision(baseRun({ options: { dryRun: true, noSnapshot: true }, out }));

    expect(out.text()).toContain('Snapshot before rebuild: no (--no-snapshot)');
  });

  it('disables rebuild protection before rebuilding with the rendered cloud-init', async () => {
    const server = makeServer({ protection: { delete: true, rebuild: true } });
    const client = makeClient({ server });
    const out = makeOut();

    const result = await runProvision(
      baseRun({
        client,
        out,
        options: { dryRun: false, yes: true, noSnapshot: true },
      }),
    );

    expect(result.dryRun).toBe(false);
    expect(client.changeProtection).toHaveBeenNthCalledWith(1, 42, {
      delete: false,
      rebuild: false,
    });
    expect(client.changeProtection).toHaveBeenNthCalledWith(2, 42, {
      delete: true,
      rebuild: true,
    });
    expect(client.rebuildServer).toHaveBeenCalledTimes(1);

    const [id, payload] = client.rebuildServer.mock.calls[0];
    expect(id).toBe(42);
    expect(payload.image).toBe(387894169);
    expect(payload.userData.startsWith('#cloud-config\n')).toBe(true);
    expect(payload.userData).not.toContain('PRIVATE KEY');
    expect(client.createSnapshot).not.toHaveBeenCalled();
    expect(out.text()).toContain('Disabling both rebuild and delete protection');
  });

  it('creates a snapshot by default for a real rebuild', async () => {
    const client = makeClient();

    await runProvision(
      baseRun({
        client,
        options: { dryRun: false, yes: true },
      }),
    );

    expect(client.createSnapshot).toHaveBeenCalledTimes(1);
    expect(client.createSnapshot.mock.calls[0][0]).toBe(42);
    expect(client.createSnapshot.mock.calls[0][1]).toMatch(/^pre-rebuild /);
  });

  it('skips the snapshot when --no-snapshot is explicit', async () => {
    const client = makeClient();

    await runProvision(
      baseRun({
        client,
        options: { dryRun: false, yes: true, noSnapshot: true },
      }),
    );

    expect(client.createSnapshot).not.toHaveBeenCalled();
  });

  it('never snapshots during a dry run', async () => {
    const client = makeClient();

    const result = await runProvision(
      baseRun({
        client,
        options: { dryRun: true, snapshot: true },
      }),
    );

    expect(result.snapshot).toBe(false);
    expect(client.createSnapshot).not.toHaveBeenCalled();
  });

  it('clears rescue mode and a mounted ISO before rebuilding', async () => {
    const server = makeServer({
      rescue_enabled: true,
      iso: { name: 'ubuntu-26.04-live-server-amd64.iso' },
    });
    const client = makeClient({ server });

    await runProvision(
      baseRun({
        client,
        options: { dryRun: false, yes: true },
      }),
    );

    expect(client.disableRescue).toHaveBeenCalledWith(42);
    expect(client.detachIso).toHaveBeenCalledWith(42);
  });

  it('waits for pending server actions first', async () => {
    const client = makeClient();
    client.listServerActions.mockResolvedValue([
      { id: 21, status: 'running' },
      { id: 22, status: 'running' },
    ]);

    await runProvision(
      baseRun({
        client,
        options: { dryRun: false, yes: true },
      }),
    );

    expect(client.waitForAction).toHaveBeenCalledWith(21, expect.any(Object));
    expect(client.waitForAction).toHaveBeenCalledWith(22, expect.any(Object));
  });

  it('verifies the retained IPv4 address after the rebuild', async () => {
    const server = makeServer();
    const after = makeServer({
      public_net: {
        ipv4: { ip: '192.0.2.99' },
        ipv6: { ip: '2a01:4f8:1:2::/64' },
      },
    });

    await expect(
      runProvision(
        baseRun({
          client: makeClient({ server, after }),
          options: { dryRun: false, yes: true },
        }),
      ),
    ).rejects.toThrow(/changed the IPv4 address/);
  });

  it('rejects a server type that does not match the configured type', async () => {
    const client = makeClient({ server: makeServer({ server_type: { name: 'cx22' } }) });

    await expect(runProvision(baseRun({ client, options: {} }))).rejects.toThrow(/expected cx23/);
    expect(client.rebuildServer).not.toHaveBeenCalled();
  });

  it('rejects an IPv4 address that does not match the server', async () => {
    const client = makeClient({
      server: makeServer({
        public_net: { ipv4: { ip: '192.0.2.1' }, ipv6: { ip: '2a01:4f8:1:2::/64' } },
      }),
    });

    await expect(runProvision(baseRun({ client, options: {} }))).rejects.toThrow(
      /expected 128.140.70.114/,
    );
  });

  it('rejects DNS that does not include the configured IP', async () => {
    await expect(
      runProvision(
        baseRun({
          dnsImpl: dnsFor(['192.0.2.1']),
          options: {},
        }),
      ),
    ).rejects.toThrow(/does not include 128.140.70.114/);
  });

  it('waits for SSH, runs cloud-init to completion and verifies Ubuntu 26.04', async () => {
    const client = makeClient();
    const execImpl = makeExec({ sshFailures: 2 });
    let clock = 0;

    await runProvision(
      baseRun({
        client,
        execImpl,
        options: {
          dryRun: false,
          yes: true,
          sshTimeoutMs: 10_000,
          sshIntervalMs: 1_000,
        },
        now: () => clock,
        sleep: async () => {
          clock += 1_000;
        },
      }),
    );

    const sshCalls = execImpl.mock.calls.filter(([command]) => command === 'ssh');
    const connectionAttempts = sshCalls.filter(([, args]) => args[args.length - 1] === 'true');
    expect(connectionAttempts).toHaveLength(3);
    expect(connectionAttempts[0][1]).toEqual([
      '-i',
      '/home/joe/.ssh/ogis_tiles',
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
      'root@128.140.70.114',
      'true',
    ]);
    expect(sshCalls.some(([, args]) => args[args.length - 1] === 'cloud-init status --wait')).toBe(
      true,
    );
    expect(sshCalls.some(([, args]) => args[args.length - 1] === 'cat /etc/os-release')).toBe(true);

    const cloudInitCall = sshCalls.find(
      ([, args]) => args[args.length - 1] === 'cloud-init status --wait',
    );
    const osReleaseCall = sshCalls.find(
      ([, args]) => args[args.length - 1] === 'cat /etc/os-release',
    );
    expect(cloudInitCall[2]).toMatchObject({ timeoutMs: 900_000 });
    expect(osReleaseCall[2]).toMatchObject({ timeoutMs: 60_000 });
    expect(execImpl).toHaveBeenCalledWith('ssh-keygen', ['-R', 'tile.ogis.app'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: '/home/joe', TERM: 'xterm' },
      timeoutMs: 60_000,
    });
    expect(execImpl).toHaveBeenCalledWith('ssh-keygen', ['-R', '128.140.70.114'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: '/home/joe', TERM: 'xterm' },
      timeoutMs: 60_000,
    });

    const credentialCalls = execImpl.mock.calls.filter(
      ([command]) => command === 'ssh' || command === 'ssh-keygen',
    );
    for (const [, , options] of credentialCalls) {
      expect(options.env).not.toHaveProperty('HCLOUD_TOKEN');
    }
  });

  it('fails when the rebuilt host is not Ubuntu 26.04', async () => {
    await expect(
      runProvision(
        baseRun({
          execImpl: makeExec({ osRelease: 'ID=debian\nVERSION_ID="12"\n' }),
          options: { dryRun: false, yes: true },
        }),
      ),
    ).rejects.toThrow(/expected Ubuntu 26.04/);
  });

  it('fails clearly when SSH never becomes available', async () => {
    let clock = 0;

    await expect(
      runProvision(
        baseRun({
          execImpl: makeExec({ sshFailures: 10 }),
          options: {
            dryRun: false,
            yes: true,
            sshTimeoutMs: 2_000,
            sshIntervalMs: 1_000,
          },
          now: () => clock,
          sleep: async () => {
            clock += 1_000;
          },
        }),
      ),
    ).rejects.toThrow(/SSH did not become available/);
  });

  it('refuses to rebuild a server without a public IPv4 address', async () => {
    const server = makeServer({ public_net: { ipv6: { ip: '2a01:4f8:1:2::/64' } } });
    const client = makeClient({ server });

    await expect(
      runProvision(baseRun({ client, options: { server: 'ogis-tiles' } })),
    ).rejects.toThrow(/no public IPv4 address/);
    expect(client.rebuildServer).not.toHaveBeenCalled();
  });

  it('does not touch protection when the server was already unprotected', async () => {
    const client = makeClient({
      server: makeServer({ protection: { delete: false, rebuild: false } }),
    });

    await runProvision(
      baseRun({ client, options: { dryRun: false, yes: true, noSnapshot: true } }),
    );

    expect(client.changeProtection).not.toHaveBeenCalled();
  });

  it('restores protection after a failed rebuild', async () => {
    const server = makeServer({ protection: { delete: true, rebuild: true } });
    const client = makeClient({ server });
    client.rebuildServer.mockRejectedValue(new Error('rebuild API exploded'));

    await expect(
      runProvision(baseRun({ client, options: { dryRun: false, yes: true, noSnapshot: true } })),
    ).rejects.toThrow(/rebuild API exploded/);

    expect(client.changeProtection).toHaveBeenNthCalledWith(1, 42, {
      delete: false,
      rebuild: false,
    });
    expect(client.changeProtection).toHaveBeenNthCalledWith(2, 42, {
      delete: true,
      rebuild: true,
    });
  });

  it('fails the provision when protection restoration fails after a successful rebuild', async () => {
    const server = makeServer({ protection: { delete: false, rebuild: true } });
    const client = makeClient({ server });
    const out = makeOut();
    const err = makeOut();
    client.changeProtection = vi
      .fn()
      .mockResolvedValueOnce({ id: 3, status: 'running' })
      .mockRejectedValueOnce(new Error('restore denied'));

    await expect(
      runProvision(
        baseRun({ client, out, err, options: { dryRun: false, yes: true, noSnapshot: true } }),
      ),
    ).rejects.toThrow(/restore denied/);

    expect(client.changeProtection).toHaveBeenNthCalledWith(1, 42, {
      delete: false,
      rebuild: false,
    });
    expect(client.changeProtection).toHaveBeenNthCalledWith(2, 42, {
      delete: false,
      rebuild: true,
    });
    expect(err.text()).toContain('Unable to restore protection');
    expect(err.text()).toContain('server may be left unprotected');
    expect(out.text()).not.toContain('Provisioned ');
  });

  it('preserves the original failure when protection restoration also fails', async () => {
    const server = makeServer({ protection: { delete: true, rebuild: true } });
    const client = makeClient({ server });
    const err = makeOut();
    client.rebuildServer.mockRejectedValue(new Error('rebuild API exploded'));
    client.changeProtection = vi
      .fn()
      .mockResolvedValueOnce({ id: 3, status: 'running' })
      .mockRejectedValueOnce(new Error('restore denied'));

    await expect(
      runProvision(
        baseRun({ client, err, options: { dryRun: false, yes: true, noSnapshot: true } }),
      ),
    ).rejects.toThrow(/rebuild API exploded/);

    expect(err.text()).toMatch(/unable to restore protection/i);
  });

  it('warns that the server state is unknown when the rebuild request times out', async () => {
    const client = makeClient();
    const err = makeOut();
    client.listServerActions = vi.fn(async (id, options = {}) =>
      options.status === 'running' ? [] : [{ id: 77, command: 'rebuild', status: 'running' }],
    );
    client.rebuildServer.mockRejectedValue(
      new Error('Hetzner Cloud request timed out after 30000ms (POST /servers/42/actions/rebuild)'),
    );

    await expect(
      runProvision(
        baseRun({ client, err, options: { dryRun: false, yes: true, noSnapshot: true } }),
      ),
    ).rejects.toThrow(/server state is unknown, check the server/i);

    expect(client.listServerActions).toHaveBeenCalledWith(42);
    expect(err.text()).toContain('Warning:');
    expect(err.text()).toContain('check the server');
    expect(err.text()).toContain('rebuild (running) #77');
  });

  it('rejects identical deploy and build public keys', async () => {
    const fsImpl = makeFs({
      missing: ['/home/joe/.ssh/ogis_tiles.pub', '/home/joe/.ssh/ogis_tiles_build.pub'],
    });
    const execImpl = makeExec({ buildKey: DEPLOY_KEY });

    await expect(
      runProvision(baseRun({ fsImpl, execImpl, options: { dryRun: true } })),
    ).rejects.toThrow(/different SSH key material/);
  });

  it('refuses an image whose architecture is not x86', async () => {
    const client = makeClient({
      image: {
        id: 1,
        name: 'ubuntu-26.04',
        type: 'system',
        architecture: 'arm',
        status: 'available',
      },
    });

    await expect(runProvision(baseRun({ client, options: {} }))).rejects.toThrow(
      /only x86 is supported/,
    );
    expect(client.rebuildServer).not.toHaveBeenCalled();
  });

  it('refuses when no exact image matches', async () => {
    const client = makeClient();
    client.findImageByName.mockResolvedValue(null);

    await expect(runProvision(baseRun({ client, options: {} }))).rejects.toThrow(
      /No available x86 system image/,
    );
    expect(client.rebuildServer).not.toHaveBeenCalled();
  });

  it('rejects a server in a different location', async () => {
    const client = makeClient({
      server: makeServer({ location: { name: 'fsn1' } }),
    });

    await expect(runProvision(baseRun({ client, options: {} }))).rejects.toThrow(/expected nbg1/);
  });

  it('rejects a server in a different location using the legacy datacenter shape', async () => {
    const server = makeServer({ datacenter: { location: { name: 'fsn1' } } });
    delete server.location;
    const client = makeClient({ server });

    await expect(runProvision(baseRun({ client, options: {} }))).rejects.toThrow(/expected nbg1/);
  });

  it('accepts a server location from the legacy datacenter shape', async () => {
    const server = makeServer();
    delete server.location;
    const client = makeClient({ server });

    await expect(
      runProvision(baseRun({ client, options: { dryRun: true } })),
    ).resolves.toBeDefined();
  });

  it('accepts a server location from the top-level location shape', async () => {
    const client = makeClient({
      server: makeServer({ datacenter: undefined }),
    });

    await expect(
      runProvision(baseRun({ client, options: { dryRun: true } })),
    ).resolves.toBeDefined();
  });

  it('rejects a non-x86 server architecture', async () => {
    const client = makeClient({
      server: makeServer({ server_type: { name: 'cx23', architecture: 'arm' } }),
    });

    await expect(runProvision(baseRun({ client, options: {} }))).rejects.toThrow(
      /only x86 is supported/,
    );
  });

  it('enables fail2ban only after SSH has been verified', async () => {
    const client = makeClient();
    const execImpl = makeExec();

    await runProvision(
      baseRun({ client, execImpl, options: { dryRun: false, yes: true, noSnapshot: true } }),
    );

    const sshCalls = execImpl.mock.calls.filter(([command]) => command === 'ssh');
    const firstCheck = sshCalls.findIndex(([, args]) => args[args.length - 1] === 'true');
    const fail2ban = sshCalls.findIndex(([, args]) =>
      String(args[args.length - 1]).includes('systemctl enable --now fail2ban'),
    );

    expect(firstCheck).toBeGreaterThanOrEqual(0);
    expect(fail2ban).toBeGreaterThan(firstCheck);

    const fail2banCommand = sshCalls[fail2ban][1][sshCalls[fail2ban][1].length - 1];
    expect(fail2banCommand).toContain('apt-get update -o DPkg::Lock::Timeout=120');
    expect(fail2banCommand).toContain('apt-get install -y -o DPkg::Lock::Timeout=120 fail2ban');
    expect(fail2banCommand).toContain('systemctl enable --now fail2ban');

    const userData = client.rebuildServer.mock.calls[0][1].userData;
    expect(userData).not.toContain('systemctl enable --now fail2ban');
    expect(userData).toContain('[sshd]');
  });

  it('bounds cloud-init waiting so a hung boot cannot hang provisioning', async () => {
    const baseExec = makeExec();
    const execImpl = vi.fn((command, args, options) => {
      if (command === 'ssh' && args[args.length - 1] === 'cloud-init status --wait') {
        return new Promise(() => {});
      }

      return baseExec(command, args, options);
    });

    await expect(
      runProvision(
        baseRun({
          execImpl,
          options: {
            dryRun: false,
            yes: true,
            noSnapshot: true,
            cloudInitTimeoutMs: 20,
          },
        }),
      ),
    ).rejects.toThrow(/cloud-init status --wait timed out after 20ms/);
  });

  it('honours a host override in the rendered cloud-config and DNS check', async () => {
    const out = makeOut();
    const dnsImpl = dnsFor(['128.140.70.114']);

    await runProvision(
      baseRun({
        out,
        dnsImpl,
        options: { dryRun: true, host: 'tiles.example.com' },
      }),
    );

    expect(dnsImpl.resolve4).toHaveBeenCalledWith('tiles.example.com');
    expect(out.text()).toContain('tiles.example.com');
  });
});

describe('runStatus', () => {
  it('prints server state and a health check without mutating anything', async () => {
    const client = makeClient();
    const out = makeOut();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const result = await runStatus({
      config: baseConfig(),
      client,
      dnsImpl: dnsFor(),
      out,
      fetchImpl,
    });

    expect(result.health).toEqual({
      url: 'https://tile.ogis.app/health',
      status: 200,
      ok: true,
    });
    expect(out.text()).toContain('IPv4: 128.140.70.114');
    expect(out.text()).toContain('Type: cx23');
    expect(out.text()).toContain('Location: nbg1');
    expect(out.text()).toContain('Protection: delete=false rebuild=false');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://tile.ogis.app/health',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
    expect(client.rebuildServer).not.toHaveBeenCalled();
    expect(client.changeProtection).not.toHaveBeenCalled();
  });

  it('prints the location from the legacy datacenter shape', async () => {
    const server = makeServer();
    delete server.location;
    const client = makeClient({ server });
    const out = makeOut();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    await runStatus({
      config: baseConfig(),
      client,
      dnsImpl: dnsFor(),
      out,
      fetchImpl,
    });

    expect(out.text()).toContain('Location: nbg1');
  });

  it('runs from a minimal status environment without SSH keys', async () => {
    const config = resolveConfig({
      env: {
        HCLOUD_TOKEN: 'test-token',
        TILE_SERVER_HOST: 'tile.ogis.app',
      },
    });
    const client = makeClient();
    const out = makeOut();
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    await runStatus({
      config,
      client,
      dnsImpl: dnsFor(),
      out,
      fetchImpl,
    });

    expect(out.text()).toContain('Server: ogis-tiles (#42)');
    expect(client.rebuildServer).not.toHaveBeenCalled();
  });
});
