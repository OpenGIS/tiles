import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';

const ROUTE = '/canmore.pmtiles';

const BASE_HEADERS = {
  'Accept-Ranges': 'bytes',
  'Content-Type': 'application/octet-stream',
  'Cache-Control': 'no-store',
};

export function parseRange(header, size) {
  if (header === undefined || header === null || header.trim() === '') {
    return null;
  }

  const match = /^bytes=(.+)$/i.exec(header.trim());
  if (!match) {
    return { invalid: true };
  }

  const specification = match[1].trim();
  if (specification.includes(',')) {
    return { invalid: true };
  }

  const parts = /^(\d*)-(\d*)$/.exec(specification);
  if (!parts) {
    return { invalid: true };
  }

  const [, rawStart, rawEnd] = parts;

  if (rawStart === '' && rawEnd === '') {
    return { invalid: true };
  }

  if (size <= 0) {
    return { invalid: true };
  }

  if (rawStart === '') {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      return { invalid: true };
    }

    return { start: Math.max(size - suffixLength, 0), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start >= size) {
    return { invalid: true };
  }

  if (rawEnd === '') {
    return { start, end: size - 1 };
  }

  let end = Number(rawEnd);
  if (!Number.isSafeInteger(end) || end < start) {
    return { invalid: true };
  }

  if (end >= size) {
    end = size - 1;
  }

  return { start, end };
}

function writeHead(response, status, headers) {
  response.writeHead(status, { ...BASE_HEADERS, ...headers });
}

function handleMissing(response) {
  writeHead(response, 404, { 'Content-Length': '0' });
  response.end();
}

function handleMethodNotAllowed(response) {
  writeHead(response, 405, { Allow: 'GET, HEAD', 'Content-Length': '0' });
  response.end();
}

function streamFile(request, response, archivePath, range) {
  const { start, end, size } = range;
  const length = end - start + 1;

  writeHead(response, 206, {
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Content-Length': String(length),
  });

  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  const stream = createReadStream(archivePath, { start, end });

  stream.on('error', () => {
    if (!response.headersSent) {
      writeHead(response, 500, { 'Content-Length': '0' });
      response.end();
      return;
    }

    response.destroy();
  });

  response.on('close', () => {
    if (!response.writableFinished) {
      stream.destroy();
    }
  });

  stream.pipe(response);
}

function handleRequest(request, response, archivePath, size) {
  const method = request.method ?? 'GET';

  if (method !== 'GET' && method !== 'HEAD') {
    handleMethodNotAllowed(response);
    return;
  }

  if (size === null) {
    handleMissing(response);
    return;
  }

  let url;
  try {
    url = new URL(request.url ?? '/', 'http://localhost');
  } catch {
    handleMissing(response);
    return;
  }

  if (url.pathname !== ROUTE) {
    response.statusCode = 404;
    response.end();
    return;
  }

  const range = parseRange(request.headers.range, size);

  if (range === null) {
    writeHead(response, 200, { 'Content-Length': String(size) });

    if (method === 'HEAD') {
      response.end();
      return;
    }

    const stream = createReadStream(archivePath);

    stream.on('error', () => {
      if (!response.headersSent) {
        writeHead(response, 500, { 'Content-Length': '0' });
        response.end();
        return;
      }

      response.destroy();
    });

    response.on('close', () => {
      if (!response.writableFinished) {
        stream.destroy();
      }
    });

    stream.pipe(response);
    return;
  }

  if (range.invalid) {
    writeHead(response, 416, {
      'Content-Range': `bytes */${size}`,
      'Content-Length': '0',
    });
    response.end();
    return;
  }

  streamFile(request, response, archivePath, { ...range, size });
}

export function pmtilesPlugin() {
  return {
    name: 'pmtiles-range',
    configureServer(server) {
      const archivePath = path.resolve(server.config.root, 'tiles/canmore.pmtiles');
      let size = null;

      try {
        const stats = statSync(archivePath);
        if (stats.isFile()) {
          size = stats.size;
        }
      } catch {
        // Reported below as a startup warning.
      }

      if (size === null) {
        server.config.logger.warn(
          `[pmtiles] archive not found at ${archivePath}; ${ROUTE} will return 404`,
        );
      }

      server.middlewares.use((request, response, next) => {
        let url;
        try {
          url = new URL(request.url ?? '/', 'http://localhost');
        } catch {
          next();
          return;
        }

        if (url.pathname !== ROUTE) {
          next();
          return;
        }

        handleRequest(request, response, archivePath, size);
      });
    },
  };
}
