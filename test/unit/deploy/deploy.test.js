import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { resolveDeployConfig } from '../../../src/deploy/config.mjs';
import { runDeploy } from '../../../src/deploy/deploy.mjs';
import { loadConfig } from '../../../src/lib/config.mjs';
import { repoRoot } from '../../helpers/temp.mjs';

const layersConfig = loadConfig(path.join(repoRoot, 'config', 'layers.json'), { repoRoot });

const BASE_ENV = {
  TILE_SERVER_HOST: 'tile.ogis.app',
  TILE_SERVER_IP: '128.140.70.114',
  SSH_PRIVATE_KEY_PATH: '/home/joe/.ssh/ogis_tiles',
  DEPLOY_USER: 'deploy',
  CERTBOT_EMAIL: 'ops@example.com',
  PATH: '/usr/bin:/bin',
  HOME: '/home/joe',
};

function configFor(overrides = {}) {
  return resolveDeployConfig({ env: { ...BASE_ENV, ...overrides } });
}

function makeOut() {
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

function makeExec({ certExists = false, active = 'active', enabled = true } = {}) {
  return vi.fn(async (command, args) => {
    if (command === 'rsync') {
      if (args?.includes('--version')) {
        return { stdout: 'rsync  version 3.2.7  protocol version 31\n', stderr: '' };
      }

      return { stdout: '', stderr: '' };
    }

    if (command === 'ssh') {
      const remote = args[args.length - 1];

      if (
        remote.includes('sudo -n test -f') &&
        remote.includes('/etc/letsencrypt/live/') &&
        !certExists
      ) {
        const error = new Error('certificate missing');
        error.code = 1;
        error.stderr = '';
        throw error;
      }

      if (remote.startsWith('systemctl is-active')) {
        return { stdout: `${active}\n`, stderr: '' };
      }

      if (remote.startsWith('systemctl is-enabled')) {
        return { stdout: `${enabled ? 'enabled' : 'disabled'}\n`, stderr: '' };
      }

      if (remote.startsWith('err=$(sudo -n test -f')) {
        return { stdout: 'present\n', stderr: '' };
      }

      if (remote.startsWith('sudo -n readlink')) {
        return { stdout: '/etc/nginx/sites-available/tile.ogis.app\n', stderr: '' };
      }

      return { stdout: '', stderr: '' };
    }

    throw new Error(`Unexpected command ${command}`);
  });
}

function makeFetch(statuses = {}) {
  const values = { health: 200, sources: 200, ready: 503, ...statuses };

  return vi.fn(async (url) => {
    const key = ['health', 'sources', 'ready'].find((name) => url.endsWith(`/${name}`));
    return { status: values[key] ?? 200, ok: (values[key] ?? 200) < 400 };
  });
}

function remotes(execImpl) {
  return execImpl.mock.calls
    .filter(([command]) => command === 'ssh')
    .map(([, args]) => args[args.length - 1]);
}

function installedUnit(execImpl) {
  const remote = remotes(execImpl).find(
    (command) =>
      command.includes('/etc/systemd/system/ogis-tiles.service') && command.includes('base64 -d'),
  );
  const encoded = /printf %s ([A-Za-z0-9+/=]+) \| base64 -d/.exec(remote)[1];
  return Buffer.from(encoded, 'base64').toString('utf8');
}

function indexOf(remotesList, pattern) {
  return remotesList.findIndex((remote) =>
    typeof pattern === 'string' ? remote.includes(pattern) : pattern.test(remote),
  );
}

function baseRun(overrides = {}) {
  return {
    config: configFor(),
    layersConfig,
    repoRoot,
    options: {},
    execImpl: makeExec(),
    fetchImpl: makeFetch(),
    env: BASE_ENV,
    out: makeOut(),
    ...overrides,
  };
}

describe('runDeploy', () => {
  it('makes no remote changes during a dry run and reports the rsync mode', async () => {
    const execImpl = makeExec();
    const fetchImpl = makeFetch();
    const out = makeOut();

    const result = await runDeploy(
      baseRun({ execImpl, fetchImpl, out, options: { dryRun: true } }),
    );

    expect(result.dryRun).toBe(true);
    expect(execImpl.mock.calls).toEqual([['rsync', ['--version'], expect.any(Object)]]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.text()).toContain('dry run');
    expect(out.text()).toContain('Rsync: rsync 3.2.7 (rsync 3.x, --protect-args)');
    expect(out.text()).toContain('npm ci --omit=dev');
    expect(out.text()).toContain('systemctl');
    expect(out.text()).toContain('certbot');
    expect(out.text()).toContain('Nginx cache: /var/cache/nginx');
    expect(out.text()).toContain('Nginx cache owner: www-data:www-data');
    for (const name of ['pois', 'routes', 'paths', 'contours']) {
      expect(out.text()).toContain(`/var/cache/nginx/${name}`);
    }
    expect(out.text()).toContain('No changes were made');
  });

  it('creates the nginx cache directories before installing and validating nginx', async () => {
    for (const certExists of [false, true]) {
      const execImpl = makeExec({ certExists });

      await runDeploy(baseRun({ execImpl }));

      const list = remotes(execImpl);
      const cache = list.find((remote) => remote.includes('/var/cache/nginx'));
      const install = list.findIndex(
        (remote) =>
          remote.includes('/etc/nginx/sites-available/tile.ogis.app') &&
          remote.includes('base64 -d'),
      );
      const validation = indexOf(list, 'nginx -t');

      expect(cache).toContain('sudo -n install -d -o www-data -g www-data -m 0755');
      expect(cache).not.toMatch(/-o nginx|-g nginx/);
      expect(cache).toContain("'/var/cache/nginx'");
      for (const name of ['pois', 'routes', 'paths', 'contours']) {
        expect(cache).toContain(`'/var/cache/nginx/${name}'`);
      }

      const cacheIndex = list.indexOf(cache);
      expect(cacheIndex).toBeGreaterThanOrEqual(0);
      expect(install).toBeGreaterThanOrEqual(0);
      expect(cacheIndex).toBeLessThan(install);
      expect(cacheIndex).toBeLessThan(validation);
    }
  });

  it('rsyncs only runtime files and preserves server data', async () => {
    const execImpl = makeExec({ certExists: true });

    await runDeploy(baseRun({ execImpl }));

    const rsync = execImpl.mock.calls.find(
      ([command, args]) => command === 'rsync' && !args.includes('--version'),
    );
    const args = rsync[1];

    expect(args).toContain('--exclude=/data/');
    expect(args).toContain('--exclude=/node_modules/');
    expect(args).toContain('--exclude=/.git/');
    expect(args).toContain('--exclude=/dev/');
    expect(args).toContain('--exclude=/test/');
    expect(args).toContain('--exclude=/tmp/');
    expect(args).toContain('--exclude=/dist/');
    expect(args).toContain('--exclude=/.env');
    expect(args).toContain('--exclude=/.opencode/');
    expect(args).toContain('--protect-args');
    expect(args).toContain('--include=/src/***');
    expect(args).toContain('--include=/bin/***');
    expect(args).toContain('--include=/config/***');
    expect(args).toContain('--include=/package.json');
    expect(args).toContain('--include=/package-lock.json');
    expect(args.at(-1)).toBe('deploy@tile.ogis.app:/opt/ogis-tiles/');
  });

  it('falls back to rsync without --protect-args and quotes an unsafe destination', async () => {
    const execImpl = makeExec({ certExists: true });
    const original = execImpl.getMockImplementation();

    execImpl.mockImplementation(async (command, args) => {
      if (command === 'rsync' && args.includes('--version')) {
        return {
          stdout: 'openrsync: protocol version 29\nrsync version 2.6.9 compatible\n',
          stderr: '',
        };
      }

      return original(command, args);
    });

    await runDeploy(
      baseRun({
        execImpl,
        config: configFor({ TILE_APP_DIR: '/opt/ogis tiles' }),
      }),
    );

    const rsync = execImpl.mock.calls.find(
      ([command, args]) => command === 'rsync' && !args.includes('--version'),
    );

    expect(rsync[1]).not.toContain('--protect-args');
    expect(rsync[1].at(-1)).toBe("deploy@tile.ogis.app:'/opt/ogis tiles/'");
  });

  it('fails preflight when no usable rsync is available', async () => {
    const execImpl = vi.fn(async (command) => {
      if (command === 'rsync') {
        throw new Error('rsync missing');
      }

      throw new Error(`Unexpected command ${command}`);
    });

    await expect(runDeploy(baseRun({ execImpl }))).rejects.toThrow(/Unable to find a usable rsync/);
    expect(execImpl.mock.calls.some(([command]) => command === 'ssh')).toBe(false);
  });

  it('renders PUBLIC_BASE_URL into the systemd unit', async () => {
    const execImpl = makeExec({ certExists: true });

    await runDeploy(baseRun({ execImpl }));

    expect(installedUnit(execImpl)).toContain('Environment=PUBLIC_BASE_URL=https://tile.ogis.app');
  });

  it('installs dependencies as the deploy user without copying node_modules', async () => {
    const execImpl = makeExec({ certExists: true });

    await runDeploy(baseRun({ execImpl }));

    const npm = remotes(execImpl).find((remote) => remote.includes('npm'));
    expect(npm).toContain('sudo -u deploy');
    expect(npm).toContain('/usr/local/bin/npm ci --omit=dev');
    expect(npm).toContain('PATH=/usr/local/bin:/usr/bin:/bin');
    expect(npm).not.toContain('node_modules');
  });

  it('puts the custom Node bin directory first on PATH', async () => {
    const execImpl = makeExec({ certExists: true });

    await runDeploy(
      baseRun({
        execImpl,
        config: configFor({ NODE_BIN: '/opt/node 24/bin/node' }),
      }),
    );

    const npm = remotes(execImpl).find((remote) => remote.includes('ci --omit=dev'));
    expect(npm).toContain("PATH='/opt/node 24/bin:/usr/local/bin:/usr/bin:/bin'");
    expect(npm).toContain("'/opt/node 24/bin/npm' ci --omit=dev");
  });

  it('orders systemd, nginx and certbot steps safely', async () => {
    const execImpl = makeExec({ certExists: false });

    const result = await runDeploy(baseRun({ execImpl }));

    const list = remotes(execImpl);
    const daemonReload = indexOf(list, 'systemctl daemon-reload');
    const enable = indexOf(list, 'systemctl enable --now');
    const restart = indexOf(list, 'systemctl restart');
    const firstNginxTest = indexOf(list, 'nginx -t');
    const firstReload = indexOf(list, 'systemctl reload nginx');
    const certbot = indexOf(list, 'certbot certonly');
    const lastNginxTest = list.map((r) => r.includes('nginx -t')).lastIndexOf(true);

    expect(daemonReload).toBeGreaterThanOrEqual(0);
    expect(enable).toBeGreaterThan(daemonReload);
    expect(restart).toBeGreaterThan(enable);
    expect(firstNginxTest).toBeGreaterThan(restart);
    expect(firstReload).toBeGreaterThan(firstNginxTest);
    expect(certbot).toBeGreaterThan(firstReload);
    expect(lastNginxTest).toBeGreaterThan(certbot);
    expect(list[certbot]).toContain('--webroot');
    expect(list[certbot]).toContain('-d tile.ogis.app');
    expect(list[certbot]).toContain("--email 'ops@example.com'");
    expect(list[certbot]).toContain('--agree-tos');
    expect(list[certbot]).toContain('--non-interactive');
    expect(list[certbot]).toContain("--deploy-hook 'systemctl reload nginx'");
    expect(result.tls).toBe(true);
  });

  it('reconciles the renewal deploy hook when a certificate already exists', async () => {
    const execImpl = makeExec({ certExists: true });

    const result = await runDeploy(baseRun({ execImpl }));

    const list = remotes(execImpl);
    const certbot = list.filter((remote) => remote.includes('certbot certonly'));

    expect(certbot).toHaveLength(1);
    expect(certbot[0]).toContain("--cert-name 'tile.ogis.app'");
    expect(certbot[0]).toContain('--keep-until-expiring');
    expect(certbot[0]).toContain("--deploy-hook 'systemctl reload nginx'");
    expect(list.filter((remote) => remote.includes('ln -sfn'))).toHaveLength(1);
    expect(result.certExists).toBe(true);
    expect(result.tls).toBe(true);
  });

  it('stays on HTTP when certbot is skipped and no certificate exists', async () => {
    const execImpl = makeExec({ certExists: false });
    const fetchImpl = makeFetch();

    const result = await runDeploy(
      baseRun({ execImpl, fetchImpl, options: { skipCertbot: true } }),
    );

    const list = remotes(execImpl);
    expect(list.some((remote) => remote.includes('certbot certonly'))).toBe(false);
    expect(result.tls).toBe(false);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://tile.ogis.app/health',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
  });

  it('requires CERTBOT_EMAIL before changing anything when a certificate is missing', async () => {
    const execImpl = makeExec({ certExists: false });

    await expect(
      runDeploy(baseRun({ execImpl, config: configFor({ CERTBOT_EMAIL: '' }) })),
    ).rejects.toThrow(/CERTBOT_EMAIL is required/);

    expect(
      execImpl.mock.calls.some(
        ([command, args]) => command === 'rsync' && args.includes('--archive'),
      ),
    ).toBe(false);
  });

  it('fails clearly when the server is unreachable', async () => {
    const execImpl = vi.fn(async (command, args) => {
      if (command === 'ssh' && args[args.length - 1] === 'true') {
        throw new Error('connection refused');
      }

      return { stdout: '', stderr: '' };
    });

    await expect(runDeploy(baseRun({ execImpl }))).rejects.toThrow(
      /Server reachability check failed.*connection refused/,
    );
  });

  it('fails when the service is not active', async () => {
    const execImpl = makeExec({ certExists: true, active: 'inactive' });

    await expect(runDeploy(baseRun({ execImpl }))).rejects.toThrow(/is not active/);
  });

  it('skips smoke checks on request', async () => {
    const fetchImpl = makeFetch();

    await runDeploy(baseRun({ fetchImpl, options: { skipSmoke: true } }));

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('requires /ready to be 200 with --require-ready', async () => {
    const fetchImpl = makeFetch({ ready: 503 });

    await expect(
      runDeploy(baseRun({ fetchImpl, options: { requireReady: true } })),
    ).rejects.toThrow(/--require-ready needs 200/);
  });

  it('allows a degraded /sources response with --allow-degraded', async () => {
    const fetchImpl = makeFetch({ sources: 503 });

    await expect(runDeploy(baseRun({ fetchImpl }))).rejects.toThrow(
      /use --allow-degraded to accept this/,
    );

    await expect(
      runDeploy(baseRun({ fetchImpl, options: { allowDegraded: true } })),
    ).resolves.toMatchObject({ tls: true });
  });

  it('treats a permission error during certificate detection as a failure', async () => {
    const execImpl = vi.fn(async (command, args) => {
      const remote = args[args.length - 1];

      if (command === 'ssh' && remote.includes('sudo -n test -f')) {
        const error = new Error('spawn ssh EACCES');
        error.code = 'EACCES';
        throw error;
      }

      return { stdout: '', stderr: '' };
    });

    await expect(runDeploy(baseRun({ execImpl }))).rejects.toThrow(
      /Unable to check \/etc\/letsencrypt\/live\/tile.ogis.app\/fullchain.pem/,
    );
  });

  it('restores the previous systemd unit when the service fails to start', async () => {
    const execImpl = makeExec({ certExists: true });
    const original = execImpl.getMockImplementation();
    let restarted = false;

    execImpl.mockImplementation(async (command, args) => {
      const remote = args?.[args.length - 1];

      if (
        command === 'ssh' &&
        remote === 'sudo systemctl restart ogis-tiles.service' &&
        !restarted
      ) {
        restarted = true;
        throw new Error('service failed to start');
      }

      return original(command, args);
    });

    await expect(runDeploy(baseRun({ execImpl }))).rejects.toThrow(
      /The previous unit was restored/,
    );

    const list = remotes(execImpl);
    expect(
      list.some((command) =>
        command.includes("sudo cp -a '/etc/systemd/system/ogis-tiles.service.ogis-backup'"),
      ),
    ).toBe(true);
    expect(list.some((command) => command === 'sudo systemctl enable ogis-tiles.service')).toBe(
      true,
    );
  });

  it('restores the previous nginx site when validation fails', async () => {
    const execImpl = makeExec({ certExists: true });
    const original = execImpl.getMockImplementation();
    let failed = false;

    execImpl.mockImplementation(async (command, args) => {
      const remote = args?.[args.length - 1];

      if (command === 'ssh' && remote === 'sudo nginx -t' && !failed) {
        failed = true;
        const error = new Error('nginx: invalid configuration');
        error.exitCode = 1;
        throw error;
      }

      return original(command, args);
    });

    await expect(runDeploy(baseRun({ execImpl }))).rejects.toThrow(
      /previous nginx configuration was restored/,
    );

    const list = remotes(execImpl);
    expect(
      list.some((command) =>
        command.includes("sudo cp -a '/etc/nginx/sites-available/tile.ogis.app.ogis-backup'"),
      ),
    ).toBe(true);
    expect(
      list.some((command) =>
        command.includes(
          "sudo ln -sfn '/etc/nginx/sites-available/tile.ogis.app' " +
            "'/etc/nginx/sites-enabled/tile.ogis.app'",
        ),
      ),
    ).toBe(true);
  });

  it('reports a truthful error when restoring the nginx site also fails', async () => {
    const execImpl = makeExec({ certExists: true });
    const original = execImpl.getMockImplementation();
    let failed = false;

    execImpl.mockImplementation(async (command, args) => {
      const remote = args?.[args.length - 1];

      if (command === 'ssh' && remote === 'sudo nginx -t' && !failed) {
        failed = true;
        const error = new Error('nginx: invalid configuration');
        error.exitCode = 1;
        throw error;
      }

      if (command === 'ssh' && remote.startsWith('sudo cp -a')) {
        throw new Error('read-only file system');
      }

      return original(command, args);
    });

    await expect(runDeploy(baseRun({ execImpl }))).rejects.toThrow(
      /Restoring the previous nginx configuration also failed:.*read-only file system/,
    );
  });

  it('aborts when the configuration backup cannot determine whether the file exists', async () => {
    const execImpl = makeExec({ certExists: true });
    const original = execImpl.getMockImplementation();

    execImpl.mockImplementation(async (command, args) => {
      const remote = args?.[args.length - 1];

      if (command === 'ssh' && remote.startsWith('err=$(sudo -n test -f')) {
        const error = new Error('sudo: a password is required');
        error.exitCode = 1;
        error.stderr = 'sudo: a password is required\n';
        throw error;
      }

      return original(command, args);
    });

    await expect(runDeploy(baseRun({ execImpl }))).rejects.toThrow(/Configuration backup failed/);

    const list = remotes(execImpl);
    expect(list.some((command) => command.includes('base64 -d'))).toBe(false);
  });

  it('restores systemd and nginx state when certbot fails', async () => {
    const execImpl = makeExec({ certExists: false });
    const original = execImpl.getMockImplementation();

    execImpl.mockImplementation(async (command, args) => {
      const remote = args?.[args.length - 1];

      if (command === 'ssh' && remote.includes('certbot certonly')) {
        const error = new Error('acme challenge failed');
        error.exitCode = 1;
        error.stderr = 'acme challenge failed\n';
        throw error;
      }

      return original(command, args);
    });

    await expect(runDeploy(baseRun({ execImpl }))).rejects.toThrow(
      /certbot failed:.*previous systemd and nginx state was restored/,
    );

    const list = remotes(execImpl);
    expect(
      list.some((command) =>
        command.includes("sudo cp -a '/etc/systemd/system/ogis-tiles.service.ogis-backup'"),
      ),
    ).toBe(true);
    expect(
      list.some((command) =>
        command.includes("sudo cp -a '/etc/nginx/sites-available/tile.ogis.app.ogis-backup'"),
      ),
    ).toBe(true);
    expect(list.some((command) => command === 'sudo systemctl enable ogis-tiles.service')).toBe(
      true,
    );
  });

  it('disables a previously disabled service when a later step fails', async () => {
    const execImpl = makeExec({ certExists: false, enabled: false });
    const original = execImpl.getMockImplementation();

    execImpl.mockImplementation(async (command, args) => {
      const remote = args?.[args.length - 1];

      if (command === 'ssh' && remote.includes('certbot certonly')) {
        const error = new Error('acme challenge failed');
        error.exitCode = 1;
        error.stderr = 'acme challenge failed\n';
        throw error;
      }

      return original(command, args);
    });

    await expect(runDeploy(baseRun({ execImpl }))).rejects.toThrow(
      /previous systemd and nginx state was restored/,
    );

    const list = remotes(execImpl);
    expect(list.some((command) => command === 'sudo systemctl disable ogis-tiles.service')).toBe(
      true,
    );
  });

  it('installs an idempotent renewal hook on fresh issuance and certificate reuse', async () => {
    for (const certExists of [false, true]) {
      const execImpl = makeExec({ certExists });

      await runDeploy(baseRun({ execImpl }));

      const list = remotes(execImpl);
      const hooks = list.filter((command) =>
        command.includes('/etc/letsencrypt/renewal-hooks/deploy/ogis-reload-nginx'),
      );

      expect(hooks).toHaveLength(1);
      expect(hooks[0]).toContain(
        "sudo -n install -d -m 0755 '/etc/letsencrypt/renewal-hooks/deploy'",
      );
      expect(hooks[0]).toContain("printf '%s\\n' '#!/bin/sh' 'systemctl reload nginx'");
      expect(hooks[0]).toContain(
        "sudo -n chmod 0755 '/etc/letsencrypt/renewal-hooks/deploy/ogis-reload-nginx'",
      );
    }
  });

  it('does not claim nginx was restored when its restore fails but systemd recovers', async () => {
    const execImpl = makeExec({ certExists: true });
    const original = execImpl.getMockImplementation();

    execImpl.mockImplementation(async (command, args) => {
      const remote = args?.[args.length - 1];

      if (command === 'ssh' && remote === 'sudo nginx -t') {
        throw new Error('nginx: invalid configuration');
      }

      if (
        command === 'ssh' &&
        remote.startsWith("sudo cp -a '/etc/nginx/sites-available/tile.ogis.app.ogis-backup'")
      ) {
        throw new Error('nginx restore failed');
      }

      return original(command, args);
    });

    let caught;

    try {
      await runDeploy(baseRun({ execImpl }));
    } catch (error) {
      caught = error;
    }

    expect(caught?.message).toMatch(
      /Restoring the previous systemd and nginx state also failed:.*nginx restore failed/,
    );
    expect(caught?.message).not.toMatch(/was restored/);

    const list = remotes(execImpl);
    expect(
      list.some((command) =>
        command.includes("sudo cp -a '/etc/systemd/system/ogis-tiles.service.ogis-backup'"),
      ),
    ).toBe(true);
  });

  it('retains configuration backups when a restore fails', async () => {
    const execImpl = makeExec({ certExists: false });
    const out = makeOut();
    const original = execImpl.getMockImplementation();

    execImpl.mockImplementation(async (command, args) => {
      const remote = args?.[args.length - 1];

      if (command === 'ssh' && remote.includes('certbot certonly')) {
        throw new Error('acme challenge failed');
      }

      if (
        command === 'ssh' &&
        remote.startsWith("sudo cp -a '/etc/nginx/sites-available/tile.ogis.app.ogis-backup'")
      ) {
        throw new Error('nginx restore failed');
      }

      return original(command, args);
    });

    await expect(runDeploy(baseRun({ execImpl, out }))).rejects.toThrow(
      /Retained backups for manual recovery:.*tile\.ogis\.app\.ogis-backup/,
    );

    const list = remotes(execImpl);
    expect(list).not.toContain("sudo rm -f '/etc/nginx/sites-available/tile.ogis.app.ogis-backup'");
    expect(out.text()).toContain('retained backup');
    expect(out.text()).toContain('/etc/nginx/sites-available/tile.ogis.app.ogis-backup');
  });

  it('aborts when the nginx symlink check fails rather than assuming it is absent', async () => {
    const execImpl = makeExec({ certExists: true });
    const original = execImpl.getMockImplementation();

    execImpl.mockImplementation(async (command, args) => {
      const remote = args?.[args.length - 1];

      if (command === 'ssh' && remote.startsWith('sudo -n readlink')) {
        const error = new Error('sudo: a password is required');
        error.exitCode = 1;
        error.stderr = 'sudo: a password is required\n';
        throw error;
      }

      return original(command, args);
    });

    await expect(runDeploy(baseRun({ execImpl }))).rejects.toThrow(
      /Nginx symlink check failed.*password is required/,
    );
  });

  it('treats an absent nginx symlink as not enabled', async () => {
    const execImpl = makeExec({ certExists: true });
    const original = execImpl.getMockImplementation();

    execImpl.mockImplementation(async (command, args) => {
      const remote = args?.[args.length - 1];

      if (command === 'ssh' && remote.startsWith('sudo -n readlink')) {
        const error = new Error('readlink: no such file');
        error.exitCode = 1;
        error.stderr = '';
        throw error;
      }

      return original(command, args);
    });

    await expect(runDeploy(baseRun({ execImpl }))).resolves.toMatchObject({ tls: true });
  });

  it('propagates a systemctl disable failure while restoring a previously disabled service', async () => {
    const execImpl = makeExec({ certExists: false, enabled: false });
    const original = execImpl.getMockImplementation();

    execImpl.mockImplementation(async (command, args) => {
      const remote = args?.[args.length - 1];

      if (command === 'ssh' && remote.includes('certbot certonly')) {
        throw new Error('acme challenge failed');
      }

      if (command === 'ssh' && remote === 'sudo systemctl disable ogis-tiles.service') {
        throw new Error('disable restore failed');
      }

      return original(command, args);
    });

    await expect(runDeploy(baseRun({ execImpl }))).rejects.toThrow(
      /also failed:.*disable restore failed/,
    );
  });

  it('propagates a systemctl disable --now failure when the unit was missing', async () => {
    const execImpl = makeExec({ certExists: false, enabled: false });
    const original = execImpl.getMockImplementation();

    execImpl.mockImplementation(async (command, args) => {
      const remote = args?.[args.length - 1];

      if (
        command === 'ssh' &&
        remote.startsWith('err=$(sudo -n test -f') &&
        remote.includes('/etc/systemd/system/ogis-tiles.service')
      ) {
        return { stdout: 'missing\n', stderr: '' };
      }

      if (command === 'ssh' && remote.includes('certbot certonly')) {
        throw new Error('acme challenge failed');
      }

      if (command === 'ssh' && remote === 'sudo systemctl disable --now ogis-tiles.service') {
        throw new Error('disable --now restore failed');
      }

      return original(command, args);
    });

    await expect(runDeploy(baseRun({ execImpl }))).rejects.toThrow(
      /also failed:.*disable --now restore failed/,
    );
  });
});
