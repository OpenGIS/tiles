import path from 'node:path';

import { runCommand } from '../build/exec.mjs';
import { childEnvironment } from '../provision/provision.mjs';

import { DeployError } from './config.mjs';
import {
  nginxCacheDirectories,
  nginxCacheOwner,
  renderNginxConfig,
  renderSystemdUnit,
} from './render.mjs';
import { describeRsync, detectRsync, rsyncArguments } from './rsync.mjs';
import {
  base64WriteCommand,
  quoteIfNeeded,
  remoteFileExists,
  runRemote,
  shellQuote,
} from './ssh.mjs';

function npmBin(nodeBin) {
  return path.posix.join(path.posix.dirname(nodeBin), 'npm');
}

function npmPath(nodeBin) {
  return [...new Set([path.posix.dirname(nodeBin), '/usr/local/bin', '/usr/bin', '/bin'])].join(
    ':',
  );
}

function log(out, line = '') {
  out.write(`${line}\n`);
}

function planLines({ config, options, rsyncInfo, cacheDirectories, cacheOwner }) {
  const tls = options.skipCertbot
    ? 'use an existing certificate, or stay on HTTP'
    : 'obtain or reuse TLS';

  return [
    'ogis deploy — dry run',
    '',
    `Host: ${config.host}`,
    `SSH target: ${config.deployUser}@${config.targetHost}`,
    `App: ${config.appDir} (data: ${config.dataDir})`,
    `Service: ${config.serviceName} on 127.0.0.1:${config.port}`,
    `Nginx: ${config.nginxSiteFile}`,
    `Nginx cache: ${cacheDirectories.join(', ')}`,
    `Nginx cache owner: ${cacheOwner}:${cacheOwner}`,
    `Certificate: ${tls}`,
    `Rsync: ${describeRsync(rsyncInfo)}`,
    '',
    'Plan:',
    '  1. Preflight over SSH: reachability, deploy user, Node.js, app and data directories',
    '  2. Rsync source, bin, config and package files; preserve data/ and server-only state',
    `  3. Install dependencies with npm ci --omit=dev as ${config.deployUser}`,
    '  4. Render and install the systemd unit, systemctl daemon-reload, enable --now and restart',
    '  5. Create the nginx cache directories, render and install the nginx configuration, ' +
      'nginx -t before reload',
    options.skipCertbot
      ? '  6. Skip certbot; reuse an existing certificate when present'
      : '  6. Check the certificate; obtain one with certbot when missing',
    '  7. Install the TLS configuration and reload nginx',
    options.skipSmoke
      ? '  8. Skip smoke checks'
      : '  8. Smoke /health, /sources, /ready and the service state',
    '',
    'No changes were made. Run without --dry-run to deploy.',
  ];
}

function npmCiCommand(config) {
  return (
    `cd ${shellQuote(config.appDir)} && sudo -u ${config.deployUser} ` +
    `env HOME=${shellQuote(config.appDir)} PATH=${quoteIfNeeded(npmPath(config.nodeBin))} ` +
    `${quoteIfNeeded(npmBin(config.nodeBin))} ci --omit=dev`
  );
}

const CERTBOT_RENEWAL_HOOK_PATH = '/etc/letsencrypt/renewal-hooks/deploy/ogis-reload-nginx';

function nginxCacheDirectoryCommand(directories, owner = nginxCacheOwner()) {
  return (
    `sudo -n install -d -o ${quoteIfNeeded(owner)} -g ${quoteIfNeeded(owner)} -m 0755 ` +
    directories.map((directory) => shellQuote(directory)).join(' ')
  );
}

function certbotIssueCommand(config) {
  return (
    `sudo certbot certonly --webroot -w ${shellQuote(config.certbotWebroot)} ` +
    `-d ${config.host} --email ${shellQuote(config.certbotEmail)} --agree-tos ` +
    `--non-interactive --deploy-hook ${shellQuote('systemctl reload nginx')}`
  );
}

function certbotRenewalHookCommand(config) {
  return (
    `sudo certbot certonly --cert-name ${shellQuote(config.host)} ` +
    `--webroot -w ${shellQuote(config.certbotWebroot)} -d ${config.host} ` +
    '--non-interactive --keep-until-expiring ' +
    `--deploy-hook ${shellQuote('systemctl reload nginx')}`
  );
}

function certbotRenewalHookInstallCommand() {
  const directory = path.posix.dirname(CERTBOT_RENEWAL_HOOK_PATH);

  return (
    `sudo -n install -d -m 0755 ${shellQuote(directory)} && ` +
    `printf '%s\\n' ${shellQuote('#!/bin/sh')} ${shellQuote('systemctl reload nginx')} | ` +
    `sudo -n tee ${shellQuote(CERTBOT_RENEWAL_HOOK_PATH)} >/dev/null && ` +
    `sudo -n chmod 0755 ${shellQuote(CERTBOT_RENEWAL_HOOK_PATH)}`
  );
}

function retainedBackupPaths(snapshots) {
  return snapshots
    .filter((snapshot) => snapshot?.file?.existed)
    .map((snapshot) => snapshot.file.backupPath);
}

function retentionNotice(paths) {
  return paths.length ? ` Retained backups for manual recovery: ${paths.join(', ')}.` : '';
}

function certbotFailure(label, error, restoreError, retainedPaths = []) {
  if (restoreError) {
    return new DeployError(
      `${label} failed: ${error.message}. Restoring the previous systemd and nginx state ` +
        `also failed: ${restoreError.message}; the server may be inconsistent.` +
        retentionNotice(retainedPaths),
      { cause: error },
    );
  }

  return new DeployError(
    `${label} failed: ${error.message}. The previous systemd and nginx state was restored.` +
      retentionNotice(retainedPaths),
    { cause: error },
  );
}

const CONFIG_BACKUP_SUFFIX = '.ogis-backup';

async function remoteStep(config, command, label, { execImpl, env, timeoutMs }) {
  return runRemote(config, command, { execImpl, env, timeoutMs, label });
}

async function backupRemoteFile(config, targetPath, { execImpl, env }) {
  const backupPath = `${targetPath}${CONFIG_BACKUP_SUFFIX}`;
  const command =
    `err=$(sudo -n test -f ${shellQuote(targetPath)} 2>&1); status=$?; ` +
    `if [ "$status" -eq 0 ]; then ` +
    `sudo -n cp -a ${shellQuote(targetPath)} ${shellQuote(backupPath)} && echo present; ` +
    `elif [ "$status" -eq 1 ] && [ -z "$err" ]; then ` +
    `sudo -n rm -f ${shellQuote(backupPath)}; echo missing; ` +
    `else printf '%s\\n' "$err" >&2; exit "$status"; fi`;

  const { stdout } = await remoteStep(config, command, 'Configuration backup', { execImpl, env });

  return { backupPath, existed: String(stdout).trim() === 'present' };
}

async function restoreRemoteFile(config, targetPath, backup, { execImpl, env, label }) {
  const command = backup.existed
    ? `sudo cp -a ${shellQuote(backup.backupPath)} ${shellQuote(targetPath)} && ` +
      `sudo rm -f ${shellQuote(backup.backupPath)}`
    : `sudo rm -f ${shellQuote(targetPath)} && sudo rm -f ${shellQuote(backup.backupPath)}`;

  await remoteStep(config, command, `${label} restore`, { execImpl, env });
}

async function removeRemoteBackup(config, backup, { execImpl, env, label }) {
  await remoteStep(config, `sudo rm -f ${shellQuote(backup.backupPath)}`, `${label} cleanup`, {
    execImpl,
    env,
  }).catch(() => {});
}

async function captureSystemdState(config, { execImpl, env }) {
  const file = await backupRemoteFile(config, config.serviceFile, { execImpl, env });
  const { stdout } = await remoteStep(
    config,
    `systemctl is-enabled ${config.serviceName} 2>/dev/null || true`,
    'Service enablement check',
    { execImpl, env },
  );

  return { file, enabled: String(stdout).trim() === 'enabled', restored: false };
}

function missingSymlink(error) {
  const cause = error?.cause ?? error;
  const exitCode = cause?.exitCode ?? cause?.code;
  const stderr = String(cause?.stderr ?? '').trim();

  return exitCode === 1 && stderr === '';
}

async function captureNginxState(config, { execImpl, env }) {
  const file = await backupRemoteFile(config, config.nginxSiteFile, { execImpl, env });
  let stdout;

  try {
    ({ stdout } = await remoteStep(
      config,
      `sudo -n readlink ${shellQuote(config.nginxEnabledFile)}`,
      'Nginx symlink check',
      { execImpl, env },
    ));
  } catch (error) {
    if (missingSymlink(error)) {
      return { file, enabledTarget: null, restored: false };
    }

    throw error;
  }

  return { file, enabledTarget: String(stdout).trim() || null, restored: false };
}

async function restoreSystemdState(config, state, { execImpl, env, label }) {
  try {
    await restoreRemoteFile(config, config.serviceFile, state.file, { execImpl, env, label });

    if (!state.file.existed && !state.enabled) {
      await remoteStep(
        config,
        `sudo systemctl disable --now ${config.serviceName}`,
        `${label} disable restore`,
        { execImpl, env },
      );
      state.restoreFailed = false;
      state.restored = true;
      return;
    }

    if (state.enabled) {
      await remoteStep(
        config,
        `sudo systemctl enable ${config.serviceName}`,
        `${label} enable restore`,
        { execImpl, env },
      );
    } else {
      await remoteStep(
        config,
        `sudo systemctl disable ${config.serviceName}`,
        `${label} disable restore`,
        { execImpl, env },
      );
    }

    await remoteStep(config, 'sudo systemctl daemon-reload', `${label} daemon-reload restore`, {
      execImpl,
      env,
    });
    await remoteStep(
      config,
      `sudo systemctl restart ${config.serviceName}`,
      `${label} restart restore`,
      { execImpl, env },
    );
    state.restoreFailed = false;
    state.restored = true;
  } catch (error) {
    state.restoreFailed = true;
    throw error;
  }
}

async function restoreNginxState(config, state, { execImpl, env, label }) {
  try {
    await restoreRemoteFile(config, config.nginxSiteFile, state.file, { execImpl, env, label });

    if (state.enabledTarget) {
      await remoteStep(
        config,
        `sudo ln -sfn ${shellQuote(state.enabledTarget)} ${shellQuote(config.nginxEnabledFile)}`,
        `${label} enable restore`,
        { execImpl, env },
      );
    } else {
      await remoteStep(
        config,
        `sudo rm -f ${shellQuote(config.nginxEnabledFile)}`,
        `${label} disable restore`,
        { execImpl, env },
      );
    }

    await remoteStep(config, 'sudo nginx -t', `${label} nginx -t`, { execImpl, env });
    await remoteStep(config, 'sudo systemctl reload nginx', `${label} nginx reload`, {
      execImpl,
      env,
    });
    state.restoreFailed = false;
    state.restored = true;
  } catch (error) {
    state.restoreFailed = true;
    throw error;
  }
}

async function restoreSnapshots({ config, serviceSnapshot, nginxSnapshot, execImpl, env }) {
  let restoreError = null;

  if (nginxSnapshot && !nginxSnapshot.restored) {
    try {
      await restoreNginxState(config, nginxSnapshot, { execImpl, env, label: 'Nginx site' });
    } catch (error) {
      restoreError ??= error;
    }
  }

  if (serviceSnapshot && !serviceSnapshot.restored) {
    try {
      await restoreSystemdState(config, serviceSnapshot, {
        execImpl,
        env,
        label: 'Systemd unit',
      });
    } catch (error) {
      restoreError ??= error;
    }
  }

  return restoreError;
}

async function installSystemdUnit({ config, unit, execImpl, env, state }) {
  const snapshot = state ?? (await captureSystemdState(config, { execImpl, env }));

  try {
    await remoteStep(config, base64WriteCommand(config.serviceFile, unit), 'Systemd unit install', {
      execImpl,
      env,
    });
    await remoteStep(config, 'sudo systemctl daemon-reload', 'systemctl daemon-reload', {
      execImpl,
      env,
    });
    await remoteStep(
      config,
      `sudo systemctl enable --now ${config.serviceName}`,
      'systemctl enable --now',
      { execImpl, env },
    );
    await remoteStep(config, `sudo systemctl restart ${config.serviceName}`, 'systemctl restart', {
      execImpl,
      env,
    });
    await assertServiceActive(config, { execImpl, env });
  } catch (error) {
    try {
      await restoreSystemdState(config, snapshot, {
        execImpl,
        env,
        label: 'Systemd unit',
      });
    } catch (restoreError) {
      throw new DeployError(
        `Systemd unit install failed: ${error.message}. ` +
          `Restoring the previous unit also failed: ${restoreError.message}; ` +
          'the server may be inconsistent.' +
          retentionNotice(retainedBackupPaths([snapshot])),
        { cause: error },
      );
    }

    throw new DeployError(
      `Systemd unit install failed: ${error.message}. The previous unit was restored.`,
      { cause: error },
    );
  }

  if (!state) {
    await removeRemoteBackup(config, snapshot.file, { execImpl, env, label: 'Systemd unit' });
  }

  return snapshot;
}

async function installNginxSite({ config, content, label, execImpl, env, state }) {
  const snapshot = state ?? (await captureNginxState(config, { execImpl, env }));

  try {
    await remoteStep(
      config,
      base64WriteCommand(config.nginxSiteFile, content),
      `${label} install`,
      {
        execImpl,
        env,
      },
    );
    await remoteStep(
      config,
      `sudo ln -sfn ${shellQuote(config.nginxSiteFile)} ${shellQuote(config.nginxEnabledFile)}`,
      `${label} enable`,
      { execImpl, env },
    );
    await remoteStep(config, 'sudo nginx -t', `${label} nginx -t`, { execImpl, env });
    await remoteStep(config, 'sudo systemctl reload nginx', `${label} nginx reload`, {
      execImpl,
      env,
    });
  } catch (error) {
    try {
      await restoreNginxState(config, snapshot, {
        execImpl,
        env,
        label: 'Nginx site',
      });
    } catch (restoreError) {
      throw new DeployError(
        `${label} failed: ${error.message}. ` +
          `Restoring the previous nginx configuration also failed: ${restoreError.message}; ` +
          'the server may be inconsistent.',
        { cause: error },
      );
    }

    throw new DeployError(
      `${label} failed: ${error.message}. The previous nginx configuration was restored.`,
      { cause: error },
    );
  }

  if (!state) {
    await removeRemoteBackup(config, snapshot.file, { execImpl, env, label });
  }

  return snapshot;
}

async function assertServiceActive(config, { execImpl, env }) {
  const { stdout } = await remoteStep(
    config,
    `systemctl is-active ${config.serviceName}`,
    'Service state check',
    { execImpl, env },
  );

  if (String(stdout).trim() !== 'active') {
    throw new DeployError(
      `Service ${config.serviceName} is not active (systemctl reported "${String(stdout).trim()}")`,
    );
  }
}

async function fetchStatus(fetchImpl, url, timeoutMs) {
  try {
    return await fetchImpl(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    throw new DeployError(`Smoke request to ${url} failed: ${error.message}`, { cause: error });
  }
}

async function runSmoke({ config, protocol, options, fetchImpl, execImpl, env, out, timeoutMs }) {
  log(out, `Smoke: ${protocol}://${config.host}/health`);

  const health = await fetchStatus(fetchImpl, `${protocol}://${config.host}/health`, timeoutMs);
  if (health.status !== 200) {
    throw new DeployError(`Smoke /health returned HTTP ${health.status}; expected 200`);
  }

  const sources = await fetchStatus(fetchImpl, `${protocol}://${config.host}/sources`, timeoutMs);
  if (sources.status !== 200 && !options.allowDegraded) {
    throw new DeployError(
      `Smoke /sources returned HTTP ${sources.status}; use --allow-degraded to accept this`,
    );
  }

  const ready = await fetchStatus(fetchImpl, `${protocol}://${config.host}/ready`, timeoutMs);
  if (options.requireReady && ready.status !== 200) {
    throw new DeployError(`Smoke /ready returned HTTP ${ready.status}; --require-ready needs 200`);
  }

  if (
    !options.requireReady &&
    !options.allowDegraded &&
    ready.status !== 200 &&
    ready.status !== 503
  ) {
    throw new DeployError(`Smoke /ready returned HTTP ${ready.status}; expected 200 or 503`);
  }

  await assertServiceActive(config, { execImpl, env });

  return { health: health.status, sources: sources.status, ready: ready.status };
}

export async function runDeploy({
  config,
  layersConfig,
  repoRoot,
  options = {},
  execImpl = runCommand,
  fetchImpl = globalThis.fetch,
  env = process.env,
  out = process.stdout,
  timeoutMs = 5_000,
  rsyncInfo = null,
} = {}) {
  if (!config) {
    throw new DeployError('Deployment configuration is required');
  }

  if (!layersConfig?.sources) {
    throw new DeployError('A validated layers configuration is required');
  }

  if (!repoRoot) {
    throw new DeployError('The repository root is required to deploy');
  }

  const resolvedRsync = rsyncInfo ?? (await detectRsync({ execImpl, env }));

  const renderUnit = (tls) =>
    renderSystemdUnit({
      deployUser: config.deployUser,
      appDir: config.appDir,
      dataDir: config.dataDir,
      nodeBin: config.nodeBin,
      port: config.port,
      configPath: config.configPath,
      serviceName: config.serviceName,
      publicBaseUrl:
        layersConfig.server?.publicBaseUrl ?? `${tls ? 'https' : 'http'}://${config.host}`,
    });

  let unit = renderUnit(!options.skipCertbot);

  const httpConfig = renderNginxConfig({
    host: config.host,
    port: config.port,
    sources: layersConfig.sources,
    tls: false,
    certbotWebroot: config.certbotWebroot,
  });

  const tlsConfig = renderNginxConfig({
    host: config.host,
    port: config.port,
    sources: layersConfig.sources,
    tls: true,
    certbotWebroot: config.certbotWebroot,
  });

  const cacheDirectories = nginxCacheDirectories(layersConfig.sources);
  const cacheOwner = nginxCacheOwner();

  if (options.dryRun) {
    for (const line of planLines({
      config,
      options,
      rsyncInfo: resolvedRsync,
      cacheDirectories,
      cacheOwner,
    })) {
      log(out, line);
    }

    return {
      dryRun: true,
      unitBytes: Buffer.byteLength(unit),
      httpConfig,
      tlsConfig,
      rsync: resolvedRsync,
    };
  }

  if (!config.deployPrivateKeyPath) {
    throw new DeployError('SSH_PRIVATE_KEY_PATH is required to deploy');
  }

  const commandEnv = childEnvironment(env);
  log(out, `Deploying to ${config.deployUser}@${config.targetHost}:${config.appDir}`);

  await remoteStep(config, 'true', 'Server reachability check', { execImpl, env });
  await remoteStep(config, `id -u ${shellQuote(config.deployUser)}`, 'Deploy user check', {
    execImpl,
    env,
  });
  await remoteStep(
    config,
    `${quoteIfNeeded(config.nodeBin)} --version`,
    'Node.js availability check',
    {
      execImpl,
      env,
    },
  );
  await remoteStep(
    config,
    `test -d ${shellQuote(config.appDir)} && test -d ${shellQuote(config.dataDir)}`,
    'App and data directory check',
    { execImpl, env },
  );

  const certificateFile = `/etc/letsencrypt/live/${config.host}/fullchain.pem`;
  const certExists = await remoteFileExists(config, certificateFile, {
    execImpl,
    env,
    timeoutMs,
  });

  if (!certExists && !options.skipCertbot && config.certbotEmail === '') {
    throw new DeployError(
      'CERTBOT_EMAIL is required to obtain a certificate; set it or use --skip-certbot',
    );
  }

  const tlsWillBeActive = certExists || !options.skipCertbot;
  unit = renderUnit(tlsWillBeActive);

  log(out, 'Rsync project files');
  await execImpl(
    resolvedRsync.command,
    rsyncArguments({ repoRoot, config, rsync: resolvedRsync }),
    {
      encoding: 'utf8',
      env: commandEnv,
    },
  );

  log(out, 'Install production dependencies');
  await remoteStep(config, npmCiCommand(config), 'npm ci', { execImpl, env });

  const serviceSnapshot = await captureSystemdState(config, { execImpl, env });
  let nginxSnapshot = null;
  let tlsActive = certExists;

  try {
    log(out, 'Install systemd unit');
    await installSystemdUnit({ config, unit, execImpl, env, state: serviceSnapshot });

    log(out, 'Create nginx cache directories');
    await remoteStep(
      config,
      nginxCacheDirectoryCommand(cacheDirectories, cacheOwner),
      'Nginx cache directories',
      { execImpl, env },
    );

    if (!certExists) {
      log(out, 'Install HTTP-only nginx configuration for ACME');
      nginxSnapshot = await captureNginxState(config, { execImpl, env });
      await installNginxSite({
        config,
        content: httpConfig,
        label: 'HTTP-only nginx configuration',
        execImpl,
        env,
        state: nginxSnapshot,
      });

      if (!options.skipCertbot) {
        log(out, `Request a certificate for ${config.host}`);

        try {
          await remoteStep(
            config,
            certbotRenewalHookInstallCommand(),
            'certbot renewal hook install',
            { execImpl, env, timeoutMs: 300_000 },
          );
          await remoteStep(config, certbotIssueCommand(config), 'certbot', {
            execImpl,
            env,
            timeoutMs: 300_000,
          });
        } catch (error) {
          const restoreError = await restoreSnapshots({
            config,
            serviceSnapshot,
            nginxSnapshot,
            execImpl,
            env,
          });

          throw certbotFailure(
            'certbot',
            error,
            restoreError,
            restoreError ? retainedBackupPaths([serviceSnapshot, nginxSnapshot]) : [],
          );
        }

        tlsActive = true;
      }
    } else if (!options.skipCertbot) {
      log(out, 'Ensure the certificate renewal deploy hook');

      try {
        await remoteStep(
          config,
          certbotRenewalHookInstallCommand(),
          'certbot renewal hook install',
          { execImpl, env, timeoutMs: 300_000 },
        );
        await remoteStep(config, certbotRenewalHookCommand(config), 'certbot renewal hook', {
          execImpl,
          env,
          timeoutMs: 300_000,
        });
      } catch (error) {
        const restoreError = await restoreSnapshots({
          config,
          serviceSnapshot,
          nginxSnapshot,
          execImpl,
          env,
        });

        throw certbotFailure(
          'The certificate renewal hook run',
          error,
          restoreError,
          restoreError ? retainedBackupPaths([serviceSnapshot, nginxSnapshot]) : [],
        );
      }
    }

    if (tlsActive) {
      log(out, 'Install TLS nginx configuration');
      nginxSnapshot ??= await captureNginxState(config, { execImpl, env });

      try {
        await installNginxSite({
          config,
          content: tlsConfig,
          label: 'TLS nginx configuration',
          execImpl,
          env,
          state: nginxSnapshot,
        });
      } catch (error) {
        const restoreError = await restoreSnapshots({
          config,
          serviceSnapshot,
          nginxSnapshot,
          execImpl,
          env,
        });

        if (restoreError) {
          throw new DeployError(
            `${error.message} Restoring the previous systemd and nginx state also failed: ` +
              `${restoreError.message}; the server may be inconsistent.` +
              retentionNotice(retainedBackupPaths([serviceSnapshot, nginxSnapshot])),
            { cause: error },
          );
        }

        throw new DeployError(
          `${error.message} The previous systemd and nginx state was also restored.`,
          { cause: error },
        );
      }
    } else {
      log(out, 'Certificate skipped; the server remains on HTTP');
    }
  } finally {
    const snapshots = [serviceSnapshot, nginxSnapshot].filter(Boolean);
    const restoreFailed = snapshots.some((snapshot) => snapshot.restoreFailed);

    if (restoreFailed) {
      const retained = retainedBackupPaths(snapshots);

      if (retained.length > 0) {
        log(
          out,
          `Restore failed; retained backup${retained.length === 1 ? '' : 's'} at ` +
            `${retained.join(', ')} for manual recovery.`,
        );
      }
    } else {
      await removeRemoteBackup(config, serviceSnapshot.file, {
        execImpl,
        env,
        label: 'Systemd unit',
      });

      if (nginxSnapshot) {
        await removeRemoteBackup(config, nginxSnapshot.file, {
          execImpl,
          env,
          label: 'Nginx site',
        });
      }
    }
  }

  let smoke = null;

  if (options.skipSmoke) {
    log(out, 'Skipping smoke checks');
  } else {
    smoke = await runSmoke({
      config,
      protocol: tlsActive ? 'https' : 'http',
      options,
      fetchImpl,
      execImpl,
      env,
      out,
      timeoutMs,
    });
  }

  log(out, `Deployed ${config.host} (${tlsActive ? 'https' : 'http'})`);

  return { dryRun: false, certExists, tls: tlsActive, smoke };
}
