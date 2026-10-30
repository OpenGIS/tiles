import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { PmtilesReader } from '../lib/pmtiles.mjs';

const BUILD_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
const MVT_TILE_TYPE = 1;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readBuildId(sidecarPath, fallback) {
  try {
    const parsed = JSON.parse(await readFile(sidecarPath, 'utf8'));
    if (typeof parsed?.buildId === 'string' && BUILD_ID_PATTERN.test(parsed.buildId.trim())) {
      return parsed.buildId.trim();
    }
  } catch {
    // A missing or unreadable sidecar falls back to the archive role.
  }

  return fallback;
}

async function openArchive(archivePath) {
  const reader = new PmtilesReader(archivePath);

  try {
    await reader.open();

    if (reader.getHeader().tileType !== MVT_TILE_TYPE) {
      await reader.close().catch(() => {});
      return { reader: null };
    }

    return { reader };
  } catch {
    await reader.close().catch(() => {});
    return { reader: null };
  }
}

async function closeReaders(readers) {
  await Promise.allSettled(readers.filter(Boolean).map((reader) => reader.close()));
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

export async function createPmtilesSource(name, sourceConfig) {
  const archiveDir = sourceConfig.archiveDir;

  const current = await openArchive(path.join(archiveDir, 'current.pmtiles'));
  const previous = await openArchive(path.join(archiveDir, 'previous.pmtiles'));

  try {
    const currentBuildId = await readBuildId(path.join(archiveDir, 'current.json'), 'current');
    const previousBuildId = await readBuildId(path.join(archiveDir, 'previous.json'), 'previous');

    const header = current.reader ? current.reader.getHeader() : null;

    const minzoom = header ? Math.max(sourceConfig.minzoom, header.minZoom) : sourceConfig.minzoom;
    const maxzoom = header ? Math.min(sourceConfig.maxzoom, header.maxZoom) : sourceConfig.maxzoom;
    const zoomIntersects = minzoom <= maxzoom;
    const advertisedMinzoom = zoomIntersects ? minzoom : null;
    const advertisedMaxzoom = zoomIntersects ? maxzoom : null;
    const available = current.reader !== null && zoomIntersects;

    let metadata = {};
    if (current.reader) {
      try {
        const rawMetadata = await current.reader.getMetadata();
        metadata = isPlainObject(rawMetadata) ? rawMetadata : {};
      } catch {
        metadata = {};
      }
    }

    const attribution = sourceConfig.attribution.map((entry) => ({ ...entry }));
    const vectorLayers = Array.isArray(metadata.vector_layers) ? metadata.vector_layers : [];

    return {
      name,
      kind: sourceConfig.kind,
      title: sourceConfig.title,
      description: sourceConfig.description,
      attribution,
      minzoom: advertisedMinzoom,
      maxzoom: advertisedMaxzoom,
      available,
      buildId: available ? currentBuildId : null,

      async getTile(z, x, y, requestedBuildId) {
        let reader;
        let tileBuildId;

        if (requestedBuildId === undefined || requestedBuildId === null) {
          reader = current.reader;
          tileBuildId = currentBuildId;
        } else if (requestedBuildId === currentBuildId && current.reader) {
          reader = current.reader;
          tileBuildId = currentBuildId;
        } else if (requestedBuildId === previousBuildId && previous.reader) {
          reader = previous.reader;
          tileBuildId = previousBuildId;
        } else {
          return { notFound: true };
        }

        if (!reader) {
          return { notFound: true };
        }

        const tile = await reader.getTile(z, x, y);

        if (!tile) {
          return { empty: true, buildId: tileBuildId };
        }

        return { data: tile.data, compression: tile.compression, buildId: tileBuildId };
      },

      getTileJson(baseUrl) {
        const tileJson = {
          tilejson: '3.0.0',
          name: sourceConfig.title,
          description: sourceConfig.description,
          attribution: formatAttribution(attribution),
          scheme: 'xyz',
          tiles: available ? [`${baseUrl}/${name}/${currentBuildId}/{z}/{x}/{y}.pbf`] : [],
          minzoom: advertisedMinzoom,
          maxzoom: advertisedMaxzoom,
          vector_layers: vectorLayers,
        };

        if (header) {
          tileJson.bounds = [header.minLon, header.minLat, header.maxLon, header.maxLat];
        }

        return tileJson;
      },

      getCatalogueEntry() {
        return {
          name,
          kind: sourceConfig.kind,
          title: sourceConfig.title,
          description: sourceConfig.description,
          attribution,
          minzoom: advertisedMinzoom,
          maxzoom: advertisedMaxzoom,
          available,
          buildId: available ? currentBuildId : null,
          tilejson: `/${name}.json`,
          tiles: available ? [`/${name}/${currentBuildId}/{z}/{x}/{y}.pbf`] : [],
        };
      },

      async close() {
        await closeReaders([current.reader, previous.reader]);
      },
    };
  } catch (error) {
    await closeReaders([current.reader, previous.reader]);
    throw error;
  }
}
