---
git_hash: uncommitted
modified: 2026-10-30
---

# Documentation

Developer-focused documentation for the OpenGIS tiles codebase. The docs use a numbered series;
pages are added as their phases land.

## Reading order

1. [2. Architecture](2.architecture.md) — the serving core: runtime shape, manifest, data layout,
   PMTiles reader, contour source, HTTP contract, security, tests and current limitations.
2. [3. Dev harness](3.dev-harness.md) — the offline Vite and MapLibre harness, vendored basemap,
   contour fixture, ports and browser smoke test.
3. [4. Contours](4.contours.md) — on-demand contour generation, configuration, thresholds, caching,
   failure semantics and attribution.

## Planned pages

Planned, not yet written:

- `0.terminology.md` — terms.
- `1.philosophy.md` — why.
- `5.provisioning.md` — provisioning and deployment.
- `6.operations.md` — day-to-day operation.
- `7.roadmap.md` — deferred work.

## Quick links

- [Main README](../README.md)
- [Manifest](../config/layers.json)
- [HTTP application](../src/app.mjs)
- [PMTiles reader](../src/lib/pmtiles.mjs)
- [PMTiles adapter](../src/sources/pmtiles.mjs)
- [Contour source](../src/sources/contour.mjs)
- [DEM decoder](../src/lib/dem.mjs)
- [DEM fixture](../test/fixtures/dem/manifest.json)
- [Harness](../dev/index.html)
- [Tests](../test/)
