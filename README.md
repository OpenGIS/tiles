# OpenGIS tiles

Small, API-only tile server for OpenStreetMap-derived outdoor layers, with on-demand terrain contours.

> [!NOTE]
> This is the v2 rewrite. The v1 tile server remains archived.

## Status

Phases 1–4 are implemented: a PMTiles serving core, a local Vite and MapLibre harness, on-demand
contours, and the local build pipeline. The server serves `pois`, `routes` and `paths` from PMTiles
archives and generates `contours` from a worldwide elevation model. `bin/ogis.mjs build` turns an OSM
PBF into verified, content-addressed archives for the three PMTiles sources, in fixture or planet
mode.

Provisioning (Phase 5), the production planet run (Phase 6) and hardening (Phase 7) remain pending.
The server is API-only; the harness is a development tool, not a production frontend.

## Quick start

Requires Node.js 24 and npm. Contour tiles also need outbound HTTPS access to the configured DEM
provider.

```sh
npm install
npm start
```

`npm start` loads `.env` when present and listens on the host and port from `config/layers.json`,
by default `127.0.0.1:11010`. Then:

```sh
curl -s http://127.0.0.1:11010/health
curl -s http://127.0.0.1:11010/contours.json
```

To preview the map, run `npm run dev`. It starts the tile server on `127.0.0.1:11010` and the Vite
harness on `127.0.0.1:11011`; open <http://127.0.0.1:11011>. The harness serves a vendored
Canmore–Banff basemap and a four-source panel for `pois`, `routes`, `paths` and `contours`. See
[docs/3.dev-harness.md](docs/3.dev-harness.md) for provenance, ports and the browser test.

> [!WARNING]
> **Archives are not committed.** A fresh checkout starts, but the three PMTiles sources are
> unavailable: `/health` reports `degraded` with `available: false` for `pois`, `routes` and `paths`,
> `/sources` shows the same, and `/ready` returns 503 listing those sources. `contours` is available
> immediately and needs no archive; its tile requests depend on the configured DEM provider.
> Supplying only `data/pois/current.pmtiles` makes `pois` available; `routes` and `paths` remain
> missing.

## Build pipeline

`bin/ogis.mjs build` (also `npm run build:tiles`) builds the `pois`, `routes` and `paths` archives
from an OSM PBF. Fixture mode is the local and test path; planet mode uses a pinned planet PBF, date
and SHA-256.

```sh
npm run build:tiles -- --fixture=test/fixtures/alberta-canmore.osm.pbf
npm run build:tiles -- --fixture=test/fixtures/alberta-canmore.osm.pbf --only=paths --install
```

Output is `dist/<buildId>/<source>/current.pmtiles` plus `build.json`; build IDs are
content-addressed (`fixture-<12 hex>` or `<YYYYMMDD>-<12 hex>`). `--install` promotes an archive to
`data/<source>/`, rotating the valid current pair to `previous` for rollback. The pipeline validates
the input, applies one shared osmium filter, runs the Planetiler profile, repairs the PMTiles header,
verifies the archive and sample tiles, and writes a per-source manifest. Flags, profiles, verification
rules and the Alberta Canmore fixture are in [docs/5.pipelines.md](docs/5.pipelines.md).

### Remote builds

`--remote` builds on a disposable Hetzner Cloud box and transfers each pair to the tile server's
`data/incoming/` directory. Use `--dry-run` to inspect the plan; creating a box needs `--yes` because
the box is billable while it exists. The default `cpx62` box has the 640 GB disk a filtered planet
build needs, while the tile server remains a `cx23` that is upgraded manually to `cx33` when its data
disk fills.

- `--keep-build-box` (or `--no-destroy`) leaves the box running after a successful build; delete it
  manually when finished.
- `--no-transfer` builds and keeps the box because the only output would otherwise be destroyed.
- A failure before the build starts destroys the box unless it is kept; a failure during the build
  keeps the box and log for inspection.
- Name-based cleanup only deletes a server labelled exactly `managed-by=ogis-tiles` and
  `role=build-box`.

The preflight checks planet pins or the fixture, that `CONFIG_PATH`/`--fixture`/`--planet-pbf` exist
locally, the destination disk, and the restricted build key before creating anything. `.env*` files
are excluded from the sync at any depth. The local preflight needs rsync; rsync 3.2.3 or newer uses
`--mkpath`, while macOS openrsync falls back to a write probe at the `rrsync` root without
`--mkpath`. Install Homebrew rsync for the per-source probe.

`TILE_DATA_DIR` and `TILE_INCOMING_DIR` must match the provisioned `/opt/ogis-tiles/data` and
`/opt/ogis-tiles/data/incoming` paths because the build key is fixed to that `rrsync` root. Planet
builds use `heapPlanet`, overridable with `PLANET_BUILD_HEAP`; empty values are not forwarded.
`BUILD_DESTINATION_MIN_FREE_BYTES`, `BUILD_BOX_TIMEOUT_MS`, `BUILD_BOX_TRANSFER_TIMEOUT_MS` and
`TILE_APP_DIR` tune the preflight and timeouts. After a multi-source build, promote one source at a
time with `ogis promote --source=<name>`.

## Configuration

`config/layers.json` is the single source of truth for the server and every source. Set
`CONFIG_PATH` to load a different manifest. Relative `archiveDir` values resolve against the
repository root, not the manifest's directory; an absolute path is trusted.

The shipped manifest defines four sources: `pois`, `routes` and `paths` as PMTiles sources, and
`contours` as a contour source. The excerpt below is abridged, showing `contours` and a subset of its
thresholds. The full shipped configuration is in [`config/layers.json`](config/layers.json) and is
documented in [docs/4.contours.md](docs/4.contours.md#configuration).

```json
{
  "version": 1,
  "server": { "host": "127.0.0.1", "port": 11010 },
  "sources": {
    "contours": {
      "kind": "contour",
      "title": "Terrain contours",
      "description": "Contour lines generated on demand from a worldwide elevation model.",
      "attribution": [{ "title": "Mapterhorn", "href": "https://mapterhorn.com/attribution" }],
      "minzoom": 1,
      "maxzoom": 15,
      "demUrl": "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp",
      "encoding": "terrarium",
      "demMaxzoom": 12,
      "cacheMaxAge": 86400,
      "thresholds": { "8": [150, 750], "12": [20, 100] }
    }
  }
}
```

The validator rejects unknown keys, unsupported source kinds, invalid source names, bad zoom ranges,
mixing PMTiles and contour fields, non-http(s) attribution links and relative paths that escape the
repository root. `HOST`, `PORT` and `PUBLIC_BASE_URL` override the manifest; `CONFIG_PATH` selects a
different manifest. Forwarded headers are ignored unless `server.trustProxy` is `true`; a configured
`publicBaseUrl` always wins. Full rules:
[docs/2.architecture.md](docs/2.architecture.md#manifest).

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
return 405; invalid coordinates, invalid build IDs and tile query strings return 400. `/health`
always returns 200 and reports `degraded`; `/ready` returns 503 while a local source is unavailable
and never probes the DEM provider.

Tiles are `application/x-protobuf`; empty tiles return 204. Gzip-stored tiles are returned as stored
when accepted, otherwise decompressed to identity. ETags include the build ID and coordinates and end
in `-gzip`, `-identity` or `-empty`; a matching `If-None-Match` returns 304. Versioned URLs are
immutable and PMTiles-only; unversioned PMTiles tiles and TileJSON use a short TTL; health and errors
are `no-store`. Full contract:
[docs/2.architecture.md](docs/2.architecture.md#http-contract).

## Contours

Contours are generated per request, not stored. The server fetches a 3×3 neighbourhood of WebP DEM
tiles from Mapterhorn, decodes them with `sharp`, derives isolines with `maplibre-contour`, and
returns a gzipped MVT in the `contours` layer with `ele` (metres) and `level` (0 minor, 1 major)
properties.

- Contour tiles exist only at the unversioned URL `/contours/{z}/{x}/{y}.pbf`; a versioned contour
  URL returns 404.
- The ETag uses a configuration-derived build ID, so changing the DEM URL, encoding, zoom range or
  thresholds changes every ETag.
- Contour responses use `Cache-Control: public, max-age=86400` from `cacheMaxAge`; unlike versioned
  PMTiles tiles they are not immutable.
- Missing DEM coverage (a 204, 404 or 410 from any neighbour) makes the whole tile empty (204). The
  server does not fill gaps with 0 m.
- A rate limit, server error or timeout returns 503 `upstream_unavailable` with `Retry-After`. A WebP
  decode failure returns 500. CORS exposes `Retry-After` to browser clients.
- Requests outside zoom 1–15 return 204 without contacting the provider.

Details, including the threshold table and failure mapping:
[docs/4.contours.md](docs/4.contours.md).

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
the swap: it writes the new pair, rotates a valid current pair to `previous`, and restores the old
files if any step fails.

## Testing

```sh
npm test
npm run test:build
npm run test:e2e
npm run format:check
```

Unit and integration tests use Vitest. `npm run test:build` is the end-to-end build suite: it builds
all three sources from `test/fixtures/alberta-canmore.osm.pbf` into `tmp/build` and checks archives,
manifests and sample tiles. It needs Java 21+, osmium and the pmtiles CLI. `npm test` covers unit and
integration tests, including the build modules with injected command and fetch implementations, and
excludes the end-to-end build suite.

Fixtures live in `test/fixtures/`: a small POI archive with recorded SHA-256 and provenance, a
committed 3×3 Canmore DEM block with per-tile checksums, and the Alberta Canmore build fixture (bbox
`-115.65,50.95,-115.05,51.35`). Tests bind ephemeral ports and use the gitignored `tmp/` directory
for temporary archives.

`npm run test:e2e` runs the Playwright smoke test against a fixture manifest whose PMTiles archives
are absent: three sources are unavailable and contours use the local DEM fixture. Playwright uses
ports `11012` and `11013`, reusing existing servers outside CI. It checks the rendered map, the
four-source panel and attribution, asserts a real contour tile, and rejects console errors, page
errors, failed responses and external requests.

## Documentation

- [Architecture](docs/2.architecture.md) — runtime shape, manifest, data layout, build pipeline
  relationship, PMTiles reader, contour source, HTTP contract, security and limitations.
- [Dev harness](docs/3.dev-harness.md) — the offline Vite and MapLibre harness, vendored basemap,
  contour fixture, ports and browser smoke test.
- [Contours](docs/4.contours.md) — generation flow, configuration, thresholds, caching, failure
  semantics and attribution.
- [Build pipelines](docs/5.pipelines.md) — the `ogis build` command, stages, profiles, filter union,
  output layout, install and rollback, verification and the Canmore fixture.
- [Documentation index](docs/README.md) — reading order and planned pages.

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
