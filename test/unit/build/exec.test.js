import { describe, expect, it, vi } from 'vitest';

import { CommandError } from '../../../src/build/errors.mjs';
import { commandLine, runCommand } from '../../../src/build/exec.mjs';

describe('runCommand', () => {
  it('passes the command, arguments and options to child_process', async () => {
    const execFileImpl = vi.fn().mockResolvedValue({ stdout: 'ok', stderr: '' });

    const result = await runCommand('osmium', ['fileinfo', '-e', '/tmp/osm.pbf'], {
      execFileImpl,
      cwd: '/repo',
      env: { PATH: '/bin' },
    });

    expect(result).toEqual({ stdout: 'ok', stderr: '' });
    expect(execFileImpl).toHaveBeenCalledWith('osmium', ['fileinfo', '-e', '/tmp/osm.pbf'], {
      cwd: '/repo',
      env: { PATH: '/bin' },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
  });

  it('returns binary stdout unchanged', async () => {
    const bytes = Buffer.from([0x1f, 0x8b, 0x00]);
    const execFileImpl = vi.fn().mockResolvedValue({ stdout: bytes, stderr: '' });

    await expect(
      runCommand('pmtiles', ['tile', 'archive.pmtiles', '1', '2', '3'], {
        execFileImpl,
        encoding: null,
      }),
    ).resolves.toEqual({ stdout: bytes, stderr: '' });
  });

  it('turns a child_process failure into a one-line CommandError', async () => {
    const error = new Error('Command failed: java -jar planetiler.jar');
    error.code = 1;
    error.stderr = 'BUILD-FAILED: out of memory\nsecond line';
    const execFileImpl = vi.fn().mockRejectedValue(error);

    await expect(
      runCommand('java', ['-jar', '/tools/planetiler.jar'], { execFileImpl }),
    ).rejects.toMatchObject({
      name: 'CommandError',
      exitCode: 1,
      stderr: 'BUILD-FAILED: out of memory\nsecond line',
    });

    await expect(
      runCommand('java', ['-jar', '/tools/planetiler.jar'], { execFileImpl }),
    ).rejects.toThrow(/BUILD-FAILED: out of memory/);
  });

  it('marks failures without a detail without a trailing colon', async () => {
    const error = new Error('');
    const execFileImpl = vi.fn().mockRejectedValue(error);

    await expect(
      runCommand('pmtiles', ['verify', 'archive.pmtiles'], { execFileImpl }),
    ).rejects.toThrow(/^Command failed \(pmtiles verify archive\.pmtiles\)$/);
  });
});

describe('commandLine', () => {
  it('quotes arguments containing spaces', () => {
    expect(commandLine('java', ['-jar', '/tmp/my tools/planetiler.jar'])).toBe(
      'java -jar "/tmp/my tools/planetiler.jar"',
    );
  });

  it('exports CommandError for callers', () => {
    expect(new CommandError('failed')).toBeInstanceOf(Error);
  });
});
