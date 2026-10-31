import mlcontour from 'maplibre-contour';
import sharp from 'sharp';

import { DemDecodeError } from './errors.mjs';

const { decodeParsedImage } = mlcontour;

const WEBP_RIFF = 'RIFF';
const WEBP_MAGIC = 'WEBP';
const WEBP_MAGIC_OFFSET = 8;
const MAGIC_BYTES = 12;

function hasWebpMagic(buffer) {
  return (
    buffer.length >= MAGIC_BYTES &&
    buffer.toString('latin1', 0, 4) === WEBP_RIFF &&
    buffer.toString('latin1', WEBP_MAGIC_OFFSET, MAGIC_BYTES) === WEBP_MAGIC
  );
}

export async function decodeWebpDem(buffer, encoding, tileSize) {
  const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  if (!hasWebpMagic(input)) {
    throw new DemDecodeError('DEM tile is not a WebP image');
  }

  if (!Number.isInteger(tileSize) || tileSize <= 0) {
    throw new DemDecodeError('DEM tile size must be a positive integer');
  }

  try {
    const { data, info } = await sharp(input, {
      limitInputPixels: tileSize * tileSize,
      failOn: 'error',
      sequentialRead: true,
    })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    if (info.width !== tileSize || info.height !== tileSize) {
      throw new DemDecodeError(
        `DEM tile must be ${tileSize}x${tileSize} (received ${info.width}x${info.height})`,
      );
    }

    const rgba = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
    return decodeParsedImage(info.width, info.height, encoding, rgba);
  } catch (error) {
    if (error instanceof DemDecodeError) {
      throw error;
    }

    throw new DemDecodeError(`Unable to decode DEM tile: ${error.message}`, { cause: error });
  }
}
