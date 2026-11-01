import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  detectRsync,
  MODEL_EXCLUDES,
  MODEL_INCLUDES,
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

  it('excludes .env files at any depth and not just the repository root', () => {
    const args = rsyncArguments({
      repoRoot: '/repo',
      config: CONFIG,
      rsync: { command: 'rsync', protectArgs: true },
    });

    expect(args).toContain('--exclude=.env*');
    expect(args).not.toContain('--exclude=/.env');
    expect(args.indexOf('--exclude=.env*')).toBeLessThan(args.indexOf('--include=/src/***'));
  });
});

const RSYNC_AVAILABLE = spawnSync('rsync', ['--version'], { encoding: 'utf8' }).status === 0;

describe.skipIf(!RSYNC_AVAILABLE)('model sync filter', () => {
  it('drops a nested .env.local while copying a normal config file', () => {
    const scratchRoot = join(process.cwd(), '.opencode', 'tmp');
    mkdirSync(scratchRoot, { recursive: true });

    const root = mkdtempSync(join(scratchRoot, 'rsync-filter-'));
    const source = join(root, 'source');
    const destination = join(root, 'destination');

    try {
      mkdirSync(join(source, 'src', 'config'), { recursive: true });
      mkdirSync(destination, { recursive: true });
      writeFileSync(join(source, 'src', 'config', 'layers.json'), '{"layers":[]}\n');
      writeFileSync(join(source, 'src', 'config', '.env.local'), 'SECRET=1\n');
      writeFileSync(join(source, 'package.json'), '{}\n');

      execFileSync('rsync', [
        '--archive',
        ...MODEL_EXCLUDES,
        ...MODEL_INCLUDES,
        '--exclude=*',
        `${source}/`,
        `${destination}/`,
      ]);

      expect(existsSync(join(destination, 'src', 'config', 'layers.json'))).toBe(true);
      expect(existsSync(join(destination, 'package.json'))).toBe(true);
      expect(existsSync(join(destination, 'src', 'config', '.env.local'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
