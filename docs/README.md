---
git_hash: uncommitted
modified: 2026-10-30
---

# Documentation

Developer-focused documentation for the OpenGIS tiles codebase. The docs use a numbered series;
pages are added as their phases land.

## Reading order

1. [2. Architecture](2.architecture.md) — the Phase 1 serving core: runtime shape, manifest, data
   layout, PMTiles reader, HTTP contract, security, tests and current limitations.
2. [3. Dev harness](3.dev-harness.md) — the offline Vite and MapLibre harness, vendored basemap,
   ports and browser smoke test.

## Planned pages

- [0. Terminology](0.terminology.md) — terms.
- [1. Philosophy](1.philosophy.md) — why.
- [4. Pipelines](4.pipelines.md) — OSM build pipelines.
- [5. Provisioning](5.provisioning.md) — provisioning and deployment.
- [6. Operations](6.operations.md) — day-to-day operation.
- [7. Roadmap](7.roadmap.md) — deferred work.

## Quick links

- [Main README](../README.md)
- [Manifest](../config/layers.json)
- [HTTP application](../src/app.mjs)
- [PMTiles reader](../src/lib/pmtiles.mjs)
- [Source adapter](../src/sources/pmtiles.mjs)
- [Harness](../dev/index.html)
- [Tests](../test/)
