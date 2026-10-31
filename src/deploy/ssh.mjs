import { runCommand } from '../build/exec.mjs';
import { childEnvironment } from '../provision/provision.mjs';

import { DeployError } from './config.mjs';

const SAFE_SHELL_ARGUMENT = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function quoteIfNeeded(value) {
  const text = String(value);
  return SAFE_SHELL_ARGUMENT.test(text) ? text : shellQuote(text);
}

export function sshOptions(config) {
  const options = [];

  if (config.deployPrivateKeyPath) {
    options.push('-i', config.deployPrivateKeyPath);
  }

  options.push(
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
  );

  return options;
}

export function sshArguments(config, remoteCommand) {
  return [...sshOptions(config), `${config.deployUser}@${config.targetHost}`, remoteCommand];
}

export function rsyncSshCommand(config) {
  return ['ssh', ...sshOptions(config).map(quoteIfNeeded)].join(' ');
}

export async function runRemote(
  config,
  remoteCommand,
  { execImpl = runCommand, env = process.env, timeoutMs, label } = {},
) {
  try {
    return await execImpl('ssh', sshArguments(config, remoteCommand), {
      encoding: 'utf8',
      env: childEnvironment(env),
      timeoutMs,
    });
  } catch (error) {
    const description = label ?? 'SSH command';
    throw new DeployError(
      `${description} failed on ${config.deployUser}@${config.targetHost}: ${error.message}`,
      { cause: error },
    );
  }
}

function missingFile(error) {
  const exitCode = error?.exitCode ?? error?.code;
  const stderr = String(error?.stderr ?? '').trim();

  return exitCode === 1 && stderr === '';
}

export async function remoteFileExists(
  config,
  targetPath,
  { execImpl = runCommand, env = process.env, timeoutMs } = {},
) {
  try {
    await execImpl('ssh', sshArguments(config, `sudo -n test -f ${shellQuote(targetPath)}`), {
      encoding: 'utf8',
      env: childEnvironment(env),
      timeoutMs,
    });
    return true;
  } catch (error) {
    if (missingFile(error)) {
      return false;
    }

    throw new DeployError(
      `Unable to check ${targetPath} on ${config.deployUser}@${config.targetHost}: ${error.message}`,
      { cause: error },
    );
  }
}

export function base64WriteCommand(targetPath, content) {
  const encoded = Buffer.from(String(content), 'utf8').toString('base64');
  const target = shellQuote(targetPath);

  return [
    `printf %s ${encoded} | base64 -d | sudo tee ${target} >/dev/null`,
    `sudo chmod 0644 ${target}`,
    `sudo chown root:root ${target}`,
  ].join(' && ');
}
