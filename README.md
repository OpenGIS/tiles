# OpenGIS tiles

Small, API-only tile server for OpenStreetMap-derived outdoor layers, with on-demand terrain contours.

> [!NOTE]
> This is the v2 rewrite. The v1 tile server remains archived.

## Status

Phases 1–6 are complete and Phase 7 is in progress. The PMTiles serving core, Vite and MapLibre
harness, on-demand contours, local and remote build pipelines, Phase 5 operations and the Phase 6
production planet run are complete, and the Phase 7 edge-protection slice is deployed.

The live service at <https://tile.ogis.app> runs on a Hetzner CX23 in `nbg1` with Ubuntu 26.04,
systemd (`ogis-tiles.service`) and nginx with TLS from certbot. Data lives under
`/opt/ogis-tiles/data`. It serves planet archives for `pois`, `routes` and `paths` built from the
pinned 2026-10-26 OpenStreetMap snapshot, plus on-demand `contours`. `config/layers.json` pins the
dated snapshot URL, date, SHA-256 and MD5. The archives were built on a disposable CPX62 build box,
transferred to the live server, verified against their build manifests and promoted one source at a
time; the previous pairs remain available for rollback.

Phase 7 is in progress: per-IP edge protection and access logging are deployed; monitoring, scheduled
refreshes, authentication and the other hardening items remain. The server is API-only; the harness is
a development tool, not a production frontend.

## Operations

The live service is operated from a checkout with a filled `.env`. The CLI (`node bin/ogis.mjs`)
provides `status`, `deploy`, `promote --source=<name>` and `rollback --source=<name>`; `provision`
rebuilds the server from cloud-init. nginx applies per-IP limits to tile routes and writes a per-host
access log. Excess requests receive `429` with `Retry-After: 1`, distinct from the application's `503`
responses. See [docs/6.operations.md](docs/6.operations.md) for the runbook, edge limits, logs and
incident checklist.

## Quick start

Requires Node.js 24 and npm. Contour tiles also need outbound HTTPS access to the configured DEM
provider.

```sh
npm install
npm start
```

`npm start` loads `.env` when present and listens on the host and port from `config/layers.json`, by
default `127.0.0.1:11010`. Then:

```sh
curl -s http://127.0.0.1:11010/health
curl -s http://127.0.0.1:11010/contours.json
```

To preview the map, run `npm run dev`. It starts the tile server on `127.0.0.1:11010` and the Vite
harness on `127.0.0.1:11011`; open <http://127.0.0.1:11011>. The harness serves a vendored
Canmore–Banff basemap and a panel for `pois`, `routes`, `paths` and `contours`. See
[docs/3.dev-harness.md](docs/3.dev-harness.md) for provenance, ports and the browser test.

> [!WARNING]
> **Archives are not committed.** A fresh checkout starts, but the three PMTiles sources are
> unavailable: `/health` reports `degraded` with `available: false` for `pois`, `routes` and `paths`,
> `/sources` shows the same, and `/ready` returns 503 listing those sources. `contours` is available
> immediately and needs no archive; its tile requests depend on the configured DEM provider.
> Supplying only `data/pois/current.pmtiles` makes `pois` available; `routes` and `paths` remain
> missing.

## Endpoints

| Method | Path                                  | Description                                  |
| ------ | ------------------------------------- | -------------------------------------------- |
| `GET`  | `/`                                   | Service index.                               |
| `GET`  | `/health`                             | Availability of every source.                |
| `GET`  | `/ready`                              | Readiness; 503 while a local source is down. |
| `GET`  | `/sources`                            | Source catalogue.                            |
| `GET`  | `/<source>.json`                      | TileJSON 3.0.0.                              |
| `GET`  | `/<source>/<z>/<x>/<y>.pbf`           | Current PMTiles or contour tile.             |
| `GET`  | `/<source>/<buildId>/<z>/<x>/<y>.pbf` | Versioned PMTiles tile.                      |
| `GET`  | `/contours/<z>/<x>/<y>.pbf`           | On-demand contour tile.                      |

`HEAD` and `OPTIONS` are supported on known routes. Unknown routes return 404; unsupported methods
return 405; invalid coordinates, invalid build IDs and tile query strings return 400. Tile routes
return 429 with `Retry-After: 1` when the per-IP nginx edge limit is exceeded. `/health` always
returns 200 and reports `degraded`; `/ready` returns 503 while a local source is unavailable and never
probes the DEM provider.

Tiles are `application/x-protobuf`; empty tiles return 204. Gzip-stored tiles are returned as stored
when accepted, otherwise decompressed to identity. Versioned URLs are immutable and PMTiles-only;
unversioned PMTiles tiles and TileJSON use a short TTL; health and errors are `no-store`. Full
contract: [docs/2.architecture.md](docs/2.architecture.md#http-contract).

## Build and promote

`node bin/ogis.mjs build` (also `npm run build:tiles`) builds the `pois`, `routes` and `paths` archives
from an OSM PBF. Fixture mode is the local and test path; planet mode requires a dated planet snapshot and
at least one checksum. Pin SHA-256 with `PLANET_SHA256`, `--planet-sha256` or
`build.planet.sha256` (preferred), or MD5 with `PLANET_MD5`, `--planet-md5` or `build.planet.md5`.
Flags win over the environment, which wins over `config/layers.json`. Both are verified when both are
supplied.

```sh
npm run build:tiles -- --fixture=test/fixtures/alberta-canmore.osm.pbf
npm run build:tiles -- --fixture=test/fixtures/alberta-canmore.osm.pbf --only=paths --install
```

Output is `dist/<buildId>/<source>/current.pmtiles` plus `build.json`; build IDs are content-addressed
(`fixture-<12 hex>` or `<YYYYMMDD>-<12 hex>`). `--install` promotes an archive to `data/<source>/`,
rotating the valid current pair to `previous` for rollback. The pipeline validates the input, applies
one shared osmium filter, runs the Planetiler profile, repairs the PMTiles header, verifies the archive
and sample tiles, and writes a per-source manifest. Flags, profiles, verification rules and the
Alberta Canmore fixture are in [docs/5.pipelines.md](docs/5.pipelines.md).

`--remote` builds on a disposable Hetzner Cloud box and transfers each archive pair to the tile
server's `data/incoming/` directory. It never promotes: run
`node bin/ogis.mjs promote --source=<name>` one source at a time afterwards. Use `--dry-run` to inspect
the plan; creating a box needs `--yes` because the box is billable while it exists. The default
`cpx62` box has the disk a filtered planet build needs, while the tile server remains a `cx23` that is
upgraded manually to `cx33` when its data disk fills. Full lifecycle, failure handling and transfer
flags are in [docs/5.pipelines.md#remote-builds](docs/5.pipelines.md#remote-builds) and
[docs/6.operations.md#remote-builds](docs/6.operations.md#remote-builds).

## Configuration

`config/layers.json` is the single source of truth for the server and every source. It defines four
sources: `pois`, `routes` and `paths` as PMTiles sources, and `contours` as a contour source. Set
`CONFIG_PATH` to load a different manifest. Relative `archiveDir` values resolve against the
repository root, not the manifest's directory; an absolute path is trusted.

The validator rejects unknown keys, unsupported source kinds, invalid source names, bad zoom ranges,
mixing PMTiles and contour fields, non-http(s) attribution links and relative paths that escape the
repository root. `HOST`, `PORT` and `PUBLIC_BASE_URL` override the manifest; `CONFIG_PATH` selects a
different manifest. Forwarded headers are ignored unless `server.trustProxy` is `true`; a configured
`publicBaseUrl` always wins. Full rules:
[docs/2.architecture.md#manifest](docs/2.architecture.md#manifest). The shipped contour configuration
is documented in [docs/4.contours.md#configuration](docs/4.contours.md#configuration).

## Data layout

PMTiles sources each have their own directory:

```text
data/pois/
├── current.pmtiles
├── current.json
├── previous.pmtiles
└── previous.json
```

- `current.pmtiles` is required and served by unversioned tile URLs.
- `previous.pmtiles` is the optional rollback archive, served only by its versioned URL.
- `current.json` and `previous.json` are optional sidecars. The build pipeline writes full build
  manifests there; the server reads only `buildId`. Without them the build IDs default to `current`
  and `previous`.
- A missing or unreadable current archive marks the source unavailable. A missing previous archive
  only removes the rollback URL.
- Archives are opened at startup, so replacing one requires a restart.

Contour sources have no `data/` directory and no archive. `--install` in the build pipeline performs
the swap locally: it writes the new pair, rotates a valid current pair to `previous`, and restores the
old files if any step fails. On the live server, `node bin/ogis.mjs promote --source=<name>` installs a
validated pair from `data/incoming/`, and `node bin/ogis.mjs rollback --source=<name>` swaps the
installed current and previous pairs. Both restart the service and wait for readiness before reporting
success.

## Testing

```sh
npm test
npm run test:build
npm run test:e2e
npm run format:check
```

Unit and integration tests use Vitest. `npm run test:build` is the end-to-end build suite: it builds
all three sources from `test/fixtures/alberta-canmore.osm.pbf` into `tmp/build` and checks archives,
manifests and sample tiles. It needs Java 21+, osmium and the pmtiles CLI. `npm test` excludes the
end-to-end build suite and covers the build modules with injected command and fetch implementations.

Fixtures live in `test/fixtures/`: a small POI archive with recorded SHA-256 and provenance, a
committed 3×3 Canmore DEM block with per-tile checksums, and the Alberta Canmore build fixture (bbox
`-115.65,50.95,-115.05,51.35`). Unit and integration tests bind ephemeral ports; temporary archives go
under the gitignored `tmp/` directory.

`npm run test:e2e` runs the Playwright smoke test against a fixture manifest whose PMTiles archives are
absent: three sources are unavailable and contours use the local DEM fixture. It checks the rendered
map, the source panel and attribution, asserts a real contour tile, and rejects console errors, page
errors, failed responses and external requests.

## Documentation

Start with [0. Terminology](docs/0.terminology.md) and [1. Philosophy](docs/1.philosophy.md), then
follow the [documentation index](docs/README.md) through architecture, harness, contours, pipelines
and operations to the roadmap. [TODOS.md](TODOS.md) is the authoritative deferred-work backlog.

| Page                                      | Answers                                                  |
| ----------------------------------------- | -------------------------------------------------------- |
| [0. Terminology](docs/0.terminology.md)   | What does this term mean?                                |
| [1. Philosophy](docs/1.philosophy.md)     | Why is the system shaped this way?                       |
| [2. Architecture](docs/2.architecture.md) | How does serving work, and what is the HTTP contract?    |
| [3. Dev harness](docs/3.dev-harness.md)   | How do I preview the map locally?                        |
| [4. Contours](docs/4.contours.md)         | How are contour tiles generated?                         |
| [5. Pipelines](docs/5.pipelines.md)       | How are archives built and verified?                     |
| [6. Operations](docs/6.operations.md)     | How do I deploy, promote, roll back and run the service? |
| [7. Roadmap](docs/7.roadmap.md)           | What is complete, in progress and deferred?              |
| [Documentation index](docs/README.md)     | Where do I start reading?                                |
| [Deferred work](TODOS.md)                 | What is the detailed backlog?                            |

## Data and licences

There is no root `LICENSE` or `NOTICE` file, and the code licence is not yet decided. Third-party
runtime components and their licences are recorded in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

OpenStreetMap-derived data is available under the Open Database Licence (ODbL). See the
[OpenStreetMap copyright page](https://www.openstreetmap.org/copyright) for attribution
requirements. Mapterhorn DEM attribution is required wherever contour tiles are displayed; see the
[Mapterhorn attribution page](https://mapterhorn.com/attribution).

The vendored development basemap carries its third-party notices and licence texts under
[`dev/basemap/NOTICE`](dev/basemap/NOTICE).
