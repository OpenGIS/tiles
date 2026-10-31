import { describe, expect, it, vi } from 'vitest';

import {
  base64WriteCommand,
  quoteIfNeeded,
  redactRemoteError,
  remoteFileExists,
  rsyncSshCommand,
  runRemote,
  shellQuote,
  sshOptions,
} from '../../../src/deploy/ssh.mjs';

const CONFIG = {
  deployUser: 'deploy',
  targetHost: 'tile.ogis.app',
  deployPrivateKeyPath: '/home/joe/.ssh/ogis_tiles',
};

describe('shellQuote', () => {
  it('quotes plain values and escapes embedded single quotes', () => {
    expect(shellQuote('/opt/ogis-tiles')).toBe("'/opt/ogis-tiles'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote('')).toBe("''");
  });
});

describe('quoteIfNeeded', () => {
  it('leaves safe values unquoted and quotes values with whitespace', () => {
    expect(quoteIfNeeded('/usr/local/bin/node')).toBe('/usr/local/bin/node');
    expect(quoteIfNeeded('/opt/my tools/node')).toBe("'/opt/my tools/node'");
  });
});

describe('sshOptions', () => {
  it('includes the deploy key and safe batch-mode options', () => {
    const options = sshOptions(CONFIG);

    expect(options).toEqual([
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
    ]);
  });

  it('omits the identity option when no key is configured', () => {
    expect(sshOptions({ ...CONFIG, deployPrivateKeyPath: '' })).not.toContain('-i');
  });
});

describe('rsyncSshCommand', () => {
  it('renders a shell-safe ssh command', () => {
    expect(rsyncSshCommand(CONFIG)).toBe(
      'ssh -i /home/joe/.ssh/ogis_tiles -o BatchMode=yes -o StrictHostKeyChecking=accept-new ' +
        '-o ConnectTimeout=5 -o ServerAliveInterval=15 -o ServerAliveCountMax=4',
    );
    expect(
      rsyncSshCommand({ ...CONFIG, deployPrivateKeyPath: '/home/joe/my keys/deploy' }),
    ).toContain("'/home/joe/my keys/deploy'");
  });
});

describe('base64WriteCommand', () => {
  it('writes encoded content to a shell-quoted root-owned path', () => {
    const command = base64WriteCommand('/etc/nginx/sites-available/my tile', 'server {}\n');
    const encoded = Buffer.from('server {}\n', 'utf8').toString('base64');

    expect(command).toContain(`printf %s ${encoded} | base64 -d`);
    expect(command).toContain("sudo tee '/etc/nginx/sites-available/my tile' >/dev/null");
    expect(command).toContain("sudo chmod 0644 '/etc/nginx/sites-available/my tile'");
    expect(command).toContain("sudo chown root:root '/etc/nginx/sites-available/my tile'");
  });
});

describe('redactRemoteError', () => {
  it('removes the remote command and private key material from an SSH error', () => {
    const material =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nsecret\n-----END OPENSSH PRIVATE KEY-----';
    const remoteCommand = `printf %s ${Buffer.from(material).toString('base64')} | base64 -d`;
    const message = `Command failed (ssh deploy@example "${remoteCommand}"): ${material}`;

    const redacted = redactRemoteError(message, remoteCommand);

    expect(redacted).toContain('[remote command redacted]');
    expect(redacted).toContain('[private key redacted]');
    expect(redacted).not.toContain('secret');
    expect(redacted).not.toContain(Buffer.from(material).toString('base64'));
  });

  it('does not include the remote command in runRemote errors', async () => {
    const remoteCommand = 'printf secret-key-material';
    const execImpl = vi.fn(async () => {
      throw new Error(`Command failed (ssh deploy@example "${remoteCommand}")`);
    });

    await expect(
      runRemote(CONFIG, remoteCommand, {
        execImpl,
        env: { PATH: '/usr/bin' },
      }),
    ).rejects.toThrow(/remote command redacted/);
  });
});

describe('remoteFileExists', () => {
  it('treats exit code 1 as a missing file and checks with sudo', async () => {
    const execImpl = vi.fn(async () => {
      const error = new Error('exit 1');
      error.exitCode = 1;
      throw error;
    });

    await expect(
      remoteFileExists(CONFIG, '/etc/letsencrypt/live/x/fullchain.pem', { execImpl }),
    ).resolves.toBe(false);

    const [, args] = execImpl.mock.calls[0];
    expect(args.at(-1)).toBe("sudo -n test -f '/etc/letsencrypt/live/x/fullchain.pem'");
  });

  it('returns true when the file exists', async () => {
    const execImpl = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });

    await expect(remoteFileExists(CONFIG, '/etc/x', { execImpl })).resolves.toBe(true);
  });

  it('throws for permission and SSH failures instead of reporting a missing file', async () => {
    const execImpl = vi.fn(async () => {
      const error = new Error('spawn ssh EACCES');
      error.code = 'EACCES';
      throw error;
    });

    await expect(remoteFileExists(CONFIG, '/etc/x', { execImpl })).rejects.toThrow(
      /Unable to check \/etc\/x/,
    );
  });

  it('throws when sudo denies the test instead of reporting a missing file', async () => {
    const execImpl = vi.fn(async () => {
      const error = new Error('sudo: a password is required');
      error.exitCode = 1;
      error.stderr = 'sudo: a password is required\n';
      throw error;
    });

    await expect(remoteFileExists(CONFIG, '/etc/x', { execImpl })).rejects.toThrow(
      /Unable to check \/etc\/x.*sudo: a password is required/,
    );
  });
});
