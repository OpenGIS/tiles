import { gunzipSync } from 'node:zlib';

import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';

import {
  pmtilesMetadataArgs,
  pmtilesShowArgs,
  pmtilesTileArgs,
  pmtilesVerifyArgs,
} from './commands.mjs';
import { BuildError } from './errors.mjs';
import { fileSize } from './fs.mjs';
import { runCommand } from './exec.mjs';
import { assertSizeFloor, assertVerification } from './manifest.mjs';

export function parseTileCount(showOutput) {
  const match = /^addressed tiles count:\s*(\d+)$/m.exec(String(showOutput));
  if (!match) {
    throw new BuildError('Unable to read the tile count from pmtiles show');
  }

  return Number(match[1]);
}

export function parseTileCompression(showOutput) {
  const match = /^tile compression:\s*(\S+)$/m.exec(String(showOutput));
  if (!match) {
    throw new BuildError('Unable to read the tile compression from pmtiles show');
  }

  return match[1];
}

export function assertVerifyCommandOutput(output) {
  const text = String(output ?? '');

  if (/Failed to verify/i.test(text)) {
    const detail = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /Failed to verify/i.test(line));

    throw new BuildError(`pmtiles verify reported a failure${detail ? `: ${detail}` : ''}`);
  }

  if (!/(Completed verify|verified successfully|archive verified)/i.test(text)) {
    throw new BuildError('pmtiles verify did not report a successful verification');
  }
}

export function verificationLayers(verification) {
  if (!verification) {
    return [];
  }

  if (Array.isArray(verification.layers)) {
    return verification.layers;
  }

  if (typeof verification.layer === 'string') {
    return [
      {
        layer: verification.layer,
        requiredAttributes: Array.isArray(verification.requiredAttributes)
          ? verification.requiredAttributes
          : [],
        ...(verification.geometry === undefined ? {} : { geometry: verification.geometry }),
      },
    ];
  }

  return [];
}

const GEOMETRY_TYPES = {
  point: 1,
  line: 2,
  polygon: 3,
};

function asBuffer(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  return Buffer.from(value ?? '');
}

function decodeLayer(data, layer) {
  const vectorTile = new VectorTile(new PbfReader(data));
  return vectorTile.layers[layer];
}

export async function decodeSampleTile({
  archivePath,
  sample,
  layer,
  requiredAttributes = [],
  verification,
  execFileImpl,
}) {
  const { stdout } = await runCommand('pmtiles', pmtilesTileArgs(archivePath, sample), {
    execFileImpl,
    encoding: null,
  });

  const bytes = asBuffer(stdout);
  if (bytes.length === 0) {
    throw new BuildError(
      `Sample tile ${sample.z}/${sample.x}/${sample.y} is empty in ${archivePath}`,
    );
  }

  const data = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  const configuredLayers = verificationLayers(verification);

  if (configuredLayers.length === 0 && typeof layer === 'string') {
    configuredLayers.push({ layer, requiredAttributes });
  }

  if (configuredLayers.length === 0) {
    throw new BuildError('No verification layer is configured for the sample tile');
  }

  let features = 0;
  const attributes = new Set();
  const layerResults = [];
  const geometries = new Set();

  for (const configured of configuredLayers) {
    const vectorLayer = decodeLayer(data, configured.layer);

    if (!vectorLayer || vectorLayer.length === 0) {
      throw new BuildError(
        `Sample tile ${sample.z}/${sample.x}/${sample.y} has no features in layer "${configured.layer}"`,
      );
    }

    const layerAttributes = new Set();
    const layerGeometries = new Set();
    for (let index = 0; index < vectorLayer.length; index += 1) {
      const feature = vectorLayer.feature(index);
      for (const key of Object.keys(feature.properties)) {
        layerAttributes.add(key);
        attributes.add(key);
      }
      layerGeometries.add(feature.type);
      geometries.add(feature.type);
    }

    for (const required of configured.requiredAttributes ?? []) {
      if (!layerAttributes.has(required)) {
        throw new BuildError(
          `Sample tile ${sample.z}/${sample.x}/${sample.y} layer "${configured.layer}" is missing the "${required}" attribute`,
        );
      }
    }

    if (configured.geometry !== undefined) {
      const expectedType = GEOMETRY_TYPES[configured.geometry];
      if (!layerGeometries.has(expectedType)) {
        throw new BuildError(
          `Sample tile ${sample.z}/${sample.x}/${sample.y} layer "${configured.layer}" has no ${configured.geometry} geometry`,
        );
      }
    }

    features += vectorLayer.length;
    layerResults.push({ layer: configured.layer, features: vectorLayer.length });
  }

  return {
    z: sample.z,
    x: sample.x,
    y: sample.y,
    layer: configuredLayers.map((entry) => entry.layer).join(','),
    layers: layerResults,
    features,
    attributes: [...attributes].sort(),
    geometries: [...geometries].sort((a, b) => a - b),
  };
}

function firstLine(value) {
  return (
    String(value ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '') ?? ''
  );
}

export async function readArchiveMetadata({ archivePath, execFileImpl }) {
  try {
    const { stdout } = await runCommand('pmtiles', pmtilesMetadataArgs(archivePath), {
      execFileImpl,
    });
    const metadata = JSON.parse(stdout);

    return {
      available: true,
      osmReplicationTime: metadata['planetiler:osm:osmosisreplicationtime'] ?? null,
      osmReplicationSequence: metadata['planetiler:osm:osmosisreplicationseq'] ?? null,
      osmReplicationUrl: metadata['planetiler:osm:osmosisreplicationurl'] ?? null,
      planetilerVersion: metadata['planetiler:version'] ?? null,
      planetilerBuildTime: metadata['planetiler:buildtime'] ?? null,
    };
  } catch (error) {
    return {
      available: false,
      unavailableReason: firstLine(error?.message) || 'pmtiles metadata unavailable',
      osmReplicationTime: null,
    };
  }
}

async function inspectArchive({ archivePath, sizeFloor, execFileImpl }) {
  const bytes = await fileSize(archivePath);
  assertSizeFloor({ bytes, floor: sizeFloor, label: pathLabel(archivePath) });

  const { stdout: showOutput } = await runCommand('pmtiles', pmtilesShowArgs(archivePath), {
    execFileImpl,
  });
  const tiles = parseTileCount(showOutput);
  const compression = parseTileCompression(showOutput);
  const metadata = await readArchiveMetadata({ archivePath, execFileImpl });

  return { bytes, tiles, compression, metadata };
}

export async function verifyArchive({
  archivePath,
  samples,
  sizeFloor,
  verification,
  layer,
  requiredAttributes = [],
  execFileImpl,
}) {
  const { stdout, stderr } = await runCommand('pmtiles', pmtilesVerifyArgs(archivePath), {
    execFileImpl,
  });
  assertVerifyCommandOutput(`${stdout}\n${stderr}`);

  const { bytes, tiles, compression, metadata } = await inspectArchive({
    archivePath,
    sizeFloor,
    execFileImpl,
  });

  if (compression !== 'gzip') {
    throw new BuildError(
      `Archive ${pathLabel(archivePath)} stores tiles with "${compression}" compression; gzip is required`,
    );
  }

  if (tiles < 1) {
    throw new BuildError(`Archive ${pathLabel(archivePath)} contains no addressed tiles`);
  }

  const layers = verificationLayers(verification);
  const results = [];
  for (const sample of samples) {
    results.push(
      await decodeSampleTile({
        archivePath,
        sample,
        layer,
        requiredAttributes,
        verification,
        execFileImpl,
      }),
    );
  }

  assertVerification({
    verification: { ok: true, skipped: false },
    samples: results,
    floor: sizeFloor,
    bytes,
    tiles,
  });

  return {
    verification: { ok: true, skipped: false, layers },
    samples: results,
    bytes,
    tiles,
    compression,
    metadata,
  };
}

export async function inspectArchiveWithoutVerification({ archivePath, sizeFloor, execFileImpl }) {
  const { bytes, tiles, compression, metadata } = await inspectArchive({
    archivePath,
    sizeFloor,
    execFileImpl,
  });

  return {
    verification: { ok: false, skipped: true },
    samples: [],
    bytes,
    tiles,
    compression,
    metadata,
  };
}

function pathLabel(archivePath) {
  return archivePath.split(/[\\/]/).slice(-3).join('/');
}
