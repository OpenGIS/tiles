import { describe, expect, it, vi } from 'vitest';

import {
  detectRsync,
  parseRsyncVersion,
  rsyncArguments,
  rsyncDestination,
} from '../../../src/deploy/rsync.mjs';

const CONFIG = {
  deployUser: 'deploy',
  targetHost: 'tile.ogis.app',
  appDir: '/opt/ogis-tiles',
};

describe('parseRsyncVersion', () => {
  it('recognises a compatible rsync 3.x', () => {
    expect(parseRsyncVersion('rsync  version 3.2.7  protocol version 31')).toMatchObject({
      compatible: true,
      openrsync: false,
      version: '3.2.7',
    });
  });

  it('rejects openrsync even when it reports a compatible protocol', () => {
    expect(
      parseRsyncVersion('openrsync: protocol version 29\nrsync version 2.6.9 compatible'),
    ).toMatchObject({ compatible: false, openrsync: true, version: '2.6.9' });
  });

  it('rejects unparseable output', () => {
    expect(parseRsyncVersion('something else')).toMatchObject({ compatible: false, version: null });
  });
});

describe('detectRsync', () => {
  it('prefers a compatible rsync 3.x over an earlier openrsync', async () => {
    const execImpl = vi.fn(async (command) => {
      if (command === 'rsync') {
        return { stdout: 'openrsync: protocol version 29\n', stderr: '' };
      }

      return { stdout: 'rsync  version 3.2.7  protocol version 31\n', stderr: '' };
    });

    const info = await detectRsync({
      execImpl,
      candidates: ['rsync', '/opt/homebrew/bin/rsync'],
    });

    expect(info).toMatchObject({
      command: '/opt/homebrew/bin/rsync',
      protectArgs: true,
      version: '3.2.7',
    });
  });

  it('falls back to the first runnable rsync without --protect-args', async () => {
    const execImpl = vi.fn(async (command) => {
      if (command === '/opt/homebrew/bin/rsync') {
        throw new Error('not installed');
      }

      return { stdout: 'openrsync: protocol version 29\n', stderr: '' };
    });

    const info = await detectRsync({
      execImpl,
      candidates: ['rsync', '/opt/homebrew/bin/rsync'],
    });

    expect(info).toMatchObject({ command: 'rsync', protectArgs: false });
  });

  it('throws when no rsync is runnable', async () => {
    const execImpl = vi.fn(async () => {
      throw new Error('missing');
    });

    await expect(detectRsync({ execImpl, candidates: ['rsync'] })).rejects.toThrow(
      /Unable to find a usable rsync/,
    );
  });
});

describe('rsyncDestination', () => {
  it('leaves a safe protected destination unchanged', () => {
    expect(rsyncDestination(CONFIG)).toBe('deploy@tile.ogis.app:/opt/ogis-tiles/');
  });

  it('quotes an unsafe path in fallback mode', () => {
    expect(rsyncDestination({ ...CONFIG, appDir: '/opt/ogis tiles' }, { protectArgs: false })).toBe(
      "deploy@tile.ogis.app:'/opt/ogis tiles/'",
    );
  });

  it('leaves a safe path unquoted in fallback mode', () => {
    expect(rsyncDestination(CONFIG, { protectArgs: false })).toBe(
      'deploy@tile.ogis.app:/opt/ogis-tiles/',
    );
  });
});

describe('rsyncArguments', () => {
  it('adds --protect-args only for a compatible rsync', () => {
    const protectedArgs = rsyncArguments({
      repoRoot: '/repo',
      config: CONFIG,
      rsync: { command: 'rsync', protectArgs: true },
    });
    const fallbackArgs = rsyncArguments({
      repoRoot: '/repo',
      config: CONFIG,
      rsync: { command: 'rsync', protectArgs: false },
    });

    expect(protectedArgs).toContain('--protect-args');
    expect(fallbackArgs).not.toContain('--protect-args');
    expect(protectedArgs.at(-1)).toBe('deploy@tile.ogis.app:/opt/ogis-tiles/');
  });
});
