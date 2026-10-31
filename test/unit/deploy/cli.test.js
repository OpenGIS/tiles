import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import {
  parseDeployOptions,
  parseSourceOptions,
  parseStatusOptions,
} from '../../../src/deploy/cli.mjs';
import { repoRoot } from '../../helpers/temp.mjs';

const run = promisify(execFile);
const cliPath = path.join(repoRoot, 'bin', 'ogis.mjs');
const rejectBuildDepsLoader = path.join(
  repoRoot,
  'test',
  'helpers',
  'reject-build-deps-loader.mjs',
);

function cli(args) {
  return run(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
  });
}

function cliWithoutBuildDeps(args) {
  return run(process.execPath, ['--experimental-loader', rejectBuildDepsLoader, cliPath, ...args], {
    cwd: repoRoot,
  });
}

async function failure(args) {
  try {
    await cli(args);
  } catch (error) {
    return error;
  }

  throw new Error(`Expected ogis ${args.join(' ')} to fail`);
}

describe('parseDeployOptions', () => {
  it('parses deployment flags and a server override', () => {
    expect(
      parseDeployOptions([
        '--dry-run',
        '--skip-certbot',
        '--skip-smoke',
        '--allow-degraded',
        '--require-ready',
        '--server=192.0.2.10',
      ]),
    ).toEqual({
      dryRun: true,
      skipCertbot: true,
      skipSmoke: true,
      allowDegraded: true,
      requireReady: true,
      server: '192.0.2.10',
    });
  });

  it('rejects unknown flags, values on booleans and missing values', () => {
    expect(() => parseDeployOptions(['--nope'])).toThrow(/Unknown option/);
    expect(() => parseDeployOptions(['--dry-run=yes'])).toThrow(/does not take a value/);
    expect(() => parseDeployOptions(['--server'])).toThrow(/requires a value/);
    expect(() => parseDeployOptions(['stray'])).toThrow(/Unexpected argument/);
  });
});

describe('parseSourceOptions', () => {
  it('parses promote and rollback flags', () => {
    expect(
      parseSourceOptions([
        '--source',
        'pois',
        '--dry-run',
        '--server-side',
        '--skip-smoke',
        '--data-dir',
        '/tmp/data',
        '--incoming-dir=/tmp/incoming',
        '--app-dir',
        '/opt/ogis-tiles',
      ]),
    ).toEqual({
      source: 'pois',
      dryRun: true,
      serverSide: true,
      skipSmoke: true,
      dataDir: '/tmp/data',
      incomingDir: '/tmp/incoming',
      appDir: '/opt/ogis-tiles',
    });
  });

  it('rejects unknown flags and missing values', () => {
    expect(() => parseSourceOptions(['--source'])).toThrow(/requires a value/);
    expect(() => parseSourceOptions(['--nope'])).toThrow(/Unknown option/);
  });
});

describe('parseStatusOptions', () => {
  it('parses status flags', () => {
    expect(parseStatusOptions(['--cloud-only', '--json', '--host', 'tiles.example.com'])).toEqual({
      cloudOnly: true,
      json: true,
      host: 'tiles.example.com',
    });
  });

  it('rejects conflicting scopes', () => {
    expect(() => parseStatusOptions(['--cloud-only', '--server-only'])).toThrow(
      /cannot be used together/,
    );
  });
});

describe('ogis CLI', () => {
  it.each([
    ['deploy', 'Usage: ogis deploy'],
    ['promote', 'Usage: ogis promote'],
    ['rollback', 'Usage: ogis rollback'],
    ['status', 'Usage: ogis status'],
  ])('prints help for %s', async (command, expected) => {
    const { stdout } = await cli([command, '--help']);
    expect(stdout).toContain(expected);
  });

  it.each([
    ['--help', 'Usage: ogis <command>'],
    ['promote --help', 'Usage: ogis promote'],
    ['rollback --help', 'Usage: ogis rollback'],
    ['status --help', 'Usage: ogis status'],
  ])('runs "%s" without loading build-only dependencies', async (command, expected) => {
    const args = command.split(' ');
    const { stdout } = await cliWithoutBuildDeps(args);

    expect(stdout).toContain(expected);
  });

  it('fails with a clear stderr message and exit code 1 for unknown options', async () => {
    const error = await failure(['deploy', '--bogus']);

    expect(error.code).toBe(1);
    expect(error.stderr).toContain('Unknown option "--bogus"');
  });

  it('requires --source for promote before touching the environment', async () => {
    const error = await failure(['promote']);

    expect(error.code).toBe(1);
    expect(error.stderr).toContain('--source is required');
  });

  it('rejects conflicting status scopes before touching the environment', async () => {
    const error = await failure(['status', '--cloud-only', '--server-only']);

    expect(error.code).toBe(1);
    expect(error.stderr).toContain('cannot be used together');
  });

  it('rejects an invalid source name before touching the environment', async () => {
    for (const command of ['promote', 'rollback']) {
      const error = await failure([command, '--source', 'Bad_Name']);

      expect(error.code).toBe(1);
      expect(error.stderr).toContain('is invalid');
    }
  });

  it('requires --source for rollback', async () => {
    const error = await failure(['rollback']);

    expect(error.code).toBe(1);
    expect(error.stderr).toContain('--source is required');
  });

  it('rejects values passed to boolean flags', async () => {
    const error = await failure(['deploy', '--skip-smoke=yes']);

    expect(error.code).toBe(1);
    expect(error.stderr).toContain('does not take a value');
  });

  it('rejects missing values for status and deploy options', async () => {
    const statusError = await failure(['status', '--server']);

    expect(statusError.code).toBe(1);
    expect(statusError.stderr).toContain('--server requires a value');

    const deployError = await failure(['deploy', '--server']);

    expect(deployError.code).toBe(1);
    expect(deployError.stderr).toContain('--server requires a value');
  });

  it('fails with a clear message for an unknown command', async () => {
    const error = await failure(['unknown']);

    expect(error.code).toBe(1);
    expect(error.stderr).toContain('Unknown command "unknown"');
  });
});
