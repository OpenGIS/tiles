import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

import mlcontour from 'maplibre-contour';

import { decodeWebpDem } from '../lib/dem.mjs';
import { DemCoverageError, DemDecodeError, SourceUnavailableError } from '../lib/errors.mjs';

const { LocalDemManager } = mlcontour;

const MAX_DEM_BODY_BYTES = 5 * 1024 * 1024;
const DEFAULT_RETRY_AFTER = 60;

const BUILD_ID_FIELDS = [
  'demUrl',
  'encoding',
  'demMaxzoom',
  'demTileSize',
  'thresholds',
  'buffer',
  'extent',
  'contourLayer',
  'elevationKey',
  'levelKey',
  'minzoom',
  'maxzoom',
];

function parseRetryAfter(value) {
  if (typeof value !== 'string') {
    return DEFAULT_RETRY_AFTER;
  }

  const trimmed = value.trim();

  if (!/^\d+$/.test(trimmed)) {
    return DEFAULT_RETRY_AFTER;
  }

  const seconds = Number(trimmed);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : DEFAULT_RETRY_AFTER;
}

async function cancelBody(response) {
  const body = response?.body;

  if (!body || typeof body.cancel !== 'function') {
    return;
  }

  try {
    await body.cancel();
  } catch {
    // Ignore cancellation failures; the original error is more useful.
  }
}

function oversizedDemError() {
  return new DemDecodeError(`DEM tile exceeds the ${MAX_DEM_BODY_BYTES} byte limit`);
}

async function readCappedBody(response) {
  const declaredHeader = response.headers?.get?.('content-length');

  if (declaredHeader) {
    const declared = Number(declaredHeader);

    if (Number.isFinite(declared) && declared > MAX_DEM_BODY_BYTES) {
      await cancelBody(response);
      throw oversizedDemError();
    }
  }

  const body = response.body;

  if (!body || typeof body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.byteLength > MAX_DEM_BODY_BYTES) {
      throw oversizedDemError();
    }

    return buffer;
  }

  const reader = body.getReader();
  const chunks = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      if (!value) {
        continue;
      }

      total += value.byteLength;

      if (total > MAX_DEM_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // Ignore cancellation failures; the size limit error is what matters.
        }

        throw oversizedDemError();
      }

      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } finally {
    reader.releaseLock?.();
  }

  return Buffer.concat(chunks, total);
}

function escapeHtml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatAttribution(attribution) {
  return attribution
    .map((entry) => `<a href="${escapeHtml(entry.href)}">${escapeHtml(entry.title)}</a>`)
    .join(' · ');
}

function canonicalThresholds(thresholds) {
  const canonical = {};

  for (const zoom of Object.keys(thresholds)
    .map(Number)
    .sort((a, b) => a - b)) {
    canonical[String(zoom)] = [...thresholds[String(zoom)]];
  }

  return canonical;
}

export function contourBuildId(config) {
  const payload = {};

  for (const field of BUILD_ID_FIELDS) {
    payload[field] =
      field === 'thresholds' ? canonicalThresholds(config.thresholds) : config[field];
  }

  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 12);
}

export function getOptionsForZoom(options, zoom) {
  const { thresholds, ...rest } = options;

  if (!thresholds) {
    return options;
  }

  const entries = Object.entries(thresholds)
    .map(([zoomString, value]) => ({
      zoom: Number(zoomString),
      levels: Array.isArray(value) ? [...value] : [value],
    }))
    .sort((a, b) => a.zoom - b.zoom);

  if (entries.length === 0) {
    return { levels: [], ...rest };
  }

  let levels = entries[0].levels;

  for (const entry of entries) {
    if (entry.zoom > zoom) {
      break;
    }
    levels = entry.levels;
  }

  return { levels, ...rest };
}

function linkSignal(signal, controller) {
  if (!signal) {
    return () => {};
  }

  if (signal.aborted) {
    controller.abort(signal.reason);
    return () => {};
  }

  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });

  return () => signal.removeEventListener('abort', onAbort);
}

function isTimeoutOrAbort(error) {
  return (
    error?.name === 'AbortError' ||
    /timed out|aborted|canceled|cancelled/i.test(error?.message ?? '')
  );
}

export async function createContourSource(name, config, deps = {}) {
  const fetchTile = deps.fetch ?? globalThis.fetch;
  const buildId = contourBuildId(config);

  if (typeof fetchTile !== 'function') {
    throw new Error('A fetch implementation is required for contour sources');
  }

  const baseOptions = {
    multiplier: 1,
    contourLayer: config.contourLayer,
    elevationKey: config.elevationKey,
    levelKey: config.levelKey,
    extent: config.extent,
    buffer: config.buffer,
    thresholds: config.thresholds,
  };

  async function getDemTile(url, managerController) {
    const controller = new AbortController();
    const unlink = linkSignal(managerController?.signal, controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, config.timeoutMs);
    timer.unref?.();

    try {
      const response = await fetchTile(url, {
        signal: controller.signal,
        headers: { accept: 'image/webp' },
      });

      const status = response.status;
      const ok = response.ok ?? (status >= 200 && status < 300);

      if (status === 204 || status === 404 || status === 410) {
        await cancelBody(response);
        throw new DemCoverageError(`No DEM coverage for ${url}`);
      }

      if (status === 429 || status >= 500) {
        await cancelBody(response);
        throw new SourceUnavailableError(`DEM source returned HTTP ${status}`, {
          retryAfter: parseRetryAfter(response.headers?.get?.('retry-after')),
        });
      }

      if (!ok) {
        await cancelBody(response);
        throw new SourceUnavailableError(`DEM source returned HTTP ${status}`, {
          retryAfter: DEFAULT_RETRY_AFTER,
        });
      }

      const buffer = await readCappedBody(response);
      return {
        data: new Blob([buffer], {
          type: response.headers?.get?.('content-type') ?? 'image/webp',
        }),
      };
    } catch (error) {
      if (
        error instanceof SourceUnavailableError ||
        error instanceof DemCoverageError ||
        error instanceof DemDecodeError
      ) {
        throw error;
      }

      const message = timedOut ? 'DEM request timed out' : 'DEM request failed';
      throw new SourceUnavailableError(message, { retryAfter: 60, cause: error });
    } finally {
      clearTimeout(timer);
      unlink();
    }
  }

  async function decodeImage(blob, encoding) {
    return decodeWebpDem(Buffer.from(await blob.arrayBuffer()), encoding, config.demTileSize);
  }

  const manager =
    deps.manager ??
    new LocalDemManager({
      cacheSize: config.cacheSize,
      demUrlPattern: config.demUrl,
      encoding: config.encoding,
      maxzoom: config.demMaxzoom,
      timeoutMs: config.timeoutMs,
      decodeImage,
      getTile: getDemTile,
    });

  const attribution = config.attribution.map((entry) => ({ ...entry }));

  return {
    name,
    kind: config.kind,
    title: config.title,
    description: config.description,
    attribution,
    minzoom: config.minzoom,
    maxzoom: config.maxzoom,
    available: true,
    buildId,
    cacheMaxAge: config.cacheMaxAge,

    async getTile(z, x, y, requestedBuildId, options = {}) {
      if (
        requestedBuildId !== undefined &&
        requestedBuildId !== null &&
        requestedBuildId !== buildId
      ) {
        return { notFound: true };
      }

      if (z < config.minzoom || z > config.maxzoom) {
        return { empty: true, buildId };
      }

      const controller = new AbortController();
      const unlink = linkSignal(options.signal, controller);

      try {
        const tile = await manager.fetchContourTile(
          z,
          x,
          y,
          getOptionsForZoom(baseOptions, z),
          controller,
        );

        if (!tile?.arrayBuffer || tile.arrayBuffer.byteLength === 0) {
          return { empty: true, buildId };
        }

        const data = gzipSync(Buffer.from(tile.arrayBuffer));

        if (data.length === 0) {
          return { empty: true, buildId };
        }

        return { data, compression: 'gzip', buildId };
      } catch (error) {
        if (error instanceof DemCoverageError || options.signal?.aborted) {
          return { empty: true, buildId };
        }

        if (error instanceof SourceUnavailableError || error instanceof DemDecodeError) {
          throw error;
        }

        if (isTimeoutOrAbort(error)) {
          throw new SourceUnavailableError('DEM request aborted', {
            retryAfter: 60,
            cause: error,
          });
        }

        throw error;
      } finally {
        unlink();
      }
    },

    getTileJson(baseUrl) {
      return {
        tilejson: '3.0.0',
        name: config.title,
        description: config.description,
        attribution: formatAttribution(attribution),
        scheme: 'xyz',
        tiles: [`${baseUrl}/${name}/{z}/{x}/{y}.pbf`],
        minzoom: config.minzoom,
        maxzoom: config.maxzoom,
        vector_layers: [
          {
            id: config.contourLayer,
            fields: {
              [config.elevationKey]: 'Number',
              [config.levelKey]: 'Number',
            },
            minzoom: config.minzoom,
            maxzoom: config.maxzoom,
          },
        ],
      };
    },

    getCatalogueEntry() {
      return {
        name,
        kind: config.kind,
        title: config.title,
        description: config.description,
        attribution,
        minzoom: config.minzoom,
        maxzoom: config.maxzoom,
        available: true,
        buildId,
        tilejson: `/${name}.json`,
        tiles: [`/${name}/{z}/{x}/{y}.pbf`],
      };
    },

    async close() {
      for (const cache of [manager.tileCache, manager.parsedCache, manager.contourCache]) {
        cache?.clear?.();
      }
    },
  };
}
