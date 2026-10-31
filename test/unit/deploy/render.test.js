import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_NGINX_CACHE_OWNER,
  nginxCacheDirectories,
  nginxCacheOwner,
  renderNginxConfig,
  renderSystemdUnit,
} from '../../../src/deploy/render.mjs';
import { loadConfig } from '../../../src/lib/config.mjs';
import { repoRoot } from '../../helpers/temp.mjs';

const layers = loadConfig(path.join(repoRoot, 'config', 'layers.json'), { repoRoot });

describe('renderSystemdUnit', () => {
  it('renders a hardened production unit', () => {
    const unit = renderSystemdUnit({
      deployUser: 'deploy',
      appDir: '/opt/ogis-tiles',
      dataDir: '/opt/ogis-tiles/data',
      nodeBin: '/usr/local/bin/node',
      port: 11010,
      configPath: 'config/layers.json',
      serviceName: 'ogis-tiles.service',
    });

    expect(unit).toContain('User=deploy');
    expect(unit).toContain('WorkingDirectory=/opt/ogis-tiles');
    expect(unit).toContain('ExecStart=/usr/local/bin/node src/server.mjs');
    expect(unit).toContain('Environment=NODE_ENV=production');
    expect(unit).toContain('Environment=HOST=127.0.0.1');
    expect(unit).toContain('Environment=PORT=11010');
    expect(unit).toContain('Environment=CONFIG_PATH=config/layers.json');
    expect(unit).toContain('Environment=PUBLIC_BASE_URL=https://tile.ogis.app');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('NoNewPrivileges=true');
    expect(unit).toContain('ProtectSystem=strict');
    expect(unit).toContain('ReadWritePaths=/opt/ogis-tiles/data');
    expect(unit).toContain('WantedBy=multi-user.target');
  });

  it('rejects root, unsafe paths and privileged ports', () => {
    expect(() => renderSystemdUnit({ deployUser: 'root' })).toThrow(/non-root/);
    expect(() => renderSystemdUnit({ appDir: 'relative' })).toThrow(/absolute path/);
    expect(() => renderSystemdUnit({ port: 80 })).toThrow(/unprivileged port/);
  });

  it('renders the configured public base URL', () => {
    const unit = renderSystemdUnit({ publicBaseUrl: 'http://tile.example.com' });

    expect(unit).toContain('Environment=PUBLIC_BASE_URL=http://tile.example.com');
  });

  it('rejects an invalid public base URL', () => {
    expect(() => renderSystemdUnit({ publicBaseUrl: 'ftp://tile.example.com' })).toThrow(
      /absolute http or https URL/,
    );
  });

  it('quotes paths containing spaces for systemd', () => {
    const unit = renderSystemdUnit({
      deployUser: 'deploy',
      appDir: '/opt/ogis tiles',
      dataDir: '/opt/ogis tiles/data dir',
      nodeBin: '/opt/my node/bin/node',
      port: 11010,
      configPath: 'config/my layers.json',
      serviceName: 'ogis-tiles.service',
    });

    expect(unit).toContain('WorkingDirectory="/opt/ogis tiles"');
    expect(unit).toContain('ExecStart="/opt/my node/bin/node" src/server.mjs');
    expect(unit).toContain('Environment="CONFIG_PATH=config/my layers.json"');
    expect(unit).toContain('ReadWritePaths="/opt/ogis tiles/data dir"');
  });

  it('is deterministic for identical inputs', () => {
    const options = {
      deployUser: 'deploy',
      appDir: '/opt/ogis-tiles',
      dataDir: '/opt/ogis-tiles/data',
      nodeBin: '/usr/local/bin/node',
      port: 11010,
      configPath: 'config/layers.json',
      serviceName: 'ogis-tiles.service',
    };

    expect(renderSystemdUnit(options)).toBe(renderSystemdUnit(options));
  });
});

describe('nginxCacheDirectories', () => {
  it('lists the cache root and one directory per cached source', () => {
    expect(nginxCacheDirectories(layers.sources)).toEqual([
      '/var/cache/nginx',
      '/var/cache/nginx/pois',
      '/var/cache/nginx/routes',
      '/var/cache/nginx/paths',
      '/var/cache/nginx/contours',
    ]);
  });

  it('honours a custom cache root and ignores sources without a cache', () => {
    expect(
      nginxCacheDirectories(
        {
          pois: { kind: 'pmtiles' },
          labels: { kind: 'raster' },
        },
        { cacheRoot: '/srv/nginx/cache' },
      ),
    ).toEqual(['/srv/nginx/cache', '/srv/nginx/cache/pois']);
  });

  it('rejects unsafe cache roots', () => {
    expect(() => nginxCacheDirectories(layers.sources, { cacheRoot: 'relative' })).toThrow(
      /absolute path/,
    );
  });
});

describe('nginxCacheOwner', () => {
  it('defaults to the www-data user and group used by Ubuntu nginx', () => {
    expect(DEFAULT_NGINX_CACHE_OWNER).toBe('www-data');
    expect(nginxCacheOwner()).toBe('www-data');
  });

  it('accepts another valid Linux user name', () => {
    expect(nginxCacheOwner('nginx')).toBe('nginx');
  });

  it('rejects an unsafe cache owner', () => {
    expect(() => nginxCacheOwner('www data')).toThrow(/not a valid Linux user name/);
    expect(() => nginxCacheOwner('-o')).toThrow(/not a valid Linux user name/);
  });
});

describe('renderNginxConfig', () => {
  it('renders per-source cache zones within the 20 GB budget', () => {
    const config = renderNginxConfig({
      host: 'tile.ogis.app',
      port: 11010,
      sources: layers.sources,
      tls: true,
    });

    for (const name of ['pois', 'routes', 'paths', 'contours']) {
      expect(config).toContain(`keys_zone=${name}_cache:10m`);
      expect(config).toContain(`proxy_cache ${name}_cache;`);
    }

    const sizes = [...config.matchAll(/max_size=(\d+)g/g)].map((match) => Number(match[1]));
    expect(sizes.length).toBe(4);
    expect(sizes.reduce((total, size) => total + size, 0)).toBeLessThanOrEqual(20);
    expect(config).toContain('max_size=6g');
    expect(config).toContain('max_size=2g');
  });

  it('proxies every route and sets cache status and lock headers', () => {
    const config = renderNginxConfig({
      host: 'tile.ogis.app',
      port: 11010,
      sources: layers.sources,
      tls: true,
    });

    for (const pathname of [
      'location = /health',
      'location = /ready',
      'location = /sources',
      'location = /pois.json',
      'location /pois/',
      'location = /contours.json',
      'location /contours/',
    ]) {
      expect(config).toContain(pathname);
    }

    expect(config).toContain('proxy_pass http://127.0.0.1:11010;');
    expect(config).toContain('add_header X-Cache-Status $upstream_cache_status always;');
    expect(config).toContain('proxy_cache_lock on;');
    expect(config).toContain('proxy_cache_key "$scheme$request_method$host$request_uri";');
  });

  it('renders TLS, HTTP/2, ACME, redirect and security headers', () => {
    const config = renderNginxConfig({
      host: 'tile.ogis.app',
      port: 11010,
      sources: layers.sources,
      tls: true,
    });

    expect(config).toContain('listen 443 ssl http2;');
    expect(config).toContain('listen [::]:443 ssl http2;');
    expect(config).toContain('ssl_certificate /etc/letsencrypt/live/tile.ogis.app/fullchain.pem;');
    expect(config).toContain(
      'ssl_certificate_key /etc/letsencrypt/live/tile.ogis.app/privkey.pem;',
    );
    expect(config).toContain('location /.well-known/acme-challenge/ {');
    expect(config).toContain('root /var/www/certbot;');
    expect(config).toContain('return 301 https://$host$request_uri;');
    expect(config).toContain('Strict-Transport-Security');
    expect(config).toContain('X-Content-Type-Options');
    expect(config).toContain('X-Frame-Options');
  });

  it('renders an HTTP-only ACME configuration without TLS directives', () => {
    const config = renderNginxConfig({
      host: 'tile.ogis.app',
      port: 11010,
      sources: layers.sources,
      tls: false,
    });

    expect(config).toContain('listen 80;');
    expect(config).toContain('location /.well-known/acme-challenge/ {');
    expect(config).toContain('proxy_pass http://127.0.0.1:11010;');
    expect(config).not.toContain('ssl_certificate');
    expect(config).not.toContain('return 301');
  });

  it('renders contour routes and caches from the configured source name', () => {
    const sources = {
      pois: layers.sources.pois,
      terrain: layers.sources.contours,
    };
    const config = renderNginxConfig({
      host: 'tile.ogis.app',
      port: 11010,
      sources,
      tls: true,
    });

    expect(config).toContain('location = /terrain.json');
    expect(config).toContain('location /terrain/');
    expect(config).toContain('keys_zone=terrain_cache:10m');
    expect(config).toContain('proxy_cache_path /var/cache/nginx/terrain');
    expect(config).not.toContain('/contours.json');
    expect(config).not.toContain('/contours/');
  });

  it('is deterministic for identical inputs', () => {
    const options = {
      host: 'tile.ogis.app',
      port: 11010,
      sources: layers.sources,
      tls: true,
    };

    expect(renderNginxConfig(options)).toBe(renderNginxConfig(options));
  });

  it('rejects unsafe hosts and source names', () => {
    expect(() => renderNginxConfig({ host: 'tile ogis app', sources: layers.sources })).toThrow(
      /valid hostname/,
    );
    expect(() =>
      renderNginxConfig({
        host: 'tile.ogis.app',
        sources: { 'bad name': { kind: 'pmtiles' } },
      }),
    ).toThrow(/not safe for nginx/);
  });
});
