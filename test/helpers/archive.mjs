import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

function writeUint64(buffer, offset, value) {
  buffer.writeBigUInt64LE(BigInt(value), offset);
}

export function buildHeader(overrides = {}) {
  const header = Buffer.alloc(127);

  header.write(overrides.magic ?? 'PMTiles', 0, 'latin1');
  header.writeUInt8(overrides.version ?? 3, 7);
  writeUint64(header, 8, overrides.rootDirectoryOffset ?? 127);
  writeUint64(header, 16, overrides.rootDirectoryLength ?? 1);
  writeUint64(header, 24, overrides.jsonMetadataOffset ?? 0);
  writeUint64(header, 32, overrides.jsonMetadataLength ?? 0);
  writeUint64(header, 40, overrides.leafDirectoryOffset ?? 0);
  writeUint64(header, 48, overrides.leafDirectoryLength ?? 0);
  writeUint64(header, 56, overrides.tileDataOffset ?? 0);
  writeUint64(header, 64, overrides.tileDataLength ?? 0);
  writeUint64(header, 72, overrides.numAddressedTiles ?? 0);
  writeUint64(header, 80, overrides.numTileEntries ?? 0);
  writeUint64(header, 88, overrides.numTileContents ?? 0);
  header.writeUInt8(overrides.clustered ? 1 : 0, 96);
  header.writeUInt8(overrides.internalCompression ?? 1, 97);
  header.writeUInt8(overrides.tileCompression ?? 1, 98);
  header.writeUInt8(overrides.tileType ?? 1, 99);
  header.writeUInt8(overrides.minZoom ?? 0, 100);
  header.writeUInt8(overrides.maxZoom ?? 16, 101);
  header.writeUInt8(overrides.centerZoom ?? 0, 118);

  return header;
}

export async function writeArchiveFile(filePath, { header = {}, body = Buffer.alloc(0) } = {}) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.concat([buildHeader(header), body]));
}

export async function writeSyntheticArchive(
  archiveDir,
  { tileType = 1, minZoom = 0, maxZoom = 16, metadata = {}, buildId = 'synthetic' } = {},
) {
  const root = Buffer.from([0]);
  const metadataBuffer = Buffer.from(
    typeof metadata === 'string' ? metadata : JSON.stringify(metadata),
  );
  const body = Buffer.concat([root, metadataBuffer]);
  const header = {
    rootDirectoryOffset: 127,
    rootDirectoryLength: root.length,
    jsonMetadataOffset: 127 + root.length,
    jsonMetadataLength: metadataBuffer.length,
    tileType,
    minZoom,
    maxZoom,
  };

  await writeArchiveFile(path.join(archiveDir, 'current.pmtiles'), { header, body });
  await writeFile(path.join(archiveDir, 'current.json'), JSON.stringify({ buildId }), 'utf8');
}
