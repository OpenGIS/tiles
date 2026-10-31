# Repository conventions

Read [README.md](README.md) and [docs/README.md](docs/README.md) first.

## Stack

- Node.js 24, ESM and plain JavaScript.
- Runtime dependencies are `maplibre-contour` for contour generation and `sharp` for WebP DEM
  decoding. PMTiles archives are read with the in-repo reader.
- Builds use Planetiler 0.10.2 (pinned), Java 21+, osmium and the pmtiles CLI (pinned at 1.31.2 for
  planet builds).
- Use British English in code, comments, tests and documentation.
- Prefer Node built-ins in the serving path. Do not add a web framework.

## Configuration

Layer configuration lives in `config/layers.json` and is validated at startup. The shipped manifest
defines four sources: `pois`, `routes` and `paths` as `pmtiles` sources, and `contours` as an
on-demand `contour` source. Unknown keys and mixtures of PMTiles-only and contour-only fields are
rejected.

The same manifest carries `build` blocks for the three `pmtiles` sources. The server accepts and
ignores them; `bin/ogis.mjs build` validates them strictly. A contour source must not declare a build
profile.

## Build pipeline

- `npm run build:tiles -- --help` lists the flags; `node bin/ogis.mjs build ...` is the same command.
- Build all three sources from the committed fixture:
  `npm run build:tiles -- --fixture=test/fixtures/alberta-canmore.osm.pbf`.
- Output is `dist/<buildId>/<source>/current.pmtiles` plus `build.json`. `--install` promotes to
  `data/<source>/` and rotates the current pair to `previous` for rollback.
- Use `--only` for one source, `--output-dir` for scratch output, and `--skip-verify` only with a
  deliberate override of the install guard.
- Planet mode requires a date and SHA-256 from flags, environment or `config/layers.json`; the
  shipped planet values are placeholders until Phase 6. Fixture builds warn about a mismatched dev
  pmtiles CLI; planet builds require the pinned `1.31.2`.
- Full stages, profiles, flags and verification rules: [docs/5.pipelines.md](docs/5.pipelines.md).

## Testing

- Tests use Vitest for unit and integration coverage, and Playwright for the browser smoke test.
- `npm test` runs unit and integration tests and excludes `test/build/`. Build modules are covered
  with injected command and fetch implementations, so this suite needs no external toolchain.
- `npm run test:build` runs the end-to-end build suite from `test/fixtures/alberta-canmore.osm.pbf`
  into `tmp/build`. It needs Java 21+, osmium and the pmtiles CLI, and downloads the pinned
  Planetiler jar on first use.
- `npm run test:e2e` runs Playwright. Contour unit and integration tests use the committed DEM
  fixture under `test/fixtures/dem/` through a local test server; they must not call Mapterhorn.
- Playwright starts its own tile server and Vite instance unless servers are already listening on the
  configured ports; CI never reuses them.
- Run `npm test`, `npm run test:e2e` and `npm run format:check` before declaring a change complete.
  Add `npm run test:build` when changing the build pipeline, a profile or a build configuration.

## Fixtures

- `test/fixtures/pois.pmtiles` — small POI archive with recorded SHA-256, provenance and ODbL licence.
- `test/fixtures/dem/` — committed 3×3 zoom 12 Mapterhorn DEM block with per-tile checksums.
- `test/fixtures/alberta-canmore.osm.pbf` — build fixture for the POI, routes and paths profiles,
  bbox `-115.65,50.95,-115.05,51.35`, with provenance in `alberta-canmore.manifest.json`.
- Build output and temporary files go under the gitignored `tmp/` directory.

## Development harness

- `npm run dev` starts the tile server and the Vite harness together.
- `npm run dev:server` starts only the tile server on `127.0.0.1:11010`.
- `npm run dev:harness` starts only Vite on `127.0.0.1:11011`.
- The harness exposes `pois`, `routes`, `paths` and `contours`. The PMTiles sources need archives
  under `data/`; contours follow the active manifest's `demUrl`. The Playwright fixture uses the
  committed DEM block served by the Vite `/dem` plugin.

## Ports

| Service                 | Address           |
| ----------------------- | ----------------- |
| Tile server             | `127.0.0.1:11010` |
| Vite harness            | `127.0.0.1:11011` |
| Playwright tile server  | `127.0.0.1:11012` |
| Playwright Vite harness | `127.0.0.1:11013` |

Do not bind ports `5174` or `11000`. For any other service, choose a free port in the 11001–11999
range and check it with `lsof -nP -iTCP:<port> -sTCP:LISTEN` before starting. Never stop or kill a
process you did not start.

## Temporary artefacts

Do not commit temporary artefacts. Use the gitignored `tmp/` directory in the project root.

## Project files

Do not write names or operational context into project files.

## Git

Do not run git write commands. The repository owner stages and commits manually.

## Verification

Run `npm test`, `npm run test:e2e` and `npm run format:check`. Add `npm run test:build` for changes
to the build pipeline, profiles or build configuration.
