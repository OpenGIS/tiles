# OpenGIS tiles

Small, API-only tile server for OpenStreetMap-derived outdoor layers.

> [!NOTE]
> This is the v2 rewrite. The v1 tile server remains archived.

## Status

Phase 1, the serving core, is implemented: manifest validation, a minimal PMTiles v3 reader, a
current/previous source adapter, the HTTP serving core and tests.

Phase 2, the local development harness, is implemented: a Vite and MapLibre app renders a vendored
Canmore–Banff basemap and can toggle the outdoor sources served by the tile server. Phases 3–7 are
pending: contours, build pipelines, provisioning, planet build and hardening. The server remains
API-only; the harness is a development tool, not a production frontend.

## Requirements

- Node.js 24
- npm

## Quick start

```sh
npm install
npm start
```

`npm start` loads `.env` when present and listens on the host and port from `config/layers.json`,
by default `127.0.0.1:11010`. Then:

```sh
curl -s http://127.0.0.1:11010/health
curl -i http://127.0.0.1:11010/pois.json
```

To preview the map, run `npm run dev`. It starts the tile server on `127.0.0.1:11010` and the Vite
harness on `127.0.0.1:11011`; open <http://127.0.0.1:11011>. The harness serves a vendored
Canmore–Banff basemap and a source panel for `pois`, `routes` and `paths`. See
[docs/3.dev-harness.md](docs/3.dev-harness.md) for provenance, ports and the browser test.

> [!WARNING]
> Archives are not committed. A fresh checkout starts, but every source in the shipped manifest
> (`pois`, `routes`, `paths`) is unavailable: `/health` reports `degraded` with `available: false`
> for each missing source, `/sources` shows the same, and `/ready` returns 503 while any source is
> unavailable. Supplying only `data/pois/current.pmtiles` makes `pois` available; `routes` and
> `paths` remain missing.

A minimal source directory only needs the archive:

```text
data/pois/
└── current.pmtiles
```

An optional `current.json` sidecar supplies a build ID:

```json
{ "buildId": "2026-10-30" }
```

Without it, the build ID defaults to `current`.

## Configuration

`config/layers.json` is the single source of truth for the server and every source. Set
`CONFIG_PATH` to load a different manifest. Relative `archiveDir` values resolve against the
repository root, not the manifest's directory; an absolute path is trusted.

The excerpt below is abridged: it shows only the `pois` source. The shipped manifest defines
`pois`, `routes` and `paths`.

```json
{
  "version": 1,
  "server": {
    "host": "127.0.0.1",
    "port": 11010,
    "publicBaseUrl": null,
    "trustProxy": false
  },
  "sources": {
    "pois": {
      "kind": "pmtiles",
      "title": "Outdoor POIs",
      "description": "Huts, shelters, viewpoints and other outdoor points of interest.",
      "attribution": [
        { "title": "OpenStreetMap", "href": "https://www.openstreetmap.org/copyright" }
      ],
      "archiveDir": "data/pois",
      "minzoom": 12,
      "maxzoom": 16
    }
  }
}
```

The validator rejects unknown keys, unsupported source kinds, invalid source names, bad zoom ranges,
non-http(s) attribution links and relative paths that escape the repository root. `HOST`, `PORT` and
`PUBLIC_BASE_URL` override the manifest; `CONFIG_PATH` selects a different manifest. Forwarded
headers are ignored unless `server.trustProxy` is `true`; a configured `publicBaseUrl` always wins.
Full rules: [docs/2.architecture.md](docs/2.architecture.md#manifest).

## Endpoints

| Method | Path                                  | Description                                 |
| ------ | ------------------------------------- | ------------------------------------------- |
| `GET`  | `/`                                   | Service index.                              |
| `GET`  | `/health`                             | Availability of every source.               |
| `GET`  | `/ready`                              | Readiness; 503 while any source is missing. |
| `GET`  | `/sources`                            | Source catalogue.                           |
| `GET`  | `/<source>.json`                      | TileJSON 3.0.0.                             |
| `GET`  | `/<source>/<z>/<x>/<y>.pbf`           | Current tile.                               |
| `GET`  | `/<source>/<buildId>/<z>/<x>/<y>.pbf` | Versioned tile.                             |

`HEAD` and `OPTIONS` are supported on known routes. Unknown routes return 404; unsupported methods
return 405; invalid coordinates, invalid build IDs and tile query strings return 400. `/health`
always returns 200 and reports `degraded`, while `/ready` returns 503 while any source is unavailable.

Tiles are `application/x-protobuf`; empty tiles return 204. Gzip-stored tiles are returned as stored
when accepted, otherwise decompressed to identity. ETags include the build ID and coordinates and
end in `-gzip`, `-identity` or `-empty`; a matching `If-None-Match` returns 304. Versioned URLs are
immutable; unversioned tiles and TileJSON use a short TTL; health and errors are `no-store`. Full
contract:
[docs/2.architecture.md](docs/2.architecture.md#http-contract).

## Data layout

Each source has its own directory:

```text
data/pois/
├── current.pmtiles
├── current.json
├── previous.pmtiles
└── previous.json
```

- `current.pmtiles` is required and served by unversioned tile URLs.
- `previous.pmtiles` is the optional rollback archive, served only by its versioned URL.
- `current.json` and `previous.json` are optional sidecars that may contain `{ "buildId": "..." }`;
  without them the build IDs default to `current` and `previous`.
- A missing or unreadable current archive marks the source unavailable. A missing previous archive
  only removes the rollback URL.
- Archives are opened at startup, so replacing one requires a restart.

Atomic promote and rollback are future operational steps. The `current`/`previous` layout and
immutable versioned URLs support them.

## Testing

```sh
npm test
npm run test:e2e
npm run format:check
```

Unit and integration tests use Vitest. A small POI archive fixture lives in `test/fixtures/`, with
its SHA-256 and provenance recorded in the accompanying manifest. These tests bind ephemeral ports
and use the gitignored `tmp/` directory for temporary archives.

`npm run test:e2e` runs the Playwright smoke test against a fixture manifest whose archives are
absent, so a test-started server begins from a deterministic unavailable state. Playwright launches
the tile server on `127.0.0.1:11010` and Vite on `127.0.0.1:11011`, or reuses servers already
listening on those ports, then checks the rendered map and attribution, rejects console errors,
failed responses and external requests, and saves a screenshot.

## Layout

- `config/layers.json` — the manifest.
- `src/` — HTTP server, config validation, PMTiles reader and source adapters.
- `dev/` — Vite and MapLibre harness, vendored basemap and PMTiles range plugin.
- `test/` — unit, integration and Playwright tests.
- `docs/` — project documentation.

## Documentation

- [Architecture](docs/2.architecture.md) — the Phase 1 serving core: runtime shape, manifest, data
  layout, PMTiles reader, HTTP contract, security, tests and limitations.
- [Dev harness](docs/3.dev-harness.md) — the offline Vite and MapLibre harness, vendored basemap,
  ports and browser smoke test.
- [Documentation index](docs/README.md) — reading order and planned pages.

## Licence

OpenStreetMap-derived data is available under the Open Database Licence (ODbL). See the
[OpenStreetMap copyright page](https://www.openstreetmap.org/copyright) for attribution
requirements.

The vendored development basemap carries its third-party notices and licence texts under
[`dev/basemap/NOTICE`](dev/basemap/NOTICE).
