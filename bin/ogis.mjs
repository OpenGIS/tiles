#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCommand } from '../src/build/exec.mjs';
import { BuildError } from '../src/build/errors.mjs';
import { parseDeployOptions, parseSourceOptions, parseStatusOptions } from '../src/deploy/cli.mjs';
import { DeployError, resolveDeployConfig, withServerOverride } from '../src/deploy/config.mjs';
import { runDeploy } from '../src/deploy/deploy.mjs';
import { loadDeployLayers } from '../src/deploy/layers.mjs';
import { promoteSource, rollbackSource, waitForJson } from '../src/deploy/promote.mjs';
import { sourceRemoteCommand } from '../src/deploy/remote.mjs';
import { runRemote } from '../src/deploy/ssh.mjs';
import { runDeployStatus, runServerStatus } from '../src/deploy/status.mjs';
import { createHcloudClient } from '../src/provision/hcloud.mjs';
import {
  childEnvironment,
  loadEnvironment,
  provisionRunOptions,
  ProvisionError,
  resolveConfig,
  runProvision,
} from '../src/provision/provision.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const VALUE_FLAGS = new Map([
  ['only', 'only'],
  ['fixture', 'fixture'],
  ['planet-pbf', 'planetPbf'],
  ['planet-url', 'planetUrl'],
  ['planet-date', 'planetDate'],
  ['planet-sha256', 'planetSha256'],
  ['planet-md5', 'planetMd5'],
  ['archive', 'archive'],
  ['output-dir', 'outputDir'],
  ['build-server-type', 'buildServerType'],
  ['build-location', 'buildLocation'],
  ['build-image', 'buildImage'],
  ['build-name', 'buildName'],
]);

const BOOLEAN_FLAGS = new Map([
  ['skip-download', 'skipDownload'],
  ['skip-filter', 'skipFilter'],
  ['skip-build', 'skipBuild'],
  ['skip-verify', 'skipVerify'],
  ['install', 'install'],
  ['keep-work', 'keepWork'],
  ['allow-unverified-install', 'allowUnverifiedInstall'],
  ['force', 'force'],
  ['remote', 'remote'],
  ['keep-build-box', 'keepBuildBox'],
  ['no-destroy', 'noDestroy'],
  ['no-transfer', 'noTransfer'],
  ['dry-run', 'dryRun'],
  ['yes', 'yes'],
  ['help', 'help'],
]);

const USAGE = `Usage: ogis <command> [options]

Commands:
  build       Build the configured tile sources, locally or on a remote build box
  provision   Rebuild the tile server from cloud-init
  deploy      Deploy the code, service and nginx configuration
  promote     Promote an incoming archive on the server
  rollback    Swap the current archive with the previous pair
  status      Show tile server state, archives and health

Run "ogis <command> --help" for command options.`;

const BUILD_USAGE = `Usage: ogis build [options]

Build the configured tile sources.

Options:
  --only=<source>          Build only the named source (comma-separated)
  --fixture=<pbf>          Build from a local fixture PBF instead of the planet
  --planet-pbf=<pbf>       Build from a local planet PBF
  --planet-url=<url>       Override the planet URL
  --planet-date=<date>     Override the planet date (YYYY-MM-DD)
  --planet-sha256=<hash>   Override the planet SHA-256
  --planet-md5=<md5>       Override the planet MD5
  --skip-download          Do not download the planet PBF
  --skip-filter            Build directly from the input PBF
  --skip-build             Verify an existing archive without building
  --archive=<path>         Archive to use with --skip-build
  --skip-verify            Skip PMTiles verification and sample tiles
  --output-dir=<dir>       Override the build output directory
  --install                Install the archive into the source data directory
  --allow-unverified-install  Install even when verification was skipped
  --keep-work              Keep the temporary work directory
  --force                  Download tools and inputs again
  --remote                 Build on a disposable Hetzner Cloud build box
  --yes                    Confirm creating the billable build box
  --dry-run                Print the remote plan and make no changes
  --keep-build-box         Keep the remote build box after the build
  --no-destroy             Alias for --keep-build-box
  --no-transfer            Build remotely but skip the archive transfer
  --build-server-type=<t>  Build box type (default cpx62)
  --build-location=<l>     Build box location (default nbg1)
  --build-image=<image>    Build box image (default ubuntu-26.04)
  --build-name=<name>      Build box name (default timestamped)
  --help                   Show this help

Environment:
  HCLOUD_TOKEN, TILE_SERVER_HOST, TILE_SERVER_IP, SSH_PRIVATE_KEY_PATH,
  BUILD_SSH_PRIVATE_KEY_PATH, BUILD_SERVER_TYPE, BUILD_SERVER_LOCATION,
  BUILD_SERVER_IMAGE, KEEP_BUILD_BOX`;

const PROVISION_USAGE = `Usage: ogis provision [options]

Rebuild the tile server from cloud-init. The default is a dry run.

Options:
  --dry-run                Print the plan and make no changes (default)
  --yes                    Perform the rebuild; required for real changes
  --snapshot               Snapshot the server before rebuilding (default with --yes)
  --no-snapshot            Skip the snapshot before rebuilding
  --server=<ip|name>       Target a server by IPv4 address or name
  --host=<hostname>        Override TILE_SERVER_HOST
  --help                   Show this help`;

const DEPLOY_USAGE = `Usage: ogis deploy [options]

Deploy the repository to the tile server. The default is a real deployment.

Options:
  --dry-run                Print the plan and make no local or remote changes
  --skip-certbot           Do not request a certificate; reuse an existing one
  --skip-smoke             Skip the post-deploy HTTP and service checks
  --allow-degraded         Allow a degraded /sources or /ready response
  --require-ready          Require /ready to return 200
  --server=<host>          Override the SSH target host
  --help                   Show this help

Environment:
  TILE_SERVER_HOST, TILE_SERVER_IP, SSH_PRIVATE_KEY_PATH, DEPLOY_USER, CERTBOT_EMAIL`;

const PROMOTE_USAGE = `Usage: ogis promote --source <name> [options]

Promote data/incoming/<source> to current on the tile server.

Options:
  --source=<name>          Source to promote (required)
  --dry-run                Print the plan without changing the server
  --skip-smoke             Skip the post-promotion health checks
  --server=<host>          Override the SSH target host
  --help                   Show this help`;

const ROLLBACK_USAGE = `Usage: ogis rollback --source <name> [options]

Swap current and previous for a source on the tile server.

Options:
  --source=<name>          Source to roll back (required)
  --dry-run                Print the plan without changing the server
  --skip-smoke             Skip the post-rollback health checks
  --server=<host>          Override the SSH target host
  --help                   Show this help`;

const STATUS_USAGE = `Usage: ogis status [options]

Show cloud state, server reachability, service state, archives and health.

Options:
  --server=<ip|name>       Target a server by IPv4 address or name
  --host=<hostname>        Override TILE_SERVER_HOST
  --cloud-only             Skip server checks and SSH keys
  --server-only            Skip cloud checks and HCLOUD_TOKEN
  --json                   Print server-side status as JSON
  --help                   Show this help`;

function parseBuildOptions(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (!argument.startsWith('--')) {
      throw new BuildError(`Unexpected argument "${argument}"`);
    }

    const equals = argument.indexOf('=');
    const name = equals === -1 ? argument.slice(2) : argument.slice(2, equals);
    const inlineValue = equals === -1 ? null : argument.slice(equals + 1);

    if (BOOLEAN_FLAGS.has(name)) {
      if (inlineValue !== null) {
        throw new BuildError(`--${name} does not take a value`);
      }

      options[BOOLEAN_FLAGS.get(name)] = true;
      continue;
    }

    if (!VALUE_FLAGS.has(name)) {
      throw new BuildError(`Unknown option "--${name}"`);
    }

    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new BuildError(`--${name} requires a value`);
    }

    if (value.trim() === '') {
      throw new BuildError(`--${name} requires a non-empty value`);
    }

    if (inlineValue === null) {
      index += 1;
    }

    options[VALUE_FLAGS.get(name)] = value;
  }

  return options;
}

function parseProvisionOptions(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (!argument.startsWith('--')) {
      throw new ProvisionError(`Unexpected argument "${argument}"`);
    }

    const equals = argument.indexOf('=');
    const name = equals === -1 ? argument.slice(2) : argument.slice(2, equals);
    const inlineValue = equals === -1 ? null : argument.slice(equals + 1);

    if (['dry-run', 'yes', 'snapshot', 'no-snapshot', 'help'].includes(name)) {
      if (inlineValue !== null) {
        throw new ProvisionError(`--${name} does not take a value`);
      }

      if (name === 'dry-run') {
        options.dryRun = true;
      } else if (name === 'yes') {
        options.yes = true;
      } else if (name === 'snapshot') {
        options.snapshot = true;
      } else if (name === 'no-snapshot') {
        options.noSnapshot = true;
      } else {
        options.help = true;
      }

      continue;
    }

    if (name === 'server' || name === 'host') {
      const value = inlineValue ?? argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new ProvisionError(`--${name} requires a value`);
      }

      if (inlineValue === null) {
        index += 1;
      }

      options[name] = value;
      continue;
    }

    throw new ProvisionError(`Unknown option "--${name}"`);
  }

  return options;
}

async function provisionEnvironment({ requireSshKeys = true } = {}) {
  const env = await loadEnvironment({ envPath: path.join(repoRoot, '.env') });
  const config = resolveConfig({ env, requireSshKeys });
  const client = createHcloudClient({ token: config.token });

  return { config, client };
}

async function runProvisionCommand(rest) {
  const options = parseProvisionOptions(rest);

  if (options.help) {
    process.stdout.write(`${PROVISION_USAGE}\n`);
    return;
  }

  if (options.snapshot && options.noSnapshot) {
    throw new ProvisionError('--snapshot and --no-snapshot cannot be used together');
  }

  if (options.yes && options.dryRun) {
    throw new ProvisionError('--yes and --dry-run cannot be used together');
  }

  const { config, client } = await provisionEnvironment();

  await runProvision({
    config,
    client,
    options: provisionRunOptions(options),
  });
}

async function runDeployCommand(rest) {
  const options = parseDeployOptions(rest);

  if (options.help) {
    process.stdout.write(`${DEPLOY_USAGE}\n`);
    return;
  }

  const env = await loadEnvironment({ envPath: path.join(repoRoot, '.env') });
  let config = resolveDeployConfig({ env });

  if (options.server) {
    config = withServerOverride(config, options.server);
  }

  await runDeploy({
    config,
    layersConfig: loadDeployLayers({ env, repoRoot }),
    repoRoot,
    options: {
      dryRun: options.dryRun,
      skipCertbot: options.skipCertbot,
      skipSmoke: options.skipSmoke,
      allowDegraded: options.allowDegraded,
      requireReady: options.requireReady,
    },
    env,
  });
}

async function localRestart(config) {
  await runCommand('sudo', ['systemctl', 'restart', config.serviceName], {
    encoding: 'utf8',
    env: childEnvironment(process.env),
  });
}

async function localSmoke(config) {
  const base = `http://127.0.0.1:${config.port}`;
  const checks = [
    ['/health', 'Local health check'],
    ['/sources', 'Local sources check'],
  ];

  for (const [pathname, label] of checks) {
    await waitForJson({
      fetchImpl: globalThis.fetch,
      url: `${base}${pathname}`,
      label,
      timeoutMs: 30_000,
    });
  }
}

async function runSourceCommand(kind, rest) {
  const usage = kind === 'promote' ? PROMOTE_USAGE : ROLLBACK_USAGE;
  const options = parseSourceOptions(rest);

  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return;
  }

  if (!options.source) {
    throw new DeployError('--source is required');
  }

  if (!/^[a-z][a-z0-9-]*$/.test(options.source)) {
    throw new DeployError(
      `--source "${options.source}" is invalid; names must match /^[a-z][a-z0-9-]*$/`,
    );
  }

  const env = await loadEnvironment({ envPath: path.join(repoRoot, '.env') });
  let config = resolveDeployConfig({ env, requireHost: !options.serverSide });

  if (options.server && !options.serverSide) {
    config = withServerOverride(config, options.server);
  }

  if (!options.serverSide) {
    const remoteCommand = sourceRemoteCommand(config, kind, options);

    if (options.dryRun) {
      process.stdout.write(
        `Would run over SSH as ${config.deployUser}@${config.targetHost}:\n  ${remoteCommand}\n`,
      );
      return;
    }

    const { stdout, stderr } = await runRemote(config, remoteCommand, {
      label: `${kind} on the server`,
    });

    if (stdout) {
      process.stdout.write(stdout);
    }

    if (stderr) {
      process.stderr.write(stderr);
    }

    return;
  }

  const callbacks = options.skipSmoke
    ? { restart: () => localRestart(config), smoke: async () => {} }
    : { restart: () => localRestart(config), smoke: () => localSmoke(config) };
  const common = {
    source: options.source,
    layers: loadDeployLayers({ env, repoRoot }),
    appDir: options.appDir ?? config.appDir,
    dataDir: options.dataDir ?? config.dataDir,
    incomingDir: options.incomingDir ?? config.incomingDir,
    dryRun: options.dryRun,
    ...callbacks,
  };
  const healthUrl = options.skipSmoke ? null : `http://127.0.0.1:${config.port}`;

  const result =
    kind === 'promote'
      ? await promoteSource({ ...common, healthUrl })
      : await rollbackSource({ ...common, healthUrl });

  if (result.dryRun) {
    process.stdout.write(`ogis ${kind} — dry run\n`);
    process.stdout.write(`Source: ${result.source}\n`);
    process.stdout.write(`Build: ${result.buildId}\n`);
    process.stdout.write(`Archive: ${result.archivePath}\n`);
    process.stdout.write(`Manifest: ${result.manifestPath}\n`);
    process.stdout.write('No changes were made.\n');
    return;
  }

  process.stdout.write(
    `${kind === 'promote' ? 'Promoted' : 'Rolled back'} ${result.source} to ${result.buildId}\n`,
  );
  process.stdout.write(`Current: ${result.currentArchive}\n`);

  if (result.previousArchive) {
    process.stdout.write(`Previous: ${result.previousArchive}\n`);
  }
}

async function runStatusCommand(rest) {
  const options = parseStatusOptions(rest);

  if (options.help) {
    process.stdout.write(`${STATUS_USAGE}\n`);
    return;
  }

  const env = await loadEnvironment({ envPath: path.join(repoRoot, '.env') });

  if (options.serverSide) {
    const config = resolveDeployConfig({ env, requireHost: false });
    await runServerStatus({
      config,
      layers: loadDeployLayers({ env, repoRoot }),
      json: options.json,
      out: process.stdout,
    });
    return;
  }

  let cloud = null;
  if (!options.serverOnly) {
    const config = resolveConfig({ env, requireSshKeys: false });
    const client = createHcloudClient({ token: config.token });
    cloud = { config, client };
  }

  let deployConfig = null;
  if (!options.cloudOnly) {
    deployConfig = resolveDeployConfig({ env });

    if (options.server) {
      deployConfig = withServerOverride(deployConfig, options.server);
    } else if (options.host) {
      deployConfig = withServerOverride(deployConfig, options.host);
    }
  }

  await runDeployStatus({
    cloud,
    deployConfig,
    options,
    out: process.stdout,
    err: process.stderr,
  });
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  if (command === 'build') {
    const options = parseBuildOptions(rest);

    if (options.help) {
      process.stdout.write(`${BUILD_USAGE}\n`);
      return;
    }

    const remoteOnly = [
      ['yes', 'yes'],
      ['dryRun', 'dry-run'],
      ['keepBuildBox', 'keep-build-box'],
      ['noDestroy', 'no-destroy'],
      ['noTransfer', 'no-transfer'],
      ['buildServerType', 'build-server-type'],
      ['buildLocation', 'build-location'],
      ['buildImage', 'build-image'],
      ['buildName', 'build-name'],
    ];
    const remoteOnlyFlag = remoteOnly.find(([name]) => Object.hasOwn(options, name));
    if (!options.remote && remoteOnlyFlag) {
      throw new BuildError(`--${remoteOnlyFlag[1]} requires --remote`);
    }

    const env = await loadEnvironment({ envPath: path.join(repoRoot, '.env') });
    const configPath = env.CONFIG_PATH || path.join(repoRoot, 'config', 'layers.json');

    if (options.remote) {
      const { runRemoteBuild } = await import('../src/build/remote.mjs');

      await runRemoteBuild({
        repoRoot,
        configPath,
        options,
        env,
      });

      return;
    }

    const { runBuild } = await import('../src/build/pipeline.mjs');
    const results = await runBuild({
      repoRoot,
      configPath,
      env,
      ...options,
    });

    for (const result of results) {
      process.stdout.write(`Archive: ${result.archivePath}\n`);
      process.stdout.write(`Manifest: ${result.manifestPath}\n`);
      process.stdout.write(`SHA-256: ${result.archiveSha256}\n`);

      if (result.installed) {
        process.stdout.write(`Installed: ${result.installed.currentArchive}\n`);
      }
    }

    return;
  }

  if (command === 'provision') {
    await runProvisionCommand(rest);
    return;
  }

  if (command === 'deploy') {
    await runDeployCommand(rest);
    return;
  }

  if (command === 'promote' || command === 'rollback') {
    await runSourceCommand(command, rest);
    return;
  }

  if (command === 'status') {
    await runStatusCommand(rest);
    return;
  }

  throw new BuildError(
    `Unknown command "${command}"; expected "build", "provision", "deploy", "promote", "rollback" or "status"`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
