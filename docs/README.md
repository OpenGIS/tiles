---
git_hash: d3dc393
modified: 2026-11-01
---

# Documentation

Developer-focused documentation for the OpenGIS tiles codebase. The docs use a numbered series;
pages are added as their phases land.

## Reading order

1. [2. Architecture](2.architecture.md) — the serving core and deployment topology: runtime shape,
   manifest, data layout, build pipeline relationship, provisioning, nginx, edge protection,
   systemd, promotion, PMTiles reader, contour source, HTTP contract, security, tests and current
   limitations.
2. [3. Dev harness](3.dev-harness.md) — the offline Vite and MapLibre harness, vendored basemap,
   contour fixture, ports and browser smoke test.
3. [4. Contours](4.contours.md) — on-demand contour generation, configuration, thresholds, caching,
   failure semantics and attribution.
4. [5. Build pipelines](5.pipelines.md) — the `ogis build` command, stages, planet pinning (SHA-256
   and MD5), profiles, filter union, output and build IDs, install and rollback, remote builds,
   verification and the Canmore fixture.
5. [6. Operations](6.operations.md) — status, deploy, promote and rollback, planet pin requirements,
   remote build lifecycle, restarts and readiness, edge limits and access logs, capacity, TLS and
   cache, credentials and incident runbook.
6. [7. Roadmap](7.roadmap.md) — Phases 1–6 complete, Phase 7 in progress with edge protection
   implemented, and the remaining deferrals.

## Planned pages

Planned, not yet written:

- `0.terminology.md` — terms.
- `1.philosophy.md` — why.

## Quick links

- [Main README](../README.md)
- [Manifest](../config/layers.json)
- [HTTP application](../src/app.mjs)
- [PMTiles reader](../src/lib/pmtiles.mjs)
- [PMTiles adapter](../src/sources/pmtiles.mjs)
- [Contour source](../src/sources/contour.mjs)
- [DEM decoder](../src/lib/dem.mjs)
- [Build command](../bin/ogis.mjs)
- [Build profiles](../build/profiles/)
- [Provisioning and cloud-init](../src/provision/cloud-init.mjs)
- [Deploy](../src/deploy/deploy.mjs)
- [Nginx renderer and edge limits](../src/deploy/render.mjs)
- [Promote and rollback](../src/deploy/promote.mjs)
- [Status](../src/deploy/status.mjs)
- [Remote build](../src/build/remote.mjs)
- [DEM fixture](../test/fixtures/dem/manifest.json)
- [Build fixture](../test/fixtures/alberta-canmore.osm.pbf)
- [Harness](../dev/index.html)
- [Tests](../test/)
