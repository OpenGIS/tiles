import { open } from 'node:fs/promises';

import { PMTiles } from 'pmtiles';

export async function createOracle(filePath) {
  const handle = await open(filePath, 'r');
  const reads = [];

  const source = {
    getKey: () => filePath,
    async getBytes(offset, length) {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      const data = buffer.subarray(0, bytesRead);
      reads.push({ offset, length: bytesRead, data: Buffer.from(data) });
      return {
        data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead),
      };
    },
  };

  return {
    archive: new PMTiles(source),
    reads,
    async close() {
      await handle.close();
    },
  };
}
