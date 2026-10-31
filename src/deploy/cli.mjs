import { DeployError } from './config.mjs';

function splitArgument(argument) {
  const equals = argument.indexOf('=');
  const name = equals === -1 ? argument.slice(2) : argument.slice(2, equals);
  const inlineValue = equals === -1 ? null : argument.slice(equals + 1);

  return { name, inlineValue };
}

function parseOptions(argv, { booleans, values }) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (!argument.startsWith('--')) {
      throw new DeployError(`Unexpected argument "${argument}"`);
    }

    const { name, inlineValue } = splitArgument(argument);

    if (booleans.has(name)) {
      if (inlineValue !== null) {
        throw new DeployError(`--${name} does not take a value`);
      }

      options[booleans.get(name)] = true;
      continue;
    }

    if (!values.has(name)) {
      throw new DeployError(`Unknown option "--${name}"`);
    }

    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new DeployError(`--${name} requires a value`);
    }

    if (inlineValue === null) {
      index += 1;
    }

    options[values.get(name)] = value;
  }

  return options;
}

const DEPLOY_BOOLEANS = new Map([
  ['dry-run', 'dryRun'],
  ['skip-certbot', 'skipCertbot'],
  ['skip-smoke', 'skipSmoke'],
  ['allow-degraded', 'allowDegraded'],
  ['require-ready', 'requireReady'],
  ['help', 'help'],
]);

const DEPLOY_VALUES = new Map([['server', 'server']]);

export function parseDeployOptions(argv) {
  return parseOptions(argv, { booleans: DEPLOY_BOOLEANS, values: DEPLOY_VALUES });
}

const SOURCE_BOOLEANS = new Map([
  ['dry-run', 'dryRun'],
  ['server-side', 'serverSide'],
  ['skip-smoke', 'skipSmoke'],
  ['help', 'help'],
]);

const SOURCE_VALUES = new Map([
  ['source', 'source'],
  ['server', 'server'],
  ['data-dir', 'dataDir'],
  ['incoming-dir', 'incomingDir'],
  ['app-dir', 'appDir'],
]);

export function parseSourceOptions(argv) {
  return parseOptions(argv, { booleans: SOURCE_BOOLEANS, values: SOURCE_VALUES });
}

const STATUS_BOOLEANS = new Map([
  ['cloud-only', 'cloudOnly'],
  ['server-only', 'serverOnly'],
  ['server-side', 'serverSide'],
  ['json', 'json'],
  ['help', 'help'],
]);

const STATUS_VALUES = new Map([
  ['server', 'server'],
  ['host', 'host'],
]);

export function parseStatusOptions(argv) {
  const options = parseOptions(argv, { booleans: STATUS_BOOLEANS, values: STATUS_VALUES });

  if (options.cloudOnly && options.serverOnly) {
    throw new DeployError('--cloud-only and --server-only cannot be used together');
  }

  return options;
}
