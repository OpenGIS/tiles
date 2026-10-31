import { open as openFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const HEADER_SIZE = 127;
const MAGIC = 'PMTiles';
const SPEC_VERSION = 3;
const COMPRESSION_NONE = 1;
const COMPRESSION_GZIP = 2;
const MAX_DIRECTORY_ENTRIES = 10_000_000;
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_TILE_BYTES = 32 * 1024 * 1024;
const MAX_DIRECTORY_DEPTH = 16;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readExact(handle, offset, length, { fileSize, maxLength, label }) {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error(`PMTiles ${label} has an invalid offset`);
  }

  if (!Number.isSafeInteger(length) || length < 0) {
    throw new Error(`PMTiles ${label} has an invalid length`);
  }

  if (length > maxLength) {
    throw new Error(`PMTiles ${label} length ${length} exceeds the ${maxLength}-byte limit`);
  }

  if (offset + length > fileSize) {
    throw new Error(
      `PMTiles ${label} at byte ${offset} with length ${length} exceeds the ${fileSize}-byte archive`,
    );
  }

  const buffer = Buffer.alloc(length);
  let total = 0;

  while (total < length) {
    const { bytesRead } = await handle.read(buffer, total, length - total, offset + total);
    if (bytesRead === 0) {
      throw new Error(`Unexpected end of PMTiles archive at byte ${offset + total}`);
    }
    total += bytesRead;
  }

  return buffer;
}

function readUint64(buffer, offset, label) {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`PMTiles header field ${label} exceeds the safe integer range`);
  }
  return Number(value);
}

function parseHeader(buffer) {
  if (buffer.length < HEADER_SIZE) {
    throw new Error('PMTiles archive is too short to contain a header');
  }

  const magic = buffer.toString('latin1', 0, 7);
  if (magic !== MAGIC) {
    throw new Error(`Invalid PMTiles magic "${magic}"; expected "${MAGIC}"`);
  }

  const specVersion = buffer.readUInt8(7);
  if (specVersion !== SPEC_VERSION) {
    throw new Error(`Unsupported PMTiles version ${specVersion}; only version 3 is supported`);
  }

  return {
    specVersion,
    rootDirectoryOffset: readUint64(buffer, 8, 'rootDirectoryOffset'),
    rootDirectoryLength: readUint64(buffer, 16, 'rootDirectoryLength'),
    jsonMetadataOffset: readUint64(buffer, 24, 'jsonMetadataOffset'),
    jsonMetadataLength: readUint64(buffer, 32, 'jsonMetadataLength'),
    leafDirectoryOffset: readUint64(buffer, 40, 'leafDirectoryOffset'),
    leafDirectoryLength: readUint64(buffer, 48, 'leafDirectoryLength'),
    tileDataOffset: readUint64(buffer, 56, 'tileDataOffset'),
    tileDataLength: readUint64(buffer, 64, 'tileDataLength'),
    numAddressedTiles: readUint64(buffer, 72, 'numAddressedTiles'),
    numTileEntries: readUint64(buffer, 80, 'numTileEntries'),
    numTileContents: readUint64(buffer, 88, 'numTileContents'),
    clustered: buffer.readUInt8(96) === 1,
    internalCompression: buffer.readUInt8(97),
    tileCompression: buffer.readUInt8(98),
    tileType: buffer.readUInt8(99),
    minZoom: buffer.readUInt8(100),
    maxZoom: buffer.readUInt8(101),
    minLon: buffer.readInt32LE(102) / 1e7,
    minLat: buffer.readInt32LE(106) / 1e7,
    maxLon: buffer.readInt32LE(110) / 1e7,
    maxLat: buffer.readInt32LE(114) / 1e7,
    centerZoom: buffer.readUInt8(118),
    centerLon: buffer.readInt32LE(119) / 1e7,
    centerLat: buffer.readInt32LE(123) / 1e7,
  };
}

function validateCompression(header) {
  if (
    header.internalCompression !== COMPRESSION_NONE &&
    header.internalCompression !== COMPRESSION_GZIP
  ) {
    throw new Error(
      `Unsupported PMTiles internal compression ${header.internalCompression}; only none and gzip are supported`,
    );
  }

  if (header.tileCompression !== COMPRESSION_NONE && header.tileCompression !== COMPRESSION_GZIP) {
    throw new Error(
      `Unsupported PMTiles tile compression ${header.tileCompression}; only none and gzip are supported`,
    );
  }
}

function validateSections(header, fileSize) {
  const sections = [
    ['root directory', header.rootDirectoryOffset, header.rootDirectoryLength, MAX_DIRECTORY_BYTES],
    ['metadata', header.jsonMetadataOffset, header.jsonMetadataLength, MAX_METADATA_BYTES],
    [
      'leaf directories',
      header.leafDirectoryOffset,
      header.leafDirectoryLength,
      MAX_DIRECTORY_BYTES,
    ],
    ['tile data', header.tileDataOffset, header.tileDataLength, fileSize],
  ];

  for (const [label, offset, length, maxLength] of sections) {
    if (length > maxLength) {
      throw new Error(`PMTiles ${label} length ${length} exceeds the ${maxLength}-byte limit`);
    }

    if (length === 0) {
      if (offset > fileSize) {
        throw new Error(`PMTiles ${label} offset ${offset} exceeds the ${fileSize}-byte archive`);
      }
      continue;
    }

    if (offset < HEADER_SIZE) {
      throw new Error(`PMTiles ${label} offset ${offset} overlaps the archive header`);
    }

    if (offset + length > fileSize) {
      throw new Error(
        `PMTiles ${label} at byte ${offset} with length ${length} exceeds the ${fileSize}-byte archive`,
      );
    }
  }
}

function decompress(buffer, compression, label, maxOutputLength) {
  if (compression === COMPRESSION_NONE) {
    return buffer;
  }

  if (compression === COMPRESSION_GZIP) {
    try {
      return gunzipSync(buffer, { maxOutputLength });
    } catch (error) {
      throw new Error(`Unable to decompress PMTiles ${label}: ${error.message}`, { cause: error });
    }
  }

  throw new Error(`Unsupported PMTiles ${label} compression ${compression}`);
}

function readVarint(cursor) {
  let result = 0;
  let factor = 1;
  let bytes = 0;

  while (true) {
    if (cursor.position >= cursor.buffer.length) {
      throw new Error('Corrupt PMTiles directory: unexpected end of data');
    }

    const byte = cursor.buffer[cursor.position];
    cursor.position += 1;
    bytes += 1;
    result += (byte & 0x7f) * factor;

    if ((byte & 0x80) === 0) {
      break;
    }

    if (bytes >= 10) {
      throw new Error('Corrupt PMTiles directory: varint is too long');
    }

    factor *= 128;
  }

  if (!Number.isSafeInteger(result)) {
    throw new Error('PMTiles directory value exceeds the safe integer range');
  }

  return result;
}

function decodeDirectory(buffer) {
  const cursor = { buffer, position: 0 };
  const count = readVarint(cursor);
  const remaining = buffer.length - cursor.position;

  if (count > MAX_DIRECTORY_ENTRIES) {
    throw new Error(`Corrupt PMTiles directory: ${count} entries exceeds the supported maximum`);
  }

  if (count > Math.floor(remaining / 4)) {
    throw new Error('Corrupt PMTiles directory: entry count exceeds the available data');
  }

  const entries = new Array(count);

  let tileId = 0;
  for (let index = 0; index < count; index += 1) {
    tileId += readVarint(cursor);
    if (!Number.isSafeInteger(tileId)) {
      throw new Error('PMTiles directory tile id exceeds the safe integer range');
    }
    entries[index] = { tileId, runLength: 0, length: 0, offset: 0 };
  }

  for (let index = 0; index < count; index += 1) {
    entries[index].runLength = readVarint(cursor);
  }

  for (let index = 0; index < count; index += 1) {
    entries[index].length = readVarint(cursor);
  }

  for (let index = 0; index < count; index += 1) {
    const encoded = readVarint(cursor);

    if (encoded === 0) {
      if (index === 0) {
        throw new Error('Corrupt PMTiles directory: the first entry has no offset');
      }
      entries[index].offset = entries[index - 1].offset + entries[index - 1].length;
    } else {
      entries[index].offset = encoded - 1;
    }

    if (!Number.isSafeInteger(entries[index].offset)) {
      throw new Error('PMTiles directory offset exceeds the safe integer range');
    }
  }

  return entries;
}

function findEntry(entries, tileId) {
  let low = 0;
  let high = entries.length - 1;
  let candidate = -1;

  while (low <= high) {
    const middle = (low + high) >> 1;

    if (entries[middle].tileId <= tileId) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (candidate === -1) {
    return null;
  }

  const entry = entries[candidate];
  if (entry.runLength === 0) {
    return entry;
  }

  return tileId - entry.tileId < entry.runLength ? entry : null;
}

export function tileIdToZoom(tileId) {
  if (!Number.isSafeInteger(tileId) || tileId < 0) {
    throw new RangeError('Tile id must be a non-negative safe integer');
  }

  let zoom = 0;
  let base = 0;

  while (zoom <= 26) {
    const count = 4 ** zoom;
    if (tileId < base + count) {
      return zoom;
    }
    base += count;
    zoom += 1;
  }

  throw new RangeError('Tile id is outside the supported zoom range');
}

export function zxyToTileId(z, x, y) {
  if (!Number.isInteger(z) || z < 0 || z > 26) {
    throw new RangeError('Zoom level must be an integer between 0 and 26');
  }

  const size = 2 ** z;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= size || y >= size) {
    throw new RangeError(`Tile coordinates ${x},${y} are outside zoom level ${z}`);
  }

  if (z === 0) {
    return 0;
  }

  const base = (4 ** z - 1) / 3;
  let order = 0;

  for (let step = size / 2; step >= 1; step /= 2) {
    const rx = Math.floor(x / step) % 2;
    const ry = Math.floor(y / step) % 2;

    order += step * step * ((3 * rx) ^ ry);

    if (ry === 0) {
      if (rx === 1) {
        x = size - 1 - x;
        y = size - 1 - y;
      }

      const swap = x;
      x = y;
      y = swap;
    }
  }

  return base + order;
}

export class PmtilesReader {
  constructor(filePath, { directoryCacheSize = 64 } = {}) {
    if (typeof filePath !== 'string' || filePath.trim() === '') {
      throw new TypeError('PmtilesReader requires a file path');
    }

    if (!Number.isInteger(directoryCacheSize) || directoryCacheSize < 0) {
      throw new TypeError('directoryCacheSize must be a non-negative integer');
    }

    this.filePath = filePath;
    this.directoryCacheSize = directoryCacheSize;
    this.directoryCache = new Map();
    this.handle = null;
    this.header = null;
    this.rootDirectory = null;
    this.metadata = undefined;
    this.fileSize = null;
    this.openPromise = null;
  }

  open() {
    if (this.handle && this.rootDirectory) {
      return Promise.resolve(this.header);
    }

    if (!this.openPromise) {
      this.openPromise = this.openInternal().finally(() => {
        this.openPromise = null;
      });
    }

    return this.openPromise;
  }

  async openInternal() {
    let handle;
    try {
      handle = await openFile(this.filePath, 'r');
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`PMTiles archive not found: ${this.filePath}`, { cause: error });
      }
      throw new Error(`Unable to open PMTiles archive ${this.filePath}: ${error.message}`, {
        cause: error,
      });
    }

    try {
      const { size: fileSize } = await handle.stat();
      const headerBuffer = await readExact(handle, 0, HEADER_SIZE, {
        fileSize,
        maxLength: HEADER_SIZE,
        label: 'header',
      });
      const header = parseHeader(headerBuffer);
      validateCompression(header);
      validateSections(header, fileSize);

      this.handle = handle;
      this.header = header;
      this.fileSize = fileSize;
      this.rootDirectory = await this.readDirectory(
        header.rootDirectoryOffset,
        header.rootDirectoryLength,
      );

      return header;
    } catch (error) {
      this.handle = null;
      this.header = null;
      this.rootDirectory = null;
      this.fileSize = null;
      await handle.close().catch(() => {});
      throw error;
    }
  }

  getHeader() {
    this.requireOpen();
    return this.header;
  }

  getMinimumZoom() {
    this.requireOpen();

    if (this.rootDirectory.length === 0) {
      return this.header.minZoom;
    }

    return tileIdToZoom(this.rootDirectory[0].tileId);
  }

  async getMetadata() {
    this.requireOpen();

    if (this.metadata !== undefined) {
      return this.metadata;
    }

    if (this.header.jsonMetadataLength === 0) {
      this.metadata = {};
      return this.metadata;
    }

    const raw = await readExact(
      this.handle,
      this.header.jsonMetadataOffset,
      this.header.jsonMetadataLength,
      {
        fileSize: this.fileSize,
        maxLength: MAX_METADATA_BYTES,
        label: 'metadata',
      },
    );
    const text = decompress(
      raw,
      this.header.internalCompression,
      'metadata',
      MAX_METADATA_BYTES,
    ).toString('utf8');

    if (text.trim() === '') {
      this.metadata = {};
      return this.metadata;
    }

    try {
      const parsed = JSON.parse(text);
      this.metadata = isPlainObject(parsed) ? parsed : {};
    } catch (error) {
      throw new Error(`Corrupt PMTiles metadata JSON: ${error.message}`, { cause: error });
    }

    return this.metadata;
  }

  async getTile(z, x, y) {
    this.requireOpen();

    if (!Number.isInteger(z) || !Number.isInteger(x) || !Number.isInteger(y)) {
      throw new RangeError('Tile coordinates must be integers');
    }

    if (z < this.header.minZoom || z > this.header.maxZoom) {
      return null;
    }

    const tileId = zxyToTileId(z, x, y);
    let directory = this.rootDirectory;

    for (let depth = 0; depth < MAX_DIRECTORY_DEPTH; depth += 1) {
      const entry = findEntry(directory, tileId);

      if (!entry) {
        return null;
      }

      if (entry.runLength > 0) {
        if (entry.length === 0) {
          return null;
        }

        if (entry.length > MAX_TILE_BYTES) {
          throw new Error(`Corrupt PMTiles archive: tile length ${entry.length} is too large`);
        }

        if (entry.offset + entry.length > this.header.tileDataLength) {
          throw new Error('Corrupt PMTiles archive: tile data lies outside the tile section');
        }

        const data = await readExact(
          this.handle,
          this.header.tileDataOffset + entry.offset,
          entry.length,
          {
            fileSize: this.fileSize,
            maxLength: MAX_TILE_BYTES,
            label: 'tile',
          },
        );
        return {
          data,
          compression: this.header.tileCompression === COMPRESSION_GZIP ? 'gzip' : 'none',
        };
      }

      directory = await this.getLeafDirectory(entry);
    }

    throw new Error('Corrupt PMTiles archive: maximum directory depth exceeded');
  }

  async close() {
    if (this.openPromise) {
      await this.openPromise.catch(() => {});
    }

    const handle = this.handle;

    this.handle = null;
    this.header = null;
    this.rootDirectory = null;
    this.metadata = undefined;
    this.fileSize = null;
    this.openPromise = null;
    this.directoryCache.clear();

    if (handle) {
      await handle.close();
    }
  }

  requireOpen() {
    if (!this.handle || !this.rootDirectory) {
      throw new Error('PMTiles archive is not open');
    }
  }

  async readDirectory(offset, length) {
    const raw = await readExact(this.handle, offset, length, {
      fileSize: this.fileSize,
      maxLength: MAX_DIRECTORY_BYTES,
      label: 'directory',
    });
    const decoded = decompress(
      raw,
      this.header.internalCompression,
      'directory',
      MAX_DIRECTORY_BYTES,
    );
    return decodeDirectory(decoded);
  }

  async getLeafDirectory(entry) {
    if (entry.offset + entry.length > this.header.leafDirectoryLength) {
      throw new Error('Corrupt PMTiles archive: leaf directory lies outside the leaf section');
    }

    const key = `${entry.offset}:${entry.length}`;
    const cached = this.directoryCache.get(key);

    if (cached) {
      this.directoryCache.delete(key);
      this.directoryCache.set(key, cached);
      return cached;
    }

    const directory = await this.readDirectory(
      this.header.leafDirectoryOffset + entry.offset,
      entry.length,
    );

    if (directory.length === 0) {
      throw new Error('Corrupt PMTiles archive: empty leaf directory');
    }

    this.directoryCache.set(key, directory);

    while (this.directoryCache.size > this.directoryCacheSize) {
      const oldest = this.directoryCache.keys().next().value;
      this.directoryCache.delete(oldest);
    }

    return directory;
  }
}
