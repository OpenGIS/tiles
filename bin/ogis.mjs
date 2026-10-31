#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BuildError } from '../src/build/errors.mjs';
import { runBuild } from '../src/build/pipeline.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const VALUE_FLAGS = new Map([
  ['only', 'only'],
  ['fixture', 'fixture'],
  ['planet-pbf', 'planetPbf'],
  ['planet-url', 'planetUrl'],
  ['planet-date', 'planetDate'],
  ['planet-sha256', 'planetSha256'],
  ['archive', 'archive'],
  ['output-dir', 'outputDir'],
]);

const BOOLEAN_FLAGS = new Map([
  ['skip-download', 'skipDownload'],
  ['skip-filter', 'skipFilter'],
  ['skip-build', 'skipBuild'],
  ['skip-verify', 'skipVerify'],
  ['install', 'install'],
  ['keep-work', 'keepWork'],
  ['allow-unverified-install', 'allowUnverifiedInstall'],
  ['force', 'force'],
  ['help', 'help'],
]);

const USAGE = `Usage: ogis build [options]

Build the configured tile sources.

Options:
  --only=<source>          Build only the named source (comma-separated)
  --fixture=<pbf>          Build from a local fixture PBF instead of the planet
  --planet-pbf=<pbf>       Build from a local planet PBF
  --planet-url=<url>       Override the planet URL
  --planet-date=<date>     Override the planet date (YYYY-MM-DD)
  --planet-sha256=<hash>   Override the planet SHA-256
  --skip-download          Do not download the planet PBF
  --skip-filter            Build directly from the input PBF
  --skip-build             Verify an existing archive without building
  --archive=<path>         Archive to use with --skip-build
  --skip-verify            Skip PMTiles verification and sample tiles
  --output-dir=<dir>       Override the build output directory
  --install                Install the archive into the source data directory
  --allow-unverified-install  Install even when verification was skipped
  --keep-work              Keep the temporary work directory
  --force                  Download tools and inputs again
  --help                   Show this help`;

function parseBuildOptions(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (!argument.startsWith('--')) {
      throw new BuildError(`Unexpected argument "${argument}"`);
    }

    const equals = argument.indexOf('=');
    const name = equals === -1 ? argument.slice(2) : argument.slice(2, equals);
    const inlineValue = equals === -1 ? null : argument.slice(equals + 1);

    if (BOOLEAN_FLAGS.has(name)) {
      if (inlineValue !== null) {
        throw new BuildError(`--${name} does not take a value`);
      }

      options[BOOLEAN_FLAGS.get(name)] = true;
      continue;
    }

    if (!VALUE_FLAGS.has(name)) {
      throw new BuildError(`Unknown option "--${name}"`);
    }

    const value = inlineValue ?? argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new BuildError(`--${name} requires a value`);
    }

    if (inlineValue === null) {
      index += 1;
    }

    options[VALUE_FLAGS.get(name)] = value;
  }

  return options;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  if (command !== 'build') {
    throw new BuildError(`Unknown command "${command}"; expected "build"`);
  }

  const options = parseBuildOptions(rest);

  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const results = await runBuild({
    repoRoot,
    configPath: process.env.CONFIG_PATH || path.join(repoRoot, 'config', 'layers.json'),
    ...options,
  });

  for (const result of results) {
    process.stdout.write(`Archive: ${result.archivePath}\n`);
    process.stdout.write(`Manifest: ${result.manifestPath}\n`);
    process.stdout.write(`SHA-256: ${result.archiveSha256}\n`);

    if (result.installed) {
      process.stdout.write(`Installed: ${result.installed.currentArchive}\n`);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
