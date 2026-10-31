import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const helpersDir = path.dirname(fileURLToPath(import.meta.url));

export const demFixtureDir = path.resolve(helpersDir, '..', 'fixtures', 'dem');
export const demTilePattern = /^\/(\d+)\/(\d+)\/(\d+)\.webp$/;

export async function createDemServer({ root = demFixtureDir, respond } = {}) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const match = demTilePattern.exec(url.pathname);

      if (!match) {
        response.writeHead(404);
        response.end();
        return;
      }

      const z = Number(match[1]);
      const x = Number(match[2]);
      const y = Number(match[3]);

      if (respond) {
        const handled = await respond({ url, z, x, y, response });
        if (handled) {
          return;
        }
      }

      const data = await readFile(path.join(root, String(z), String(x), `${y}.webp`));
      response.writeHead(200, { 'content-type': 'image/webp' });
      response.end(data);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
