import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import {
  BUILD_BOX_DATA_DIR,
  BUILD_BOX_DISK_FILTERED_BYTES,
  BUILD_BOX_DISK_UNFILTERED_BYTES,
  BUILD_BOX_INCOMING_DIR,
  BUILD_BOX_KEY_REMOVAL_TIMEOUT_MS,
  BUILD_BOX_READY_COMMAND,
  BUILD_BOX_SIGNAL_DESTROY_TIMEOUT_MS,
  BUILD_BOX_SIGNAL_KEY_TIMEOUT_MS,
  BUILD_BOX_SIGNAL_LOG_TIMEOUT_MS,
  BUILD_BOX_TIMEOUT_MS,
  BUILD_BOX_TRANSFER_TIMEOUT_MS,
  DESTINATION_MIN_FREE_BYTES,
  assertDestinationDisk,
  assertRemoteInputPath,
  cleanupInterruptedBuild,
  destinationDiskCommand,
  diskSpaceCommand,
  installBuildKeyCommand,
  installRemoteBuildSignalGuard,
  npmCiCommand,
  parseAvailableBytes,
  parseDestinationDisk,
  preflightBuildKey,
  preflightRsyncPlan,
  remoteBuildCommand,
  repositorySyncArguments,
  requiredDiskBytes,
  resolveDestinationDataDir,
  resolveDestinationIncomingDir,
  resolveDestinationMinFreeBytes,
  resolveRemotePlanetPin,
  runRemoteBuild,
  selectBuildSources,
  supportsRsyncMkpath,
  transferSourceCommand,
} from '../../../src/build/remote.mjs';
import { detectRsync } from '../../../src/deploy/rsync.mjs';
import { repoRoot } from '../../helpers/temp.mjs';

const runCli = promisify(execFile);
const cliPath = path.join(repoRoot, 'bin', 'ogis.mjs');

const DEPLOY_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOdeployKeyExample deploy@example';
const BUILD_KEY_MATERIAL =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-build-key\n-----END OPENSSH PRIVATE KEY-----\n';
const SHA256 = 'a'.repeat(64);

const ENV = {
  HCLOUD_TOKEN: 'test-token',
  TILE_SERVER_HOST: 'tile.ogis.app',
  TILE_SERVER_IP: '128.140.70.114',
  SSH_PRIVATE_KEY_PATH: '/keys/ogis_tiles',
  SSH_PUBLIC_KEY_PATH: '/keys/ogis_tiles.pub',
  BUILD_SSH_PRIVATE_KEY_PATH: '/keys/ogis_tiles_build',
  BUILD_SSH_PUBLIC_KEY_PATH: '/keys/ogis_tiles_build.pub',
  DEPLOY_USER: 'deploy',
  BUILD_USER: 'build',
};

const SERVER = {
  id: 42,
  name: 'ogis-build-test',
  status: 'running',
  public_net: { ipv4: { ip: '192.0.2.10' } },
  labels: { 'managed-by': 'ogis-tiles', role: 'build-box' },
};
const DISK_OUTPUT = `${700 * 1024 ** 3}\n`;
const DESTINATION_DISK_OUTPUT = `${40 * 1024 ** 3} ${30 * 1024 ** 3}\n`;
const PLANET_ENV = {
  PLANET_URL: 'https://planet.example/2026-10-29.osm.pbf',
  PLANET_DATE: '2026-10-29',
  PLANET_SHA256: SHA256,
};

function destinationDiskResponse(output = DESTINATION_DISK_OUTPUT) {
  return { stdout: output, stderr: '' };
}

function diskResponse(output = DISK_OUTPUT) {
  return { stdout: output, stderr: '' };
}

function notFound() {
  const error = new Error('not found');
  error.status = 404;
  return error;
}

function makeWriter() {
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

function fakeClient() {
  let deleted = false;

  return {
    findImageByName: vi.fn(async () => ({
      id: 7,
      name: 'ubuntu-26.04',
      architecture: 'x86',
      type: 'system',
      status: 'available',
    })),
    listSshKeys: vi.fn(async () => []),
    createSshKey: vi.fn(async ({ name, publicKey }) => ({ id: 99, name, public_key: publicKey })),
    createServer: vi.fn(async () => ({
      server: SERVER,
      action: { id: 1, status: 'running' },
    })),
    waitForAction: vi.fn(async () => ({ id: 1, status: 'success' })),
    getServer: vi.fn(async () => {
      if (deleted) {
        throw notFound();
      }

      return SERVER;
    }),
    deleteServer: vi.fn(async () => {
      deleted = true;
      return { id: 2, status: 'running' };
    }),
    findServerByName: vi.fn(async () => null),
  };
}

function sshCommands(execImpl) {
  return execImpl.mock.calls
    .filter(([command]) => command === 'ssh')
    .map(([, args]) => args.at(-1));
}

function baseOptions(overrides = {}) {
  return {
    yes: true,
    only: 'pois',
    fixture: 'test/fixtures/alberta-canmore.osm.pbf',
    ...overrides,
  };
}

function makeConfig() {
  return {
    build: { planet: { url: '', date: '', sha256: '' } },
    sources: { pois: { profile: 'pois' } },
  };
}

async function run({
  client = fakeClient(),
  execImpl,
  options = baseOptions(),
  env = ENV,
  fsImpl,
  out: outImpl,
  err: errImpl,
} = {}) {
  const out = outImpl ?? { write: vi.fn() };
  const err = errImpl ?? { write: vi.fn() };
  const exec =
    execImpl ??
    vi.fn(async (command, args) => {
      if (command === 'ssh' && args.at(-1).includes('df -B1 --output=size,avail')) {
        return destinationDiskResponse();
      }

      if (command === 'ssh' && args.at(-1).includes('df -B1')) {
        return diskResponse();
      }

      return { stdout: '', stderr: '' };
    });
  const result = await runRemoteBuild({
    repoRoot,
    configPath: 'config/layers.json',
    options,
    env,
    client,
    execImpl: exec,
    fsImpl,
    out,
    err,
    publicKey: DEPLOY_KEY,
    buildPublicKey: DEPLOY_KEY,
    buildKeyMaterial: BUILD_KEY_MATERIAL,
    rsyncInfo: { command: '/usr/bin/rsync', protectArgs: true, version: '3.2.7' },
    now: () => Date.UTC(2026, 9, 31, 12, 0, 0),
  });

  return { result, client, exec, out, err };
}

describe('build CLI', () => {
  it('rejects remote-only flags without --remote', async () => {
    await expect(
      runCli(process.execPath, [cliPath, 'build', '--dry-run'], { cwd: repoRoot }),
    ).rejects.toThrow(/--dry-run requires --remote/);
  });

  it('documents the remote flags in --help', async () => {
    const { stdout } = await runCli(process.execPath, [cliPath, 'build', '--remote', '--help'], {
      cwd: repoRoot,
    });

    expect(stdout).toContain('--remote');
    expect(stdout).toContain('--keep-build-box');
    expect(stdout).toContain('--build-server-type');
  });

  it('rejects empty value flags before remote-only checks', async () => {
    for (const flag of [
      '--fixture=',
      '--only=',
      '--build-server-type=',
      '--build-location=',
      '--build-image=',
      '--build-name=',
      '--archive=',
      '--planet-url=',
      '--output-dir=',
    ]) {
      await expect(
        runCli(process.execPath, [cliPath, 'build', flag], { cwd: repoRoot }),
      ).rejects.toThrow(/requires a non-empty value/);
    }
  });
});

describe('remoteBuildCommand', () => {
  it('forwards fixture, source and output flags to the remote pipeline', () => {
    const command = remoteBuildCommand({
      appDir: '/opt/ogis-tiles',
      configPath: 'config/layers.json',
      outputDir: 'dist',
      options: {
        only: 'pois,routes',
        fixture: 'test/fixtures/alberta-canmore.osm.pbf',
        skipVerify: true,
      },
    });

    expect(command).toContain("cd '/opt/ogis-tiles'");
    expect(command).toContain("--output-dir='dist'");
    expect(command).toContain("--only='pois,routes'");
    expect(command).toContain("--fixture='test/fixtures/alberta-canmore.osm.pbf'");
    expect(command).toContain('--skip-verify');
    expect(command).toContain("tee '/opt/ogis-tiles/tmp/remote-build.log'");
    expect(command).not.toContain('CONFIG_PATH=');
  });

  it('forwards planet URL, date and checksum and a custom config path', () => {
    const command = remoteBuildCommand({
      configPath: 'config/custom.json',
      options: {
        planetUrl: 'https://planet.example/osm.pbf',
        planetDate: '2026-01-02',
        planetSha256: SHA256,
        skipDownload: true,
        force: false,
      },
    });

    expect(command).toContain("CONFIG_PATH='config/custom.json'");
    expect(command).toContain("--planet-url='https://planet.example/osm.pbf'");
    expect(command).toContain("--planet-date='2026-01-02'");
    expect(command).toContain(`--planet-sha256='${SHA256}'`);
    expect(command).toContain('--skip-download');
    expect(command).not.toContain('--force');
  });

  it('forwards a non-empty PLANET_BUILD_HEAP and drops an empty value', () => {
    const withHeap = remoteBuildCommand({ options: {}, planetBuildHeap: '8g' });
    const withoutHeap = remoteBuildCommand({ options: {}, planetBuildHeap: '  ' });

    expect(withHeap).toContain("PLANET_BUILD_HEAP='8g'");
    expect(withoutHeap).not.toContain('PLANET_BUILD_HEAP=');
  });
});

describe('repositorySyncArguments', () => {
  it('excludes data, dependencies, work, output, git and secrets', () => {
    const args = repositorySyncArguments({
      repoRoot: '/repo',
      appDir: '/opt/ogis-tiles',
      boxConfig: {
        deployUser: 'deploy',
        targetHost: '192.0.2.10',
        deployPrivateKeyPath: '/keys/deploy',
      },
      rsync: { command: '/usr/bin/rsync', protectArgs: true },
    });

    for (const exclude of [
      '--exclude=/data/',
      '--exclude=/node_modules/',
      '--exclude=/tmp/',
      '--exclude=/dist/',
      '--exclude=/.git/',
      '--exclude=.env*',
    ]) {
      expect(args).toContain(exclude);
    }

    expect(args).toContain('--protect-args');
    expect(args.at(-1)).toBe('deploy@192.0.2.10:/opt/ogis-tiles/');
  });
});

const RRSYNC_WRITE_ONLY_OPTIONS = new Set([
  '--archive',
  '--compress',
  '--delay-updates',
  '--mkpath',
  '--delete',
  '--include',
  '--exclude',
]);

function rsyncOptions(command) {
  return command.match(/--[a-z][a-z-]*/g) ?? [];
}

describe('transferSourceCommand', () => {
  it('copies the archive pair to the incoming directory with the build key', () => {
    const command = transferSourceCommand({
      appDir: '/opt/ogis-tiles',
      outputDir: 'dist',
      source: 'pois',
      targetHost: 'tile.ogis.app',
      buildUser: 'build',
      keyPath: '/home/deploy/.ssh/ogis-tiles-build',
    });

    expect(command).toContain('current.pmtiles');
    expect(command).toContain('build.json');
    expect(command).toContain('/home/deploy/.ssh/ogis-tiles-build');
    expect(command).toContain('build@tile.ogis.app:pois/');
    expect(command).toContain('--delay-updates');
    expect(command).toContain('build@tile.ogis.app:pois/.ogis-write-probe');
  });

  it('does not send --protect-args through the restricted rrsync key', () => {
    const command = transferSourceCommand({
      source: 'pois',
      targetHost: 'tile.ogis.app',
      keyPath: '/home/deploy/.ssh/ogis-tiles-build',
    });

    expect(command).not.toContain('--protect-args');
    expect(command).not.toMatch(/(?:^|\s)-[a-z]*s[a-z]*(?:\s|$)/);
  });

  it('uses only options accepted by rrsync -wo', () => {
    const command = transferSourceCommand({
      source: 'pois',
      targetHost: 'tile.ogis.app',
      keyPath: '/home/deploy/.ssh/ogis-tiles-build',
    });

    for (const option of rsyncOptions(command)) {
      expect(RRSYNC_WRITE_ONLY_OPTIONS.has(option), `unexpected rsync option ${option}`).toBe(true);
    }
  });

  it('removes the write-probe from the incoming directory after the probe', () => {
    const command = transferSourceCommand({
      source: 'pois',
      targetHost: 'tile.ogis.app',
      keyPath: '/home/deploy/.ssh/ogis-tiles-build',
    });

    expect(command).toContain('--delete');
    expect(command).toContain("--include='/.ogis-write-probe'");
    expect(command).toContain('rmdir "$empty"');
    expect(command).not.toContain('--delete-excluded');
  });

  it('clears the old incoming pair before the delayed final transfer', () => {
    const command = transferSourceCommand({
      source: 'pois',
      targetHost: 'tile.ogis.app',
      keyPath: '/home/deploy/.ssh/ogis-tiles-build',
    });
    const clearIndex = command.indexOf("--archive --delete --include='/current.pmtiles'");
    const transferIndex = command.indexOf('--delay-updates');

    expect(clearIndex).toBeGreaterThan(-1);
    expect(command).toContain("--include='/build.json'");
    expect(clearIndex).toBeLessThan(transferIndex);
  });

  it('rejects unsafe source, user, host and key arguments', () => {
    const valid = {
      source: 'pois',
      targetHost: 'tile.ogis.app',
      buildUser: 'build',
      keyPath: '/home/deploy/.ssh/ogis-tiles-build',
    };

    expect(() => transferSourceCommand({ ...valid, source: 'bad source' })).toThrow(
      /valid source name/,
    );
    expect(() => transferSourceCommand({ ...valid, buildUser: 'bad user' })).toThrow(
      /valid Linux user name/,
    );
    expect(() => transferSourceCommand({ ...valid, targetHost: 'bad host; rm -rf /' })).toThrow(
      /valid host name/,
    );
    expect(() => transferSourceCommand({ ...valid, keyPath: 'relative/key' })).toThrow(
      /safe absolute build private key path/,
    );
  });
});

describe('installBuildKeyCommand', () => {
  it('moves a previously uploaded key into place with owner-only permissions', () => {
    const command = installBuildKeyCommand({
      keyPath: '/home/deploy/.ssh/ogis-tiles-build',
    });

    expect(command).toContain('/home/deploy/.ssh/ogis-tiles-build');
    expect(command).toContain('/home/deploy/.ssh/ogis-tiles-build.tmp');
    expect(command).toContain('chmod 0600');
    expect(command).toContain('mv -f');
    expect(command).not.toContain('base64 -d');
    expect(command).not.toContain('secret-build-key');
  });

  it('never accepts key material in the command', () => {
    expect(() =>
      installBuildKeyCommand({
        keyPath: 'relative/key',
      }),
    ).toThrow(/absolute safe path/);
  });
});

describe('disk preflight', () => {
  it('reports the free space in the build box tmp directory', () => {
    const command = diskSpaceCommand({ appDir: '/opt/ogis-tiles' });

    expect(command).toContain("mkdir -p '/opt/ogis-tiles/tmp'");
    expect(command).toContain("df -B1 --output=avail '/opt/ogis-tiles/tmp'");
  });

  it('parses df output and derives the required space', () => {
    expect(parseAvailableBytes(`${640 * 1024 ** 3}\n`)).toBe(640 * 1024 ** 3);
    expect(() => parseAvailableBytes('')).toThrow(/free disk space/);
    expect(requiredDiskBytes({ fixture: 'x.pbf' })).toBeLessThan(BUILD_BOX_DISK_FILTERED_BYTES);
    expect(requiredDiskBytes({})).toBe(BUILD_BOX_DISK_FILTERED_BYTES);
    expect(requiredDiskBytes({ skipFilter: true })).toBe(BUILD_BOX_DISK_UNFILTERED_BYTES);
  });

  it('rejects inputs under synced-excluded paths at any depth', () => {
    for (const relative of [
      'tmp/planet.osm.pbf',
      'data/planet.osm.pbf',
      'dist/archive.pmtiles',
      '.env',
      '.env.local',
      'config/.env.local',
      'test/fixtures/.env.production',
      'node_modules/x',
    ]) {
      expect(() => assertRemoteInputPath(relative, '--fixture')).toThrow(/excluded/);
    }

    expect(assertRemoteInputPath('test/fixtures/x.osm.pbf', '--fixture')).toBe(
      'test/fixtures/x.osm.pbf',
    );
  });

  it('parses destination capacity and aborts below the free-space threshold', () => {
    expect(parseDestinationDisk(`${40 * 1024 ** 3} ${30 * 1024 ** 3}\n`)).toEqual({
      sizeBytes: 40 * 1024 ** 3,
      availableBytes: 30 * 1024 ** 3,
      usedPercent: 25,
    });
    expect(parseDestinationDisk(`${30 * 1024 ** 3}\n`)).toEqual({
      sizeBytes: null,
      availableBytes: 30 * 1024 ** 3,
      usedPercent: null,
    });
    expect(() => parseDestinationDisk('')).toThrow(/tile server/);

    expect(() =>
      assertDestinationDisk({
        availableBytes: 4 * 1024 ** 3,
        minFreeBytes: DESTINATION_MIN_FREE_BYTES,
      }),
    ).toThrow(/has 4\.0 GiB free but at least 8\.0 GiB/);
  });

  it('warns about CX23 capacity from 70% instead of resizing', () => {
    const warn = vi.fn();
    const result = assertDestinationDisk({
      sizeBytes: 40 * 1024 ** 3,
      availableBytes: 8 * 1024 ** 3,
      usedPercent: 80,
      warn,
    });

    expect(result).toMatchObject({ usedPercent: 80 });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/CX23.*40 GB.*CX33.*never resize/));
  });

  it('builds the destination disk command with the configured data directory', () => {
    const command = destinationDiskCommand({ dataDir: '/srv/ogis-tiles/data' });

    expect(command).toContain("df -B1 --output=size,avail '/srv/ogis-tiles/data'");
    expect(() => destinationDiskCommand({ dataDir: 'relative/data' })).toThrow(/absolute path/);
  });

  it('reads a configurable destination free-space threshold', () => {
    expect(resolveDestinationMinFreeBytes({ env: {} })).toBe(DESTINATION_MIN_FREE_BYTES);
    expect(
      resolveDestinationMinFreeBytes({ env: { BUILD_DESTINATION_MIN_FREE_BYTES: '1073741824' } }),
    ).toBe(1024 ** 3);
    expect(() =>
      resolveDestinationMinFreeBytes({ env: { BUILD_DESTINATION_MIN_FREE_BYTES: '8GiB' } }),
    ).toThrow(/BUILD_DESTINATION_MIN_FREE_BYTES/);
  });

  it('derives the destination directories from the provisioned rrsync root', () => {
    expect(resolveDestinationDataDir({ env: {} })).toBe(BUILD_BOX_DATA_DIR);
    expect(resolveDestinationIncomingDir({ env: {} })).toBe(BUILD_BOX_INCOMING_DIR);
    expect(
      resolveDestinationIncomingDir({
        env: { TILE_DATA_DIR: BUILD_BOX_DATA_DIR, TILE_INCOMING_DIR: BUILD_BOX_INCOMING_DIR },
      }),
    ).toBe(BUILD_BOX_INCOMING_DIR);
  });

  it('rejects a TILE_DATA_DIR or TILE_INCOMING_DIR that disagrees with the build key', () => {
    expect(() => resolveDestinationDataDir({ env: { TILE_DATA_DIR: '/srv/tiles' } })).toThrow(
      /Tile server data directory "\/srv\/tiles" must be/,
    );
    expect(() => resolveDestinationIncomingDir({ env: { TILE_DATA_DIR: '/srv/tiles' } })).toThrow(
      /Tile server data directory "\/srv\/tiles" must be/,
    );
    expect(() =>
      resolveDestinationIncomingDir({ env: { TILE_INCOMING_DIR: '/srv/tiles/incoming' } }),
    ).toThrow(/TILE_INCOMING_DIR "\/srv\/tiles\/incoming" must be/);
  });
});

describe('build-key preflight rsync compatibility', () => {
  it('uses the openrsync fallback and probes the rrsync root without --mkpath', async () => {
    const execImpl = vi.fn(async (command, args) => {
      if (args.includes('--version')) {
        return {
          stdout: 'openrsync: protocol version 29\nrsync version 2.6.9 compatible flags\n',
          stderr: '',
        };
      }

      return { stdout: '', stderr: '' };
    });

    const rsync = await detectRsync({ execImpl, candidates: ['/usr/bin/rsync'] });

    expect(rsync).toMatchObject({
      command: '/usr/bin/rsync',
      openrsync: true,
      compatible: false,
      protectArgs: false,
    });
    expect(supportsRsyncMkpath(rsync)).toBe(false);
    expect(
      preflightRsyncPlan({
        targetHost: 'tile.ogis.app',
        buildUser: 'build',
        source: 'pois',
        rsync,
      }),
    ).toMatchObject({
      destination: 'build@tile.ogis.app:./',
      marker: 'build@tile.ogis.app:.ogis-preflight-probe',
      mkpath: false,
    });

    await preflightBuildKey({
      repoRoot,
      targetHost: 'tile.ogis.app',
      buildUser: 'build',
      source: 'pois',
      keyPath: '/keys/ogis_tiles_build',
      execImpl,
      env: {},
      rsync,
      err: makeWriter(),
    });

    const probeCalls = execImpl.mock.calls.filter(
      ([command, args]) => command === '/usr/bin/rsync' && !args.includes('--version'),
    );

    expect(probeCalls).toHaveLength(2);
    expect(probeCalls[0][1].every((argument) => argument !== '--mkpath')).toBe(true);
    expect(probeCalls[0][1]).toContain('build@tile.ogis.app:.ogis-preflight-probe');
    expect(probeCalls[1][1]).toContain('build@tile.ogis.app:./');
  });

  it('keeps --mkpath for a compatible rsync 3.2.3 or newer', () => {
    expect(
      supportsRsyncMkpath({ command: '/usr/bin/rsync', version: '3.2.7', openrsync: false }),
    ).toBe(true);
    expect(
      supportsRsyncMkpath({ command: '/usr/bin/rsync', version: '3.2.2', openrsync: false }),
    ).toBe(false);
  });
});

describe('planet pins', () => {
  it('requires all three pins before any cloud call', () => {
    expect(() =>
      resolveRemotePlanetPin({
        options: {},
        env: {},
        config: { build: { planet: { url: '', date: '', sha256: '' } } },
      }),
    ).toThrow(/PLANET_URL, PLANET_DATE and PLANET_SHA256.*missing PLANET_URL/);
  });

  it('rejects a planet-latest URL even when a date and checksum are present', () => {
    expect(() =>
      resolveRemotePlanetPin({
        options: {},
        env: {
          ...PLANET_ENV,
          PLANET_URL: 'https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf',
        },
        config: {
          build: {
            planet: {
              url: 'https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf',
              date: '2026-10-29',
              sha256: SHA256,
            },
          },
        },
      }),
    ).toThrow(/planet-latest/);
  });

  it('accepts a complete dated pin set', () => {
    expect(resolveRemotePlanetPin({ options: {}, env: PLANET_ENV, config: makeConfig() })).toEqual({
      url: PLANET_ENV.PLANET_URL,
      date: PLANET_ENV.PLANET_DATE,
      sha256: PLANET_ENV.PLANET_SHA256,
    });
  });
});

describe('selectBuildSources', () => {
  it('accepts configured names only, not Object.prototype members', () => {
    const config = makeConfig();

    expect(selectBuildSources(config, 'pois')).toEqual(['pois']);

    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      expect(() => selectBuildSources(config, name)).toThrow(/has no build profile/);
    }
  });
});

describe('BUILD_BOX_READY_COMMAND', () => {
  it('uses the pmtiles subcommand accepted by the pinned 1.31.2 binary', () => {
    expect(BUILD_BOX_READY_COMMAND).toContain('/usr/local/bin/pmtiles version');
    expect(BUILD_BOX_READY_COMMAND).not.toContain('/usr/local/bin/pmtiles --version');
  });
});

describe('remote build hardening', () => {
  it('allows a long planet build inside the remote timeout', () => {
    expect(BUILD_BOX_TIMEOUT_MS).toBeGreaterThanOrEqual(12 * 60 * 60 * 1000);
  });

  it('rejects an ARM build server type for the x86 image', async () => {
    await expect(
      run({
        options: baseOptions({ buildServerType: 'cax21' }),
      }),
    ).rejects.toThrow(/is ARM; the ubuntu-26.04 image and Node\.js tarball are x86 only/);
  });
});

describe('installRemoteBuildSignalGuard', () => {
  it('runs cleanup before exiting on SIGINT', async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    const err = makeWriter();
    const processImpl = makeSignalProcess();
    const guard = installRemoteBuildSignalGuard({ cleanup, err, processImpl, timeoutMs: 500 });

    processImpl.emit('SIGINT');

    await vi.waitFor(() => expect(processImpl.exit).toHaveBeenCalledWith(130));
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(err.text()).toContain('Received SIGINT');
    expect(err.text()).toContain('Build box cleanup finished before exit');

    guard.dispose();
    expect(processImpl.handlers.size).toBe(0);
  });

  it('bounds cleanup before exiting with 143 on SIGTERM', async () => {
    let release;
    const cleanup = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const err = makeWriter();
    const processImpl = makeSignalProcess();
    const guard = installRemoteBuildSignalGuard({ cleanup, err, processImpl, timeoutMs: 10 });

    processImpl.emit('SIGTERM');

    await vi.waitFor(() => expect(processImpl.exit).toHaveBeenCalledWith(143));
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(err.text()).toContain('Received SIGTERM');
    expect(err.text()).toContain('did not finish within 10ms');
    expect(err.text()).toContain('check Hetzner Cloud for an orphaned build box');

    release();
    guard.dispose();
  });

  it('ignores a repeated signal while cleanup is running', async () => {
    let release;
    const cleanup = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const err = makeWriter();
    const processImpl = makeSignalProcess();
    const guard = installRemoteBuildSignalGuard({ cleanup, err, processImpl, timeoutMs: 500 });

    processImpl.emit('SIGINT');
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));

    processImpl.emit('SIGINT');
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(err.text()).toContain('Ignoring repeated SIGINT');

    release();
    await vi.waitFor(() => expect(processImpl.exit).toHaveBeenCalledWith(130));

    guard.dispose();
  });
});

describe('cleanupInterruptedBuild', () => {
  const boxConfig = {
    deployUser: 'deploy',
    targetHost: '192.0.2.10',
    deployPrivateKeyPath: '/keys/deploy',
  };

  function cleanupHarness() {
    const events = [];
    const execImpl = vi.fn(async (command, args) => {
      const remoteCommand = args.at(-1);
      if (remoteCommand.includes('rm -f')) {
        events.push('remove-key');
      } else if (remoteCommand.includes('tail -n 200')) {
        events.push('copy-log');
      }
      return { stdout: '', stderr: '' };
    });
    const client = fakeClient();
    const originalDelete = client.deleteServer;
    client.deleteServer = vi.fn(async (...args) => {
      events.push('delete-box');
      return originalDelete(...args);
    });
    const fsImpl = {
      rm: vi.fn(async () => {
        events.push('remove-local-key');
      }),
    };
    const err = makeWriter();

    return { events, execImpl, client, fsImpl, err };
  }

  it('removes the local key, remote key and box before copying logs', async () => {
    const { events, execImpl, client, fsImpl, err } = cleanupHarness();

    const result = await cleanupInterruptedBuild({
      box: { serverName: 'ogis-build-test' },
      boxConfig,
      activeServer: { id: 42 },
      hcloud: client,
      keyPath: '/home/deploy/.ssh/ogis-tiles-build',
      keyTransferAttempted: true,
      localKeyDirectory: '/repo/tmp/ogis-build-key-abc',
      logPath: '/opt/ogis-tiles/tmp/remote-build.log',
      execImpl,
      env: {},
      err,
      fsImpl,
      signal: 'SIGINT',
    });

    expect(result).toEqual({ destroyed: true, kept: false });
    expect(events).toEqual(['remove-local-key', 'remove-key', 'copy-log', 'delete-box']);
    expect(fsImpl.rm).toHaveBeenCalledWith('/repo/tmp/ogis-build-key-abc', {
      recursive: true,
      force: true,
    });
    expect(execImpl).toHaveBeenCalledWith(
      'ssh',
      expect.any(Array),
      expect.objectContaining({ timeoutMs: BUILD_BOX_SIGNAL_KEY_TIMEOUT_MS }),
    );
    expect(execImpl).toHaveBeenCalledWith(
      'ssh',
      expect.any(Array),
      expect.objectContaining({ timeoutMs: BUILD_BOX_SIGNAL_LOG_TIMEOUT_MS }),
    );
    expect(client.waitForAction).toHaveBeenCalledWith(2, {
      timeoutMs: BUILD_BOX_SIGNAL_DESTROY_TIMEOUT_MS,
      intervalMs: 5_000,
    });
  });

  it('keeps the box for --keep-build-box and --no-transfer but still removes the key', async () => {
    const { events, execImpl, client, fsImpl, err } = cleanupHarness();

    const result = await cleanupInterruptedBuild({
      box: { serverName: 'ogis-build-test' },
      boxConfig,
      activeServer: { id: 42 },
      hcloud: client,
      keyPath: '/home/deploy/.ssh/ogis-tiles-build',
      keyInstalled: true,
      localKeyDirectory: '/repo/tmp/ogis-build-key-abc',
      logPath: '/opt/ogis-tiles/tmp/remote-build.log',
      keep: true,
      execImpl,
      env: {},
      err,
      fsImpl,
    });

    expect(result).toEqual({ destroyed: false, kept: true });
    expect(events).toEqual(['remove-local-key', 'remove-key', 'copy-log']);
    expect(client.deleteServer).not.toHaveBeenCalled();
  });

  it('finds and destroys an in-flight box by name when no server id is known yet', async () => {
    const { events, execImpl, client, fsImpl, err } = cleanupHarness();
    client.findServerByName.mockResolvedValue(SERVER);

    const result = await cleanupInterruptedBuild({
      box: { serverName: 'ogis-build-test' },
      boxConfig: null,
      activeServer: null,
      hcloud: client,
      keyPath: '/home/deploy/.ssh/ogis-tiles-build',
      logPath: '/opt/ogis-tiles/tmp/remote-build.log',
      execImpl,
      env: {},
      err,
      fsImpl,
    });

    expect(result).toEqual({ destroyed: true, kept: false });
    expect(client.findServerByName).toHaveBeenCalledWith('ogis-build-test');
    expect(events).toEqual(['delete-box']);
  });

  it('does not delete an unlabelled same-name server during interrupt cleanup', async () => {
    const { events, execImpl, client, fsImpl, err } = cleanupHarness();
    client.findServerByName.mockResolvedValue({ ...SERVER, labels: {} });

    const result = await cleanupInterruptedBuild({
      box: { serverName: 'ogis-build-test' },
      boxConfig: null,
      activeServer: null,
      hcloud: client,
      keyPath: '/home/deploy/.ssh/ogis-tiles-build',
      execImpl,
      env: {},
      err,
      fsImpl,
      signal: 'SIGINT',
    });

    expect(result).toEqual({ destroyed: false, kept: false });
    expect(events).toEqual([]);
    expect(client.deleteServer).not.toHaveBeenCalled();
    expect(err.text()).toMatch(/not labelled as an ogis-tiles build box.*SIGINT/);
  });

  it('does not delete a foreign-labelled same-name server during interrupt cleanup', async () => {
    const { events, execImpl, client, fsImpl, err } = cleanupHarness();
    client.findServerByName.mockResolvedValue({
      ...SERVER,
      labels: { 'managed-by': 'someone-else', role: 'build-box' },
    });

    const result = await cleanupInterruptedBuild({
      box: { serverName: 'ogis-build-test' },
      boxConfig: null,
      activeServer: null,
      hcloud: client,
      keyPath: '/home/deploy/.ssh/ogis-tiles-build',
      execImpl,
      env: {},
      err,
      fsImpl,
    });

    expect(result).toEqual({ destroyed: false, kept: false });
    expect(events).toEqual([]);
    expect(client.deleteServer).not.toHaveBeenCalled();
  });

  it('removes the per-run known_hosts file last, after SSH key and log cleanup', async () => {
    const { events, execImpl, client, fsImpl, err } = cleanupHarness();
    fsImpl.rm = vi.fn(async (target) => {
      events.push(target.includes('known-hosts') ? 'remove-known-hosts' : 'remove-local-key');
    });
    client.findServerByName.mockResolvedValue(SERVER);

    const result = await cleanupInterruptedBuild({
      box: { serverName: 'ogis-build-test' },
      boxConfig,
      activeServer: { id: 42 },
      hcloud: client,
      keyPath: '/home/deploy/.ssh/ogis-tiles-build',
      keyInstalled: true,
      localKeyDirectory: '/repo/tmp/ogis-build-key-abc',
      localKnownHostsPath: '/repo/tmp/ogis-build-known-hosts-abc',
      logPath: '/opt/ogis-tiles/tmp/remote-build.log',
      execImpl,
      env: {},
      err,
      fsImpl,
    });

    expect(result).toEqual({ destroyed: true, kept: false });
    expect(events.at(-1)).toBe('remove-known-hosts');
    expect(events).toEqual([
      'remove-local-key',
      'remove-key',
      'copy-log',
      'delete-box',
      'remove-known-hosts',
    ]);
    expect(fsImpl.rm).toHaveBeenCalledWith('/repo/tmp/ogis-build-known-hosts-abc', {
      force: true,
    });
  });
});

describe('runRemoteBuild', () => {
  it('creates the box, syncs, builds, transfers and destroys on success', async () => {
    const execImpl = vi.fn(async (command, args) => {
      if (command === 'ssh' && args.at(-1).includes('bin/ogis.mjs build')) {
        return {
          stdout: 'Archive: /opt/ogis-tiles/dist/fixture-a/pois/current.pmtiles\n',
          stderr: '',
        };
      }

      if (command === 'ssh' && args.at(-1).includes('df -B1 --output=size,avail')) {
        return destinationDiskResponse();
      }

      if (command === 'ssh' && args.at(-1).includes('df -B1')) {
        return diskResponse();
      }

      return { stdout: '', stderr: '' };
    });
    const { result, client, exec } = await run({ execImpl });

    expect(client.findImageByName).toHaveBeenCalledWith('ubuntu-26.04', 'x86');
    expect(client.createServer).toHaveBeenCalledTimes(1);

    const created = client.createServer.mock.calls[0][0];
    expect(created).toMatchObject({
      name: 'ogis-build-20261031t120000z',
      serverType: 'cpx62',
      location: 'nbg1',
      image: 'ubuntu-26.04',
    });
    expect(created.userData).toContain('#cloud-config');
    expect(created.userData).toContain(DEPLOY_KEY);
    expect(created.userData).not.toContain('PRIVATE KEY');
    expect(created.sshKeys).toEqual([99]);
    expect(client.createSshKey).toHaveBeenCalledTimes(1);

    expect(client.waitForAction).toHaveBeenCalledWith(1, expect.any(Object));
    expect(client.waitForAction).toHaveBeenCalledWith(2, expect.any(Object));
    expect(client.getServer).toHaveBeenCalledWith(42);
    expect(client.deleteServer).toHaveBeenCalledWith(42);

    expect(result).toMatchObject({
      dryRun: false,
      serverId: 42,
      serverIp: '192.0.2.10',
      kept: false,
      destroyed: true,
      transfers: [{ source: 'pois', destination: 'build@tile.ogis.app:pois/' }],
    });

    const rsyncCall = exec.mock.calls.find(
      ([command, args]) => command === '/usr/bin/rsync' && args.includes('--exclude=/data/'),
    );
    expect(rsyncCall).toBeDefined();
    expect(rsyncCall[1]).toContain('--exclude=/data/');
    expect(rsyncCall[1].at(-1)).toBe('deploy@192.0.2.10:/opt/ogis-tiles/');

    const commands = sshCommands(exec);
    expect(commands.some((command) => command.includes('cloud-init status --wait'))).toBe(true);
    expect(commands.some((command) => command.includes('df -B1'))).toBe(true);
    expect(commands.some((command) => command.includes('mv -f'))).toBe(true);
    expect(commands.some((command) => command.includes('base64 -d'))).toBe(false);
    expect(exec.mock.calls.some(([command]) => command === 'scp')).toBe(true);
    expect(commands.some((command) => command.includes('npm ci --include=dev'))).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes('bin/ogis.mjs build') &&
          command.includes("--fixture='test/fixtures/alberta-canmore.osm.pbf'") &&
          command.includes("--only='pois'"),
      ),
    ).toBe(true);
    expect(
      commands.some(
        (command) =>
          command.includes('build@tile.ogis.app:pois/') &&
          command.includes('/home/deploy/.ssh/ogis-tiles-build'),
      ),
    ).toBe(true);
  });

  it('does not mutate anything during a dry run', async () => {
    const { result, client, exec } = await run({
      options: baseOptions({ yes: false, dryRun: true }),
    });

    expect(result).toMatchObject({ dryRun: true, serverType: 'cpx62', location: 'nbg1' });
    expect(client.createServer).not.toHaveBeenCalled();
    expect(client.deleteServer).not.toHaveBeenCalled();
    expect(client.getServer).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
  });

  it('forwards planet environment fallbacks into the remote build', async () => {
    const { out } = await run({
      options: baseOptions({ dryRun: true, yes: false, fixture: undefined }),
      env: {
        ...ENV,
        PLANET_URL: 'https://planet.example/osm.pbf',
        PLANET_DATE: '2026-01-02',
        PLANET_SHA256: SHA256,
      },
    });

    const text = out.write.mock.calls.map(([line]) => line).join('');
    expect(text).toContain('planet https://planet.example/osm.pbf');
    expect(text).toContain('date 2026-01-02');
  });

  it('requires --yes before creating a billable build box', async () => {
    await expect(run({ options: baseOptions({ yes: false }) })).rejects.toThrow(/requires --yes/);
  });

  it('keeps the build box when the flag is set', async () => {
    const { result, client, exec } = await run({
      options: baseOptions({ keepBuildBox: true }),
    });

    expect(result.kept).toBe(true);
    expect(result.destroyed).toBe(false);
    expect(client.deleteServer).not.toHaveBeenCalled();
    expect(
      sshCommands(exec).some(
        (command) => command.includes('rm -f') && command.includes('ogis-tiles-build'),
      ),
    ).toBe(true);
  });

  it('preserves the box and logs when the build fails', async () => {
    const execImpl = vi.fn(async (command, args) => {
      if (command === 'ssh' && args.at(-1).includes('bin/ogis.mjs build')) {
        throw new Error('planetiler failed');
      }

      if (command === 'ssh' && args.at(-1).includes('df -B1 --output=size,avail')) {
        return destinationDiskResponse();
      }

      if (command === 'ssh' && args.at(-1).includes('df -B1')) {
        return diskResponse();
      }

      return { stdout: '', stderr: '' };
    });
    const client = fakeClient();

    await expect(
      runRemoteBuild({
        repoRoot,
        options: baseOptions(),
        env: ENV,
        client,
        execImpl,
        out: { write: vi.fn() },
        err: { write: vi.fn() },
        publicKey: DEPLOY_KEY,
        buildPublicKey: DEPLOY_KEY,
        buildKeyMaterial: BUILD_KEY_MATERIAL,
        rsyncInfo: { command: '/usr/bin/rsync', protectArgs: true },
        now: () => 0,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/Build box ogis-build-19700101t000000z \(id 42\) was kept at 192\.0\.2\.10/);

    expect(client.deleteServer).not.toHaveBeenCalled();
    expect(sshCommands(execImpl).some((command) => command.includes('tail -n 200'))).toBe(true);
    expect(sshCommands(execImpl).some((command) => command.includes('rm -f'))).toBe(false);
  });

  it('passes a custom app directory to cloud-init and the remote commands', async () => {
    const { client, exec } = await run({
      options: baseOptions({ appDir: '/srv/ogis-tiles' }),
    });

    const created = client.createServer.mock.calls[0][0];
    expect(created.userData).toContain("install -d -m 0750 '/srv/ogis-tiles'");
    expect(created.userData).toContain("chown deploy:deploy '/srv/ogis-tiles'");
    expect(created.userData).not.toContain('/opt/ogis-tiles');
    expect(sshCommands(exec).some((command) => command.includes("cd '/srv/ogis-tiles'"))).toBe(
      true,
    );
  });

  it('removes the staged key when the key install fails after a successful upload', async () => {
    const execImpl = vi.fn(async (command, args) => {
      if (command === 'ssh' && args.at(-1).includes('df -B1 --output=size,avail')) {
        return destinationDiskResponse();
      }

      if (command === 'ssh' && args.at(-1).includes('df -B1')) {
        return diskResponse();
      }

      if (command === 'ssh' && args.at(-1).includes('mv -f')) {
        throw new Error('install denied');
      }

      return { stdout: '', stderr: '' };
    });
    const client = fakeClient();

    await expect(
      runRemoteBuild({
        repoRoot,
        options: baseOptions(),
        env: ENV,
        client,
        execImpl,
        out: { write: vi.fn() },
        err: { write: vi.fn() },
        publicKey: DEPLOY_KEY,
        buildPublicKey: DEPLOY_KEY,
        buildKeyMaterial: BUILD_KEY_MATERIAL,
        rsyncInfo: { command: '/usr/bin/rsync', protectArgs: true },
        now: () => 0,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/Build box .* was kept/);

    expect(execImpl.mock.calls.some(([command]) => command === 'scp')).toBe(true);
    expect(
      sshCommands(execImpl).some(
        (command) => command.includes('rm -f') && command.includes('ogis-tiles-build'),
      ),
    ).toBe(true);
  });

  it('removes the local staging directory that held the build key', async () => {
    const stagingDirectories = [];
    const fsImpl = {
      mkdir,
      readFile,
      writeFile,
      mkdtemp: vi.fn(async (prefix) => {
        const directory = await mkdtemp(prefix);
        stagingDirectories.push(directory);
        return directory;
      }),
      rm: vi.fn((target, options) => rm(target, options)),
    };

    const { result } = await run({ fsImpl });

    const keyDirectories = stagingDirectories.filter(
      (directory) =>
        directory.startsWith(path.join(repoRoot, 'tmp', 'ogis-build-key-')) &&
        !directory.includes('preflight'),
    );

    expect(result.transfers).toHaveLength(1);
    expect(keyDirectories).toHaveLength(1);
    await expect(stat(keyDirectories[0])).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fsImpl.rm).toHaveBeenCalledWith(keyDirectories[0], {
      recursive: true,
      force: true,
    });
  });

  it('removes the staged key when the archive transfer fails', async () => {
    const execImpl = vi.fn(async (command, args) => {
      if (command === 'ssh' && args.at(-1).includes('df -B1 --output=size,avail')) {
        return destinationDiskResponse();
      }

      if (command === 'ssh' && args.at(-1).includes('df -B1')) {
        return diskResponse();
      }

      if (command === 'ssh' && args.at(-1).includes('ogis-write-probe')) {
        throw new Error('rsync denied');
      }

      return { stdout: '', stderr: '' };
    });
    const client = fakeClient();
    const err = { write: vi.fn() };

    await expect(
      runRemoteBuild({
        repoRoot,
        options: baseOptions(),
        env: ENV,
        client,
        execImpl,
        out: { write: vi.fn() },
        err,
        publicKey: DEPLOY_KEY,
        buildPublicKey: DEPLOY_KEY,
        buildKeyMaterial: BUILD_KEY_MATERIAL,
        rsyncInfo: { command: '/usr/bin/rsync', protectArgs: true },
        now: () => 0,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/Build box .* was kept/);

    expect(client.deleteServer).not.toHaveBeenCalled();
    expect(
      sshCommands(execImpl).some(
        (command) => command.includes('rm -f') && command.includes('ogis-tiles-build'),
      ),
    ).toBe(true);
  });

  it('skips the transfer with --no-transfer and keeps the only output', async () => {
    const { result, exec, client, out } = await run({
      options: baseOptions({ noTransfer: true }),
    });

    expect(result.transfers).toEqual([]);
    expect(result.kept).toBe(true);
    expect(result.destroyed).toBe(false);
    expect(client.deleteServer).not.toHaveBeenCalled();
    expect(sshCommands(exec).some((command) => command.includes('build@tile.ogis.app'))).toBe(
      false,
    );
    expect(exec.mock.calls.some(([command]) => command === 'scp')).toBe(false);
    expect(out.write.mock.calls.map(([line]) => line).join('')).toContain(
      '--no-transfer keeps the build box',
    );
  });

  it('does not require a build key with --no-transfer', async () => {
    const { result, exec } = await run({
      options: baseOptions({ noTransfer: true }),
      env: { ...ENV, BUILD_SSH_PRIVATE_KEY_PATH: '' },
    });

    expect(result.transfers).toEqual([]);
    expect(result.kept).toBe(true);
    expect(exec.mock.calls.some(([command]) => command === 'scp')).toBe(false);
  });

  it('does not leak the build private key when the key copy fails', async () => {
    const encoded = Buffer.from(BUILD_KEY_MATERIAL, 'utf8').toString('base64');
    const execImpl = vi.fn(async (command, args) => {
      if (command === 'ssh' && args.at(-1).includes('df -B1 --output=size,avail')) {
        return destinationDiskResponse();
      }

      if (command === 'ssh' && args.at(-1).includes('df -B1')) {
        return diskResponse();
      }

      if (command === 'scp') {
        throw new Error(`Command failed (scp ${args.join(' ')}) ${BUILD_KEY_MATERIAL} ${encoded}`);
      }

      return { stdout: '', stderr: '' };
    });

    let caught;
    try {
      await run({ execImpl });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught.message).not.toContain('secret-build-key');
    expect(caught.message).not.toContain(encoded);
    expect(caught.message).not.toContain(BUILD_KEY_MATERIAL);
  });

  it('rejects remote-incompatible flags instead of ignoring them', async () => {
    for (const [name, pattern] of [
      ['install', /--install is not supported/],
      ['allowUnverifiedInstall', /--allow-unverified-install is not supported/],
      ['skipDownload', /--skip-download is not supported/],
    ]) {
      await expect(run({ options: baseOptions({ [name]: true }) })).rejects.toThrow(pattern);
    }

    await expect(run({ options: baseOptions({ archive: '' }) })).rejects.toThrow(
      /--archive requires a non-empty path/,
    );
  });

  it('rejects fixture or planet inputs under excluded sync paths', async () => {
    await expect(run({ options: baseOptions({ fixture: 'data/planet.osm.pbf' }) })).rejects.toThrow(
      /excluded from the remote sync/,
    );

    await expect(
      run({
        options: baseOptions({ fixture: undefined, planetPbf: 'tmp/planet.osm.pbf' }),
      }),
    ).rejects.toThrow(/excluded from the remote sync/);
  });

  it('rejects missing local inputs before creating the build box', async () => {
    const missingFixtureClient = fakeClient();
    await expect(
      run({
        client: missingFixtureClient,
        options: baseOptions({ fixture: 'test/fixtures/missing.osm.pbf' }),
      }),
    ).rejects.toThrow(/--fixture file not found: test\/fixtures\/missing\.osm\.pbf/);
    expect(missingFixtureClient.createServer).not.toHaveBeenCalled();

    const missingPlanetClient = fakeClient();
    await expect(
      run({
        client: missingPlanetClient,
        options: baseOptions({
          fixture: undefined,
          planetPbf: 'test/fixtures/missing-planet.osm.pbf',
        }),
        env: { ...ENV, ...PLANET_ENV },
      }),
    ).rejects.toThrow(/--planet-pbf file not found/);
    expect(missingPlanetClient.createServer).not.toHaveBeenCalled();

    const missingConfigClient = fakeClient();
    await expect(
      runRemoteBuild({
        repoRoot,
        configPath: path.join(repoRoot, 'config', 'missing-layers.json'),
        options: baseOptions(),
        env: ENV,
        client: missingConfigClient,
        out: { write: vi.fn() },
        err: { write: vi.fn() },
        publicKey: DEPLOY_KEY,
      }),
    ).rejects.toThrow(/CONFIG_PATH file not found/);
    expect(missingConfigClient.createServer).not.toHaveBeenCalled();
  });

  it('warns about --skip-filter before creating the build box', async () => {
    const events = [];
    const out = {
      write(line) {
        if (String(line).includes('--skip-filter needs about')) {
          events.push('warning');
        }
        return true;
      },
    };
    const execImpl = vi.fn(async (command, args) => {
      if (command === 'ssh' && args.at(-1).includes('df -B1 --output=size,avail')) {
        return destinationDiskResponse();
      }

      if (command === 'ssh' && args.at(-1).includes('df -B1')) {
        return diskResponse(`${900 * 1024 ** 3}\n`);
      }

      return { stdout: '', stderr: '' };
    });
    const client = fakeClient();
    const originalCreate = client.createServer;
    client.createServer = vi.fn(async (...args) => {
      events.push('create');
      return originalCreate(...args);
    });

    await run({
      client,
      execImpl,
      out,
      options: baseOptions({ fixture: undefined, skipFilter: true }),
      env: { ...ENV, ...PLANET_ENV },
    });

    expect(events).toEqual(['warning', 'create']);
  });

  it('does not forward ambient planet pins into a fixture build', async () => {
    const execImpl = vi.fn(async (command, args) => {
      if (command === 'ssh' && args.at(-1).includes('df -B1 --output=size,avail')) {
        return destinationDiskResponse();
      }

      if (command === 'ssh' && args.at(-1).includes('df -B1')) {
        return diskResponse();
      }

      return { stdout: '', stderr: '' };
    });

    const { result, exec } = await run({
      execImpl,
      env: { ...ENV, ...PLANET_ENV, PLANET_BUILD_HEAP: '8g' },
    });

    expect(result.transfers).toHaveLength(1);
    const buildCommand = sshCommands(exec).find((command) =>
      command.includes('bin/ogis.mjs build'),
    );

    expect(buildCommand).toContain("--fixture='test/fixtures/alberta-canmore.osm.pbf'");
    expect(buildCommand).not.toContain('--planet-sha256');
    expect(buildCommand).not.toContain('--planet-url');
    expect(buildCommand).not.toContain('--planet-date');
  });

  it('forwards a non-empty PLANET_BUILD_HEAP into the remote build', async () => {
    const execImpl = vi.fn(async (command, args) => {
      if (command === 'ssh' && args.at(-1).includes('df -B1 --output=size,avail')) {
        return destinationDiskResponse();
      }

      if (command === 'ssh' && args.at(-1).includes('df -B1')) {
        return diskResponse();
      }

      return { stdout: '', stderr: '' };
    });

    const { exec } = await run({
      execImpl,
      env: { ...ENV, PLANET_BUILD_HEAP: '12g' },
    });

    const buildCommand = sshCommands(exec).find((command) =>
      command.includes('bin/ogis.mjs build'),
    );

    expect(buildCommand).toContain("PLANET_BUILD_HEAP='12g'");
  });

  it('does not forward an empty PLANET_BUILD_HEAP', async () => {
    const execImpl = vi.fn(async (command, args) => {
      if (command === 'ssh' && args.at(-1).includes('df -B1 --output=size,avail')) {
        return destinationDiskResponse();
      }

      if (command === 'ssh' && args.at(-1).includes('df -B1')) {
        return diskResponse();
      }

      return { stdout: '', stderr: '' };
    });

    const { exec } = await run({
      execImpl,
      env: { ...ENV, PLANET_BUILD_HEAP: '   ' },
    });

    const buildCommand = sshCommands(exec).find((command) =>
      command.includes('bin/ogis.mjs build'),
    );

    expect(buildCommand).not.toContain('PLANET_BUILD_HEAP=');
  });

  it('deletes an orphaned build box when the create request times out', async () => {
    const client = fakeClient();
    client.createServer.mockRejectedValueOnce(
      Object.assign(new Error('Hetzner Cloud request timed out after 30000ms'), {
        name: 'HcloudError',
      }),
    );
    client.findServerByName.mockResolvedValue(SERVER);

    await expect(run({ client })).rejects.toThrow(/timed out/);

    expect(client.findServerByName).toHaveBeenCalledWith('ogis-build-20261031t120000z');
    expect(client.deleteServer).toHaveBeenCalledWith(42);
    expect(client.waitForAction).toHaveBeenCalledWith(2, expect.any(Object));
  });

  it('does not delete an unlabelled same-name server after a create timeout', async () => {
    const client = fakeClient();
    const err = makeWriter();
    client.createServer.mockRejectedValueOnce(
      Object.assign(new Error('Hetzner Cloud request timed out after 30000ms'), {
        name: 'HcloudError',
      }),
    );
    client.findServerByName.mockResolvedValue({ ...SERVER, labels: {} });

    await expect(run({ client, err })).rejects.toThrow(/timed out/);

    expect(client.deleteServer).not.toHaveBeenCalled();
    expect(err.text()).toMatch(/not labelled as an ogis-tiles build box.*check server 42 manually/);
  });

  it('does not delete a foreign-labelled same-name server after a create timeout', async () => {
    const client = fakeClient();
    const err = makeWriter();
    client.createServer.mockRejectedValueOnce(
      Object.assign(new Error('Hetzner Cloud request timed out after 30000ms'), {
        name: 'HcloudError',
      }),
    );
    client.findServerByName.mockResolvedValue({
      ...SERVER,
      labels: { 'managed-by': 'ogis-tiles', role: 'web' },
    });

    await expect(run({ client, err })).rejects.toThrow(/timed out/);

    expect(client.deleteServer).not.toHaveBeenCalled();
    expect(err.text()).toMatch(/not labelled as an ogis-tiles build box/);
  });

  it('treats an already-deleted build box as deleted', async () => {
    const client = fakeClient();
    client.deleteServer.mockRejectedValueOnce(notFound());

    const { result } = await run({ client });

    expect(result.destroyed).toBe(true);
    expect(client.deleteServer).toHaveBeenCalledWith(42);
    expect(client.waitForAction).toHaveBeenCalledTimes(1);
    expect(client.waitForAction).toHaveBeenCalledWith(1, expect.any(Object));
  });

  it('fails the disk preflight when --skip-filter cannot fit on the CPX62 disk', async () => {
    const execImpl = vi.fn(async (command, args) => {
      if (command === 'ssh' && args.at(-1).includes('df -B1 --output=size,avail')) {
        return destinationDiskResponse();
      }

      if (command === 'ssh' && args.at(-1).includes('df -B1')) {
        return diskResponse(`${600 * 1024 ** 3}\n`);
      }

      return { stdout: '', stderr: '' };
    });
    const client = fakeClient();

    await expect(
      run({
        client,
        execImpl,
        options: baseOptions({ fixture: undefined, skipFilter: true }),
        env: { ...ENV, ...PLANET_ENV },
      }),
    ).rejects.toThrow(
      /--skip-filter needs about 850\.0 GiB.*was destroyed after a pre-build failure/,
    );

    expect(client.deleteServer).toHaveBeenCalledWith(42);
  });

  it('destroys the box when cloud-init fails before the build starts', async () => {
    const execImpl = vi.fn(async (command, args) => {
      if (command === 'ssh' && args.at(-1).includes('df -B1 --output=size,avail')) {
        return destinationDiskResponse();
      }

      if (command === 'ssh' && args.at(-1).includes('cloud-init status --wait')) {
        throw new Error('cloud-init failed');
      }

      return { stdout: '', stderr: '' };
    });
    const client = fakeClient();

    await expect(run({ client, execImpl })).rejects.toThrow(
      /cloud-init failed.*was destroyed after a pre-build failure/,
    );

    expect(client.deleteServer).toHaveBeenCalledWith(42);
  });

  it('keeps the box on a pre-build failure when --keep-build-box is set', async () => {
    const execImpl = vi.fn(async (command, args) => {
      if (command === 'ssh' && args.at(-1).includes('df -B1 --output=size,avail')) {
        return destinationDiskResponse();
      }

      if (command === 'ssh' && args.at(-1).includes('cloud-init status --wait')) {
        throw new Error('cloud-init failed');
      }

      return { stdout: '', stderr: '' };
    });
    const client = fakeClient();

    await expect(
      run({ client, execImpl, options: baseOptions({ keepBuildBox: true }) }),
    ).rejects.toThrow(/cloud-init failed.*was kept at 192\.0\.2\.10/);

    expect(client.deleteServer).not.toHaveBeenCalled();
  });

  it('rejects missing cloud and build-key configuration', async () => {
    await expect(
      runRemoteBuild({
        repoRoot,
        options: baseOptions(),
        env: { ...ENV, HCLOUD_TOKEN: '' },
        client: fakeClient(),
        out: { write: vi.fn() },
        err: { write: vi.fn() },
      }),
    ).rejects.toThrow(/HCLOUD_TOKEN is required/);

    await expect(
      runRemoteBuild({
        repoRoot,
        options: baseOptions(),
        env: { ...ENV, BUILD_SSH_PRIVATE_KEY_PATH: '' },
        client: fakeClient(),
        out: { write: vi.fn() },
        err: { write: vi.fn() },
      }),
    ).rejects.toThrow(/BUILD_SSH_PRIVATE_KEY_PATH is required/);
  });

  it('rejects missing planet pins before creating the build box', async () => {
    const client = fakeClient();

    await expect(run({ client, options: baseOptions({ fixture: undefined }) })).rejects.toThrow(
      /PLANET_URL, PLANET_DATE and PLANET_SHA256/,
    );

    expect(client.createServer).not.toHaveBeenCalled();
    expect(client.findImageByName).not.toHaveBeenCalled();
    expect(client.createSshKey).not.toHaveBeenCalled();
  });

  it('rejects a planet-latest URL before creating the build box', async () => {
    const client = fakeClient();

    await expect(
      run({
        client,
        options: baseOptions({ fixture: undefined }),
        env: {
          ...ENV,
          ...PLANET_ENV,
          PLANET_URL: 'https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf',
        },
      }),
    ).rejects.toThrow(/planet-latest/);

    expect(client.createServer).not.toHaveBeenCalled();
  });

  it('rejects empty value flags passed directly to the remote build', async () => {
    for (const [flag, value] of [
      ['fixture', '  '],
      ['only', ''],
      ['planetPbf', ' '],
      ['planetUrl', ''],
      ['planetDate', ''],
      ['planetSha256', ' '],
      ['outputDir', ''],
      ['buildServerType', ''],
      ['buildLocation', ' '],
      ['buildImage', ''],
      ['buildName', ' '],
    ]) {
      await expect(run({ options: baseOptions({ [flag]: value }) })).rejects.toThrow(
        /requires a non-empty value with --remote/,
      );
    }
  });

  it('rejects CONFIG_PATH under a sync-excluded directory', async () => {
    await expect(
      runRemoteBuild({
        repoRoot,
        configPath: path.join(repoRoot, 'data', 'layers.json'),
        options: baseOptions(),
        env: ENV,
        client: fakeClient(),
        out: { write: vi.fn() },
        err: { write: vi.fn() },
        publicKey: DEPLOY_KEY,
      }),
    ).rejects.toThrow(/CONFIG_PATH.*excluded from the remote sync/);
  });

  it('rejects an unsafe TILE_APP_DIR before creating the build box', async () => {
    for (const appDir of [
      '/',
      '/opt',
      '/srv',
      '/etc/tiles',
      '/home/deploy/tiles',
      '/root/tiles',
      '/usr/tiles',
      '/var/tiles',
    ]) {
      const client = fakeClient();

      await expect(run({ client, options: baseOptions({ appDir }) })).rejects.toThrow(
        /must be a child directory under \/opt or \/srv/,
      );

      expect(client.createServer).not.toHaveBeenCalled();
    }
  });

  it('aborts before creating the box when the destination disk is too full', async () => {
    const execImpl = vi.fn(async (command, args) => {
      if (command === 'ssh' && args.at(-1).includes('df -B1 --output=size,avail')) {
        return destinationDiskResponse(`${40 * 1024 ** 3} ${8 * 1024 ** 3}\n`);
      }

      return { stdout: '', stderr: '' };
    });
    const client = fakeClient();

    await expect(
      run({
        client,
        execImpl,
        env: { ...ENV, BUILD_DESTINATION_MIN_FREE_BYTES: String(20 * 1024 ** 3) },
      }),
    ).rejects.toThrow(/tile server data filesystem has 8\.0 GiB free but at least 20\.0 GiB/);

    expect(client.createServer).not.toHaveBeenCalled();
  });

  it('warns from 70% destination usage without resizing the server', async () => {
    const execImpl = vi.fn(async (command, args) => {
      if (command === 'ssh' && args.at(-1).includes('df -B1 --output=size,avail')) {
        return destinationDiskResponse(`${40 * 1024 ** 3} ${8 * 1024 ** 3}\n`);
      }

      if (command === 'ssh' && args.at(-1).includes('df -B1')) {
        return diskResponse();
      }

      return { stdout: '', stderr: '' };
    });

    const { out, client } = await run({ execImpl });

    expect(client.createServer).toHaveBeenCalledTimes(1);
    expect(out.write.mock.calls.map(([line]) => line).join('')).toMatch(/CX23.*40 GB.*CX33/);
  });

  it('uses a fresh per-run known_hosts file for build-box SSH and rsync', async () => {
    const first = await run();
    const second = await run();
    const knownHosts = (exec) =>
      exec.mock.calls
        .flatMap(([command, args]) => (command === 'ssh' || command === 'scp' ? args : []))
        .filter((argument) => String(argument).startsWith('UserKnownHostsFile='))
        .map((argument) => argument.slice('UserKnownHostsFile='.length));

    const firstPaths = new Set(knownHosts(first.exec));
    const secondPaths = new Set(knownHosts(second.exec));

    expect(firstPaths.size).toBe(1);
    expect([...firstPaths][0].startsWith(path.join(repoRoot, 'tmp'))).toBe(true);
    expect([...firstPaths][0]).not.toBe([...secondPaths][0]);
    expect(
      first.exec.mock.calls.some(
        ([command, args]) =>
          command === '/usr/bin/rsync' &&
          args.includes('-e') &&
          args.some((argument) => String(argument).includes('UserKnownHostsFile=')),
      ),
    ).toBe(true);
  });

  it('removes the per-run known_hosts file after a successful build', async () => {
    const { exec } = await run();
    const knownHostsPath = exec.mock.calls
      .flatMap(([command, args]) => (command === 'ssh' || command === 'scp' ? args : []))
      .find((argument) => String(argument).startsWith('UserKnownHostsFile='))
      .slice('UserKnownHostsFile='.length);

    await expect(stat(knownHostsPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes the per-run known_hosts file after a failed build', async () => {
    const execImpl = vi.fn(async (command, args) => {
      if (command === 'ssh' && args.at(-1).includes('bin/ogis.mjs build')) {
        throw new Error('planetiler failed');
      }

      if (command === 'ssh' && args.at(-1).includes('df -B1 --output=size,avail')) {
        return destinationDiskResponse();
      }

      if (command === 'ssh' && args.at(-1).includes('df -B1')) {
        return diskResponse();
      }

      return { stdout: '', stderr: '' };
    });

    await expect(run({ execImpl })).rejects.toThrow(/was kept/);

    const knownHostsPath = execImpl.mock.calls
      .flatMap(([command, args]) => (command === 'ssh' || command === 'scp' ? args : []))
      .find((argument) => String(argument).startsWith('UserKnownHostsFile='))
      .slice('UserKnownHostsFile='.length);

    await expect(stat(knownHostsPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses the configured build and transfer timeouts', async () => {
    const execImpl = vi.fn(async (command, args) => {
      if (command === 'ssh' && args.at(-1).includes('df -B1 --output=size,avail')) {
        return destinationDiskResponse();
      }

      if (command === 'ssh' && args.at(-1).includes('df -B1')) {
        return diskResponse();
      }

      return { stdout: '', stderr: '' };
    });

    const { exec } = await run({
      execImpl,
      env: {
        ...ENV,
        BUILD_BOX_TIMEOUT_MS: '3600000',
        BUILD_BOX_TRANSFER_TIMEOUT_MS: '1800000',
      },
    });

    const timeouts = (needle) =>
      exec.mock.calls
        .filter(([command, args]) => command === 'ssh' && args.at(-1).includes(needle))
        .map(([, , options]) => options.timeoutMs);

    expect(timeouts('bin/ogis.mjs build').at(-1)).toBe(3_600_000);
    expect(timeouts('build@tile.ogis.app:pois/').at(-1)).toBe(1_800_000);
    expect(BUILD_BOX_TIMEOUT_MS).toBe(24 * 60 * 60 * 1000);
    expect(BUILD_BOX_TRANSFER_TIMEOUT_MS).toBe(4 * 60 * 60 * 1000);
  });

  it('removes the build key with an explicit timeout on the normal path', async () => {
    const { exec } = await run();

    const removal = exec.mock.calls.find(
      ([command, args]) => command === 'ssh' && args.at(-1).includes('rm -f'),
    );

    expect(removal).toBeDefined();
    expect(removal[2]).toEqual(
      expect.objectContaining({ timeoutMs: BUILD_BOX_KEY_REMOVAL_TIMEOUT_MS }),
    );
  });

  it('runs the live build-key/rrsync probe before creating the box', async () => {
    const events = [];
    const client = fakeClient();
    const originalCreate = client.createServer;
    client.createServer = vi.fn(async (...args) => {
      events.push('create');
      return originalCreate(...args);
    });
    const execImpl = vi.fn(async (command, args) => {
      if (command === '/usr/bin/rsync') {
        events.push('probe');
        return { stdout: '', stderr: '' };
      }

      if (command === 'ssh' && args.at(-1).includes('df -B1 --output=size,avail')) {
        return destinationDiskResponse();
      }

      if (command === 'ssh' && args.at(-1).includes('df -B1')) {
        return diskResponse();
      }

      return { stdout: '', stderr: '' };
    });

    await run({ client, execImpl });

    expect(events.indexOf('probe')).toBeGreaterThan(-1);
    expect(events.indexOf('probe')).toBeLessThan(events.indexOf('create'));
  });

  it('warns rather than swallowing a local key-staging cleanup failure', async () => {
    const fsImpl = {
      mkdir,
      readFile,
      writeFile,
      mkdtemp,
      rm: vi.fn(async () => {
        throw new Error('EPERM: staging is busy');
      }),
    };

    const { err } = await run({ fsImpl });

    expect(err.write.mock.calls.map(([line]) => line).join('')).toMatch(
      /could not remove the local build-key staging directory.*EPERM/,
    );
  });

  it('warns rather than swallowing a preflight staging cleanup failure', async () => {
    const fsImpl = {
      mkdir,
      mkdtemp,
      writeFile,
      rm: vi.fn(async (target, options) => {
        if (String(target).includes('ogis-build-key-preflight-')) {
          throw new Error('EACCES: preflight is busy');
        }
        return rm(target, options);
      }),
    };

    const { err } = await run({ fsImpl });

    expect(err.write.mock.calls.map(([line]) => line).join('')).toMatch(
      /could not remove the build-key preflight staging directory.*EACCES/,
    );
  });

  it('builds the npm ci command with development dependencies', () => {
    expect(npmCiCommand({ appDir: '/opt/ogis-tiles' })).toContain('npm ci --include=dev');
  });
});
