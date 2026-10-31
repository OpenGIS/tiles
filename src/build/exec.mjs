import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { CommandError } from './errors.mjs';

const defaultExecFile = promisify(execFile);

export function commandLine(command, args) {
  return [command, ...args]
    .map((part) => (String(part).includes(' ') ? `"${part}"` : part))
    .join(' ');
}

function firstLine(value) {
  if (value === undefined || value === null) {
    return '';
  }

  return (
    String(value)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  );
}

export async function runCommand(
  command,
  args,
  {
    execFileImpl = defaultExecFile,
    cwd,
    env,
    encoding = 'utf8',
    maxBuffer = 16 * 1024 * 1024,
  } = {},
) {
  try {
    const result = await execFileImpl(command, args, { cwd, env, encoding, maxBuffer });
    return {
      stdout: result?.stdout ?? '',
      stderr: result?.stderr ?? '',
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new CommandError(`Unable to run "${command}": executable not found on PATH`, {
        command: commandLine(command, args),
        exitCode: null,
        stderr: '',
        cause: error,
      });
    }

    const stderr = error?.stderr ?? '';
    const detail = firstLine(stderr) || firstLine(error?.message);
    const exitCode = typeof error?.code === 'number' ? error.code : null;
    const suffix = detail === '' ? '' : `: ${detail}`;

    throw new CommandError(`Command failed (${commandLine(command, args)})${suffix}`, {
      command: commandLine(command, args),
      exitCode,
      stderr: String(stderr),
      cause: error,
    });
  }
}
