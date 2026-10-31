import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';

const ROUTE_PREFIX = '/dem/';
const TILE_PATTERN = /^\/dem\/(\d+)\/(\d+)\/(\d+)\.webp$/;

function notFound(response) {
  response.statusCode = 404;
  response.end();
}

export function demPlugin() {
  return {
    name: 'dem-fixtures',
    configureServer(server) {
      const fixtureRoot = path.resolve(server.config.root, '..', 'test', 'fixtures', 'dem');

      server.middlewares.use((request, response, next) => {
        let url;
        try {
          url = new URL(request.url ?? '/', 'http://localhost');
        } catch {
          next();
          return;
        }

        if (!url.pathname.startsWith(ROUTE_PREFIX)) {
          next();
          return;
        }

        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.statusCode = 405;
          response.setHeader('Allow', 'GET, HEAD');
          response.end();
          return;
        }

        const match = TILE_PATTERN.exec(url.pathname);

        if (!match) {
          notFound(response);
          return;
        }

        const [, z, x, y] = match;
        const tilePath = path.join(fixtureRoot, z, x, `${y}.webp`);
        const relative = path.relative(fixtureRoot, tilePath);

        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          notFound(response);
          return;
        }

        let stats;
        try {
          stats = statSync(tilePath);
        } catch {
          notFound(response);
          return;
        }

        if (!stats.isFile()) {
          notFound(response);
          return;
        }

        response.setHeader('Content-Type', 'image/webp');
        response.setHeader('Content-Length', String(stats.size));
        response.setHeader('Cache-Control', 'no-store');

        if (request.method === 'HEAD') {
          response.end();
          return;
        }

        const stream = createReadStream(tilePath);

        stream.on('error', () => {
          if (!response.headersSent) {
            response.statusCode = 500;
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
      });
    },
  };
}
