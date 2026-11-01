import { runCommand } from '../build/exec.mjs';

import { DeployError } from './config.mjs';
import { rsyncSshCommand, shellQuote } from './ssh.mjs';

const CANDIDATE_COMMANDS = ['rsync', '/opt/homebrew/bin/rsync', '/usr/local/bin/rsync'];
const SAFE_REMOTE_ARGUMENT = /^[A-Za-z0-9_@%+=:,./-]+$/;
const VERSION_PATTERN = /rsync\s+version\s+(\d+)\.(\d+)(?:\.(\d+))?/i;

export const MODEL_EXCLUDES = [
  '--exclude=/data/',
  '--exclude=/node_modules/',
  '--exclude=/.git/',
  '--exclude=/dev/',
  '--exclude=/test/',
  '--exclude=/tmp/',
  '--exclude=/dist/',
  '--exclude=.env*',
  '--exclude=/.opencode/',
];

export const MODEL_INCLUDES = [
  '--include=/src/',
  '--include=/src/***',
  '--include=/bin/',
  '--include=/bin/***',
  '--include=/config/',
  '--include=/config/***',
  '--include=/package.json',
  '--include=/package-lock.json',
];

export function parseRsyncVersion(output) {
  const text = String(output ?? '');
  const openrsync = /openrsync/i.test(text);
  const match = VERSION_PATTERN.exec(text);

  if (!match) {
    return { openrsync, version: null, compatible: false };
  }

  const version = `${match[1]}.${match[2]}${match[3] ? `.${match[3]}` : ''}`;

  return {
    openrsync,
    version,
    compatible: !openrsync && Number(match[1]) >= 3,
  };
}

export async function detectRsync({
  execImpl = runCommand,
  env = process.env,
  candidates = CANDIDATE_COMMANDS,
} = {}) {
  const failures = [];
  let fallback = null;

  for (const command of [...new Set(candidates)]) {
    let stdout;

    try {
      ({ stdout } = await execImpl(command, ['--version'], { encoding: 'utf8', env }));
    } catch (error) {
      failures.push(`${command}: ${error.message}`);
      continue;
    }

    const info = { command, ...parseRsyncVersion(stdout) };

    if (info.compatible) {
      return { ...info, protectArgs: true };
    }

    fallback ??= { ...info, protectArgs: false };
  }

  if (fallback) {
    return fallback;
  }

  throw new DeployError(`Unable to find a usable rsync (${failures.join('; ')})`);
}

export function describeRsync(rsyncInfo) {
  const label = rsyncInfo.protectArgs ? 'rsync 3.x, --protect-args' : 'fallback, no --protect-args';
  const version = rsyncInfo.version ? ` ${rsyncInfo.version}` : '';

  return `${rsyncInfo.command}${version} (${label})`;
}

export function rsyncDestination(config, { protectArgs = true } = {}) {
  const prefix = `${config.deployUser}@${config.targetHost}:`;
  const target = `${config.appDir}/`;

  if (/[\0\r\n]/.test(target)) {
    throw new DeployError('The remote deployment directory must not contain control characters');
  }

  if (protectArgs) {
    return `${prefix}${target}`;
  }

  return `${prefix}${SAFE_REMOTE_ARGUMENT.test(target) ? target : shellQuote(target)}`;
}

export function rsyncArguments({ repoRoot, config, rsync }) {
  const args = ['--archive', '--compress', '--delete', '--human-readable'];

  if (rsync.protectArgs) {
    args.push('--protect-args');
  }

  args.push(
    ...MODEL_EXCLUDES,
    ...MODEL_INCLUDES,
    '--exclude=*',
    '-e',
    rsyncSshCommand(config),
    `${repoRoot}/`,
    rsyncDestination(config, { protectArgs: rsync.protectArgs }),
  );

  return args;
}
