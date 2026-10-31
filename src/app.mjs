import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';

import { sendEmpty, sendJson, sendTile } from './lib/http.mjs';
import { DemCoverageError, DemDecodeError, SourceUnavailableError } from './lib/errors.mjs';
import { createContourSource } from './sources/contour.mjs';
import { createPmtilesSource } from './sources/pmtiles.mjs';

const SERVICE = 'ogis-tiles';
const VERSION = '2.0.0';

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const SHORT_CACHE = 'public, max-age=300';
const NO_STORE = 'no-store';

const ALLOW = 'GET, HEAD, OPTIONS';
const BUILD_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
const NUMBER_PATTERN = /^\d+$/;
const MAX_DECOMPRESSED_TILE_BYTES = 64 * 1024 * 1024;

function firstHeaderValue(value) {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function normalisePrefix(value) {
  if (!value || !value.startsWith('/')) {
    return '';
  }

  return value.replace(/\/+$/, '');
}

function requestBaseUrl(request, config) {
  if (config.server.publicBaseUrl) {
    return config.server.publicBaseUrl;
  }

  let proto = 'http';
  let host = request.headers.host || `${config.server.host}:${config.server.port}`;
  let prefix = '';

  if (config.server.trustProxy) {
    const forwardedProto = firstHeaderValue(request.headers['x-forwarded-proto']);
    const forwardedProtoValue = forwardedProto?.split(',')[0].trim().toLowerCase();
    if (forwardedProtoValue === 'http' || forwardedProtoValue === 'https') {
      proto = forwardedProtoValue;
    }

    const forwardedHost = firstHeaderValue(request.headers['x-forwarded-host']);
    if (forwardedHost) {
      host = forwardedHost.split(',')[0].trim();
    }

    const forwardedPort = firstHeaderValue(request.headers['x-forwarded-port']);
    const forwardedPortValue = forwardedPort?.split(',')[0].trim();
    if (forwardedPortValue && /^\d+$/.test(forwardedPortValue) && !host.includes(':')) {
      host = `${host}:${forwardedPortValue}`;
    }

    prefix = normalisePrefix(
      firstHeaderValue(request.headers['x-forwarded-prefix'])?.split(',')[0].trim(),
    );
  }

  return `${proto}://${host}${prefix}`;
}

function acceptsGzip(header) {
  if (!header) {
    return false;
  }

  let gzipQuality = null;
  let wildcardQuality = null;

  for (const part of header.split(',')) {
    const [rawCoding, ...params] = part.trim().split(';');
    const coding = rawCoding.trim().toLowerCase();

    if (coding === '') {
      continue;
    }

    let quality = 1;
    for (const param of params) {
      const [rawName, rawValue] = param.trim().split('=');
      if (rawName?.toLowerCase() === 'q') {
        const parsed = Number(rawValue);
        quality = Number.isFinite(parsed) ? parsed : 0;
      }
    }

    if (coding === 'gzip') {
      gzipQuality = quality;
    } else if (coding === '*') {
      wildcardQuality = quality;
    }
  }

  if (gzipQuality !== null) {
    return gzipQuality > 0;
  }

  return wildcardQuality !== null && wildcardQuality > 0;
}

function etagMatches(header, etag) {
  if (!header) {
    return false;
  }

  return header
    .split(',')
    .map((value) => value.trim())
    .some((value) => value === '*' || value === etag || value === `W/${etag}`);
}

function sendError(request, response, status, error) {
  sendJson(request, response, status, { error }, { 'cache-control': NO_STORE });
}

function sendMethodNotAllowed(request, response) {
  sendJson(
    request,
    response,
    405,
    { error: 'method_not_allowed' },
    { allow: ALLOW, 'cache-control': NO_STORE },
  );
}

function sendUpstreamUnavailable(request, response, error) {
  const headers = { 'cache-control': NO_STORE };

  if (error.retryAfter) {
    headers['retry-after'] = String(error.retryAfter);
  }

  sendJson(request, response, 503, { error: 'upstream_unavailable' }, headers);
}

function cacheControlFor(source, versioned) {
  if (versioned) {
    return IMMUTABLE_CACHE;
  }

  if (source.kind === 'contour') {
    return `public, max-age=${source.cacheMaxAge}`;
  }

  return SHORT_CACHE;
}

function parseNumber(value) {
  if (!NUMBER_PATTERN.test(value)) {
    return null;
  }

  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function getSource(sources, name) {
  return Object.hasOwn(sources, name) ? sources[name] : null;
}

function sourceHealth(sources) {
  return Object.fromEntries(
    Object.values(sources).map((source) => [
      source.name,
      { available: source.available, buildId: source.buildId },
    ]),
  );
}

function resolveRoute(pathname, sources) {
  if (pathname === '/') {
    return { type: 'index' };
  }

  if (pathname === '/health') {
    return { type: 'health' };
  }

  if (pathname === '/ready') {
    return { type: 'ready' };
  }

  if (pathname === '/sources') {
    return { type: 'sources' };
  }

  if (pathname.endsWith('.pbf')) {
    const parts = pathname.slice(1).split('/');

    if ((parts.length === 4 || parts.length === 5) && getSource(sources, parts[0])) {
      return { type: 'tile', parts };
    }

    return null;
  }

  if (pathname.endsWith('.json') && !pathname.slice(1, -5).includes('/')) {
    const sourceName = pathname.slice(1, -5);

    if (getSource(sources, sourceName)) {
      return { type: 'tilejson', sourceName };
    }

    return null;
  }

  return null;
}

async function handleTile(request, response, url, parts, sources) {
  if (url.search !== '') {
    sendError(request, response, 400, 'query_string_not_allowed');
    return;
  }

  const versioned = parts.length === 5;
  const source = getSource(sources, parts[0]);

  if (!source) {
    sendError(request, response, 404, 'not_found');
    return;
  }

  const buildId = versioned ? parts[1] : undefined;

  if (versioned && source.kind === 'contour') {
    sendError(request, response, 404, 'not_found');
    return;
  }

  if (versioned && !BUILD_ID_PATTERN.test(buildId)) {
    sendError(request, response, 400, 'invalid_build_id');
    return;
  }

  const offset = versioned ? 2 : 1;
  const z = parseNumber(parts[offset]);
  const x = parseNumber(parts[offset + 1]);
  const yPart = parts[offset + 2];
  const y = yPart.endsWith('.pbf') ? parseNumber(yPart.slice(0, -4)) : null;

  if (z === null || x === null || y === null || z > 26 || x >= 2 ** z || y >= 2 ** z) {
    sendError(request, response, 400, 'invalid_tile_coordinates');
    return;
  }

  if (!source.available) {
    sendError(request, response, 503, 'source_unavailable');
    return;
  }

  const controller = new AbortController();
  const onClose = () => {
    if (!response.writableEnded) {
      controller.abort();
    }
  };
  response.on('close', onClose);

  let result;
  try {
    result = await source.getTile(z, x, y, buildId, { signal: controller.signal });
  } catch (error) {
    if (error instanceof SourceUnavailableError) {
      sendUpstreamUnavailable(request, response, error);
    } else if (error instanceof DemCoverageError) {
      const etag = `"${source.buildId}-${z}-${x}-${y}-empty"`;
      sendEmpty(request, response, 204, {
        etag,
        'cache-control': cacheControlFor(source, versioned),
      });
    } else if (error instanceof DemDecodeError) {
      sendError(request, response, 500, 'internal_error');
    } else {
      sendError(request, response, 500, 'internal_error');
    }
    return;
  } finally {
    response.off('close', onClose);
  }

  if (result.notFound) {
    sendError(request, response, 404, 'not_found');
    return;
  }

  const cacheControl = cacheControlFor(source, versioned);

  if (result.empty) {
    const etag = `"${result.buildId}-${z}-${x}-${y}-empty"`;

    if (etagMatches(request.headers['if-none-match'], etag)) {
      sendEmpty(request, response, 304, { etag, 'cache-control': cacheControl });
      return;
    }

    sendEmpty(request, response, 204, { etag, 'cache-control': cacheControl });
    return;
  }

  const storedGzip = result.compression === 'gzip';
  const encoding =
    storedGzip && acceptsGzip(request.headers['accept-encoding']) ? 'gzip' : 'identity';
  const etag = `"${result.buildId}-${z}-${x}-${y}-${encoding}"`;
  const headers = {
    etag,
    'cache-control': cacheControl,
  };

  if (storedGzip) {
    headers.vary = 'accept-encoding';
  }

  if (etagMatches(request.headers['if-none-match'], etag)) {
    sendEmpty(request, response, 304, headers);
    return;
  }

  let data = result.data;

  if (storedGzip && encoding === 'identity') {
    try {
      data = gunzipSync(data, { maxOutputLength: MAX_DECOMPRESSED_TILE_BYTES });
    } catch {
      sendError(request, response, 500, 'internal_error');
      return;
    }
  }

  if (encoding === 'gzip') {
    headers['content-encoding'] = 'gzip';
  }

  sendTile(request, response, data, headers);
}

async function handleTileJson(request, response, sourceName, config, sources) {
  const source = getSource(sources, sourceName);

  if (!source) {
    sendError(request, response, 404, 'not_found');
    return;
  }

  if (!source.available) {
    sendError(request, response, 503, 'source_unavailable');
    return;
  }

  let tileJson;
  try {
    tileJson = source.getTileJson(requestBaseUrl(request, config));
  } catch {
    sendError(request, response, 500, 'internal_error');
    return;
  }

  sendJson(request, response, 200, tileJson, { 'cache-control': SHORT_CACHE });
}

async function handleRequest(request, response, { config, sources }) {
  let url;
  try {
    url = new URL(request.url, 'http://localhost');
  } catch {
    sendError(request, response, 404, 'not_found');
    return;
  }

  const route = resolveRoute(url.pathname, sources);

  if (!route) {
    sendError(request, response, 404, 'not_found');
    return;
  }

  if (request.method === 'OPTIONS') {
    sendEmpty(request, response, 204, {
      allow: ALLOW,
      'access-control-allow-methods': ALLOW,
      'access-control-allow-headers': 'If-None-Match',
    });
    return;
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendMethodNotAllowed(request, response);
    return;
  }

  if (route.type === 'index') {
    sendJson(
      request,
      response,
      200,
      {
        service: SERVICE,
        version: VERSION,
        endpoints: {
          health: '/health',
          ready: '/ready',
          sources: '/sources',
          tilejson: '/{source}.json',
          tiles: '/{source}/{z}/{x}/{y}.pbf',
          versionedPmtilesTiles: '/{source}/{buildId}/{z}/{x}/{y}.pbf',
        },
      },
      { 'cache-control': NO_STORE },
    );
    return;
  }

  if (route.type === 'health') {
    const sourcesHealth = sourceHealth(sources);
    const available = Object.values(sourcesHealth).every((entry) => entry.available);

    sendJson(
      request,
      response,
      200,
      {
        status: available ? 'ok' : 'degraded',
        service: SERVICE,
        version: VERSION,
        sources: sourcesHealth,
      },
      { 'cache-control': NO_STORE },
    );
    return;
  }

  if (route.type === 'ready') {
    const unavailable = Object.values(sources)
      .filter((source) => !source.available)
      .map((source) => source.name);

    if (unavailable.length === 0) {
      sendJson(request, response, 200, { status: 'ready' }, { 'cache-control': NO_STORE });
    } else {
      sendJson(
        request,
        response,
        503,
        { status: 'not_ready', unavailable },
        { 'cache-control': NO_STORE },
      );
    }
    return;
  }

  if (route.type === 'sources') {
    sendJson(
      request,
      response,
      200,
      { sources: Object.values(sources).map((source) => source.getCatalogueEntry()) },
      { 'cache-control': NO_STORE },
    );
    return;
  }

  if (route.type === 'tile') {
    await handleTile(request, response, url, route.parts, sources);
    return;
  }

  await handleTileJson(request, response, route.sourceName, config, sources);
}

export async function createApp(config) {
  const sources = Object.create(null);

  try {
    for (const [name, sourceConfig] of Object.entries(config.sources)) {
      if (sourceConfig.kind === 'pmtiles') {
        sources[name] = await createPmtilesSource(name, sourceConfig);
      } else if (sourceConfig.kind === 'contour') {
        sources[name] = await createContourSource(name, sourceConfig);
      } else {
        throw new Error(`Unsupported source kind "${sourceConfig.kind}" for source "${name}"`);
      }
    }
  } catch (error) {
    await Promise.allSettled(Object.values(sources).map((source) => source.close()));
    throw error;
  }

  const context = { config, sources };

  const server = createServer((request, response) => {
    handleRequest(request, response, context).catch(() => {
      if (response.headersSent) {
        response.destroy();
        return;
      }

      sendError(request, response, 500, 'internal_error');
    });
  });

  async function close({ graceMs = 5000 } = {}) {
    if (server.listening) {
      await new Promise((resolve) => {
        let settled = false;
        let timer;

        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          resolve();
        };

        timer = setTimeout(() => {
          server.closeAllConnections?.();
          finish();
        }, graceMs);
        timer.unref?.();

        server.close(() => finish());
        server.closeIdleConnections?.();
      });
    }

    await Promise.allSettled(Object.values(sources).map((source) => source.close()));
  }

  return { server, sources, close };
}
