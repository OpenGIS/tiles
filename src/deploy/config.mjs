import os from 'node:os';
import path from 'node:path';

import { expandHome } from '../provision/provision.mjs';

const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;
const SERVER_TARGET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$/;
const USERNAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const SERVICE_NAME_PATTERN = /^[A-Za-z0-9_.@-]+\.service$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ABSOLUTE_PATH_PATTERN = /^\/[^\0\r\n]*$/;

export class DeployError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'DeployError';
  }
}

function requireValue(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DeployError(`${name} is required`);
  }

  return value.trim();
}

function optionalValue(env, name, fallback) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    return fallback;
  }

  return value.trim();
}

export function validHostname(value) {
  return HOSTNAME_PATTERN.test(String(value ?? '').trim());
}

export function validIPv4(value) {
  const parts = String(value ?? '')
    .trim()
    .split('.');
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  );
}

function requireAbsolutePath(value, label) {
  if (!ABSOLUTE_PATH_PATTERN.test(value)) {
    throw new DeployError(`${label} "${value}" must be an absolute path`);
  }

  const normalised = path.normalize(value);
  if (
    normalised === '/' ||
    value.split(/[\\/]+/).includes('..') ||
    normalised.split(path.sep).includes('..')
  ) {
    throw new DeployError(`${label} "${value}" is not a safe absolute path`);
  }

  return normalised;
}

export function resolveDeployConfig({ env, homedir = os.homedir(), requireHost = true } = {}) {
  if (env === undefined || env === null) {
    throw new DeployError('Deployment environment is required');
  }

  const host = requireHost
    ? requireValue(env, 'TILE_SERVER_HOST')
    : optionalValue(env, 'TILE_SERVER_HOST', 'tile.ogis.app');

  if (!validHostname(host)) {
    throw new DeployError(`TILE_SERVER_HOST "${host}" is not a valid hostname`);
  }

  const serverIp = optionalValue(env, 'TILE_SERVER_IP', '');
  if (serverIp !== '' && !validIPv4(serverIp)) {
    throw new DeployError(`TILE_SERVER_IP "${serverIp}" is not a valid IPv4 address`);
  }

  const deployUser = optionalValue(env, 'DEPLOY_USER', 'deploy');
  if (!USERNAME_PATTERN.test(deployUser)) {
    throw new DeployError(`DEPLOY_USER "${deployUser}" is not a valid Linux user name`);
  }

  if (deployUser === 'root') {
    throw new DeployError('DEPLOY_USER must not be root');
  }

  const certbotEmail = optionalValue(env, 'CERTBOT_EMAIL', '');
  if (certbotEmail !== '' && !EMAIL_PATTERN.test(certbotEmail)) {
    throw new DeployError(`CERTBOT_EMAIL "${certbotEmail}" is not a valid email address`);
  }

  const rawKeyPath = optionalValue(env, 'SSH_PRIVATE_KEY_PATH', '');
  const deployPrivateKeyPath = rawKeyPath === '' ? '' : expandHome(rawKeyPath, homedir);

  const port = Number(optionalValue(env, 'PORT', '11010'));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new DeployError(`PORT "${env.PORT}" must be an unprivileged port between 1024 and 65535`);
  }

  const appDir = requireAbsolutePath(
    optionalValue(env, 'TILE_APP_DIR', '/opt/ogis-tiles'),
    'TILE_APP_DIR',
  );
  const dataDir = requireAbsolutePath(
    optionalValue(env, 'TILE_DATA_DIR', path.join(appDir, 'data')),
    'TILE_DATA_DIR',
  );
  const incomingDir = requireAbsolutePath(
    optionalValue(env, 'TILE_INCOMING_DIR', path.join(dataDir, 'incoming')),
    'TILE_INCOMING_DIR',
  );

  const serviceName = optionalValue(env, 'SERVICE_NAME', 'ogis-tiles.service');
  if (!SERVICE_NAME_PATTERN.test(serviceName)) {
    throw new DeployError(`SERVICE_NAME "${serviceName}" is not a valid systemd service name`);
  }

  const nodeBin = requireAbsolutePath(
    optionalValue(env, 'NODE_BIN', '/usr/local/bin/node'),
    'NODE_BIN',
  );
  const configPath = optionalValue(env, 'CONFIG_PATH', 'config/layers.json');
  if (/[\0\r\n]/.test(configPath)) {
    throw new DeployError('CONFIG_PATH must not contain control characters');
  }

  if (path.isAbsolute(configPath)) {
    requireAbsolutePath(configPath, 'CONFIG_PATH');
  } else if (configPath.split(/[\\/]+/).includes('..')) {
    throw new DeployError(`CONFIG_PATH "${configPath}" must not contain ".."`);
  }

  return {
    host,
    serverIp,
    deployUser,
    certbotEmail,
    port,
    appDir,
    dataDir,
    incomingDir,
    configPath,
    serviceName,
    nodeBin,
    certbotWebroot: '/var/www/certbot',
    serviceFile: `/etc/systemd/system/${serviceName}`,
    nginxSiteFile: `/etc/nginx/sites-available/${host}`,
    nginxEnabledFile: `/etc/nginx/sites-enabled/${host}`,
    deployPrivateKeyPath,
    targetHost: host,
  };
}

export function withServerOverride(config, server) {
  const value = String(server ?? '').trim();
  if (value === '') {
    return config;
  }

  if (!validHostname(value) && !validIPv4(value) && !SERVER_TARGET_PATTERN.test(value)) {
    throw new DeployError(`--server "${server}" is not a valid hostname or IPv4 address`);
  }

  return { ...config, targetHost: value };
}
