---
git_hash: 968c0e8
modified: 2026-11-01
---

# Documentation

Developer-focused documentation for the OpenGIS tiles codebase. The numbered pages form a path: each
one builds on the last, and every numbered page ends with previous/next navigation.

**Start here:** [0. Terminology](0.terminology.md) → [1. Philosophy](1.philosophy.md) →
[2. Architecture](2.architecture.md). For the detailed deferred-work backlog, go to
[TODOS](../TODOS.md).

## Reading order

0. [Terminology](0.terminology.md) — the vocabulary used in the code and docs, grouped by lifecycle.
1. [Philosophy](1.philosophy.md) — the design choices behind the API, archives, pins and operations.
2. [Architecture](2.architecture.md) — runtime shape, manifest, data layout, deployment topology, edge
   protection, HTTP contract, security and limitations.
3. [Dev harness](3.dev-harness.md) — the offline Vite and MapLibre preview, vendored basemap, contour
   fixture, ports and browser smoke test.
4. [Contours](4.contours.md) — on-demand generation, configuration, thresholds, caching, failure
   semantics and attribution.
5. [Build pipelines](5.pipelines.md) — the `ogis build` command, stages, planet pinning (SHA-256 and
   MD5), profiles, filter union, output and build IDs, install and rollback, remote builds,
   verification and the Canmore fixture.
6. [Operations](6.operations.md) — status, deploy, promote and rollback, planet pin requirements,
   remote build lifecycle, restarts and readiness, edge limits and access logs, capacity, TLS and
   cache, credentials and incident runbook.
7. [Roadmap](7.roadmap.md) — phase history, Phase 7 status and the completed edge-protection slice;
   detailed deferrals live in [TODOS](../TODOS.md).

## How the pages fit together

- **0–1 are orientation.** They give you the language and the reasoning before the implementation
  details.
- **2–4 are the runtime.** Architecture follows a request through the serving core; the dev harness
  shows the local preview; contours explains the one source that is generated rather than archived.
- **5–7 are delivery and operation.** Pipelines builds the archives, Operations runs the service, and
  Roadmap records what is complete and what is deferred.

If you are new, read 0–2 in order. If you are changing a build profile or a deployment step, jump to 5
or 6 and use the links back to 2 and 4.

## Deferred work

[7. Roadmap](7.roadmap.md) records phase history and status. [TODOS.md](../TODOS.md) is the
authoritative, detailed backlog: it records the current state, options, recommendation, prerequisites
and verification for each deferred item.

## Quick links

**Serving:** [HTTP application](../src/app.mjs), [PMTiles reader](../src/lib/pmtiles.mjs), [PMTiles
adapter](../src/sources/pmtiles.mjs), [contour source](../src/sources/contour.mjs), [DEM
decoder](../src/lib/dem.mjs).

**Build:** [CLI](../bin/ogis.mjs), [build profiles](../build/profiles/), [remote
build](../src/build/remote.mjs).

**Deploy:** [provisioning](../src/provision/cloud-init.mjs), [deploy](../src/deploy/deploy.mjs),
[nginx and edge limits](../src/deploy/render.mjs), [promote and
rollback](../src/deploy/promote.mjs), [status](../src/deploy/status.mjs).

**Data and tests:** [manifest](../config/layers.json), [DEM
fixture](../test/fixtures/dem/manifest.json), [build
fixture](../test/fixtures/alberta-canmore.osm.pbf), [harness](../dev/index.html), [tests](../test/).
