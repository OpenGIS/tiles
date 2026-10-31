import { quoteIfNeeded, shellQuote } from './ssh.mjs';

export function remoteEnvironment(config, options = {}) {
  const appDir = options.appDir ?? config.appDir;
  const dataDir = options.dataDir ?? config.dataDir;
  const incomingDir = options.incomingDir ?? config.incomingDir;

  return [
    ['PORT', String(config.port)],
    ['SERVICE_NAME', config.serviceName],
    ['NODE_BIN', config.nodeBin],
    ['CONFIG_PATH', config.configPath],
    ['TILE_APP_DIR', appDir],
    ['TILE_DATA_DIR', dataDir],
    ['TILE_INCOMING_DIR', incomingDir],
  ].map(([name, value]) => `${name}=${shellQuote(value)}`);
}

export function sourceRemoteCommand(config, kind, options = {}) {
  const appDir = options.appDir ?? config.appDir;
  const dataDir = options.dataDir ?? config.dataDir;
  const incomingDir = options.incomingDir ?? config.incomingDir;

  const environment = remoteEnvironment(config, options);

  const flags = [
    `--app-dir ${shellQuote(appDir)}`,
    `--data-dir ${shellQuote(dataDir)}`,
    `--incoming-dir ${shellQuote(incomingDir)}`,
  ];

  if (options.skipSmoke) {
    flags.push('--skip-smoke');
  }

  return [
    `cd ${shellQuote(appDir)} &&`,
    `env ${environment.join(' ')} ${quoteIfNeeded(config.nodeBin)} bin/ogis.mjs ${kind} ` +
      `--server-side --source ${shellQuote(options.source)} ${flags.join(' ')}`,
  ].join(' ');
}
