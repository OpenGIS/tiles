# OpenGIS tiles

Small, API-only tile server for OpenStreetMap-derived outdoor layers.

> [!NOTE]
> This is the v2 rewrite. The v1 tile server remains archived.

## Status

Phase 0 scaffold. The serving API, development harness and build pipelines are under construction.

## Requirements

- Node.js 24
- npm

## Quick start

```sh
npm install
npm test
PORT=11004 npm run dev
```

In another terminal:

```sh
curl http://127.0.0.1:11004/health
```

Choose a free port in the 11001–11999 range; check with
`lsof -nP -iTCP:<port> -sTCP:LISTEN` before starting. Never stop an existing server to free a port.

## Layout

- `src/` — server source.
- `test/` — automated tests.
- `docs/` — project documentation.

## Documentation

See [docs/README.md](docs/README.md).

## Licence

OpenStreetMap-derived data is available under the Open Database Licence (ODbL). See the
[OpenStreetMap copyright page](https://www.openstreetmap.org/copyright) for attribution
requirements.
