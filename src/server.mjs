import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from './app.mjs';
import { loadConfig, normalisePublicBaseUrl } from './lib/config.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const defaultConfigPath = fileURLToPath(new URL('../config/layers.json', import.meta.url));
const configPath = process.env.CONFIG_PATH
  ? path.resolve(process.env.CONFIG_PATH)
  : defaultConfigPath;

function fail(message) {
  console.error(message);
  process.exit(1);
}

let config;
try {
  config = loadConfig(configPath, { repoRoot });

  if (process.env.PUBLIC_BASE_URL) {
    config.server.publicBaseUrl = normalisePublicBaseUrl(
      process.env.PUBLIC_BASE_URL,
      'PUBLIC_BASE_URL',
    );
  }
} catch (error) {
  fail(`Unable to load configuration: ${error.message}`);
}

const host = process.env.HOST ?? config.server.host;
const port = Number(process.env.PORT ?? config.server.port);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  fail(`Invalid port "${process.env.PORT ?? config.server.port}"`);
}

let app;
try {
  app = await createApp(config);
} catch (error) {
  fail(`Unable to start ogis-tiles: ${error.message}`);
}

try {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      app.server.off('listening', onListening);
      reject(error);
    };

    const onListening = () => {
      app.server.off('error', onError);
      resolve();
    };

    app.server.once('error', onError);
    app.server.once('listening', onListening);
    app.server.listen(port, host);
  });
} catch (error) {
  console.error(`Unable to start ogis-tiles: ${error.message}`);
  await app.close().catch(() => {});
  process.exit(1);
}

app.server.on('error', (error) => {
  console.error(`Server error: ${error.message}`);
});

const address = app.server.address();
console.log(`ogis-tiles listening on http://${host}:${address.port}`);

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}; shutting down`);

  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    console.error(`Shutdown failed: ${error.message}`);
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
