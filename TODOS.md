# TODOS

This is the authoritative deferred-work backlog for the OpenGIS tiles project. The
[roadmap](docs/7.roadmap.md) records phase history and the completed Phase 7 edge-protection slice;
the [documentation index](docs/README.md) is the place to start reading. Every pending Phase 7 item
has a section below, with the detail needed to resume it: current state, options, recommendation,
prerequisites and verification. This is a planning and reference document, not a commitment or an
ordered backlog. Commands below use `ogis` as shorthand for `node bin/ogis.mjs`.

## Monitoring and alerting (deferred)

- **Status:** deferred during Phase 7 after the edge-protection work. No external monitoring, paging
  or alert channel is configured.
- **Goal:** detect service outages, degraded readiness, disk pressure and certificate expiry, and
  alert an operator without adding a heavyweight observability stack.
- **What exists today:**
  - `/health` always returns 200 and reports `ok` or `degraded` with per-source availability and
    build IDs.
  - `/ready` returns 200 when every local PMTiles source is available, otherwise 503 with the
    unavailable names.
  - `/sources` is the catalogue; `ogis status` is the manual cloud/SSH/HTTP view.
  - nginx writes a per-host access log using the `ogis` format, including status, `$request_time`,
    `$upstream_response_time` and `$upstream_cache_status`.
  - systemd runs `ogis-tiles.service`; certbot has a renewal timer; Hetzner snapshots and archive
    rollback pairs cover recovery.
  - There is no external uptime check, pager, disk alert, certificate-expiry alert, or 5xx/429 rate
    alert.
  - Current operational detail is in [docs/6.operations.md](docs/6.operations.md), including
    [status and health](docs/6.operations.md#status-and-health),
    [TLS, nginx and logs](docs/6.operations.md#tls-nginx-and-logs) and
    [disk capacity](docs/6.operations.md#disk-capacity).
- **Options considered:**
  1. **Healthchecks.io-compatible dead-man's-switch plus a server-side timer (recommended).** A small
     monitor command runs from a systemd timer, checks the local service, readiness, health body,
     disk and served TLS certificate, then pings a check URL on success or failure. A missed ping
     catches a dead server; a failure ping reports a live but broken server. Provider-agnostic: any
     endpoint supporting success and `/fail` pings works. Requires a check URL and an alert email at
     the provider; the URL is a server-only secret.
  2. **External HTTP monitor only.** An external service checks the public `/ready` URL and emails on
     failure. No server code, but no local disk, certificate, service or health-body checks.
  3. **GitHub Actions scheduled workflow.** A cron workflow curls the public endpoints and opens an
     issue on failure. No new service, but scheduled runs can be delayed and issues would be public
     in this repository.
  4. **Direct SMTP from the server.** No third-party checker, but a server outage can prevent the
     alert and SMTP credentials add operational risk.
- **Recommended design if resumed:**
  - Add an `ogis monitor` command with injectable HTTP/exec/filesystem/clock seams.
  - Check `ogis-tiles.service` is active; probe `/ready` for 200 and `{ "status": "ready" }`; probe
    `/health` for 200 and a non-`degraded` body; check free space on the data filesystem; check the
    served TLS certificate expiry.
  - Run from a systemd timer every five minutes with a short HTTP retry before reporting failure.
  - On success, ping the check URL; on failure, ping its `/fail` endpoint with a short reason. The
    check provider handles email/pager delivery and missed-ping alerts.
  - Suggested defaults: 8 GiB minimum free on the data filesystem, 21 days certificate warning,
    five-minute interval, two readiness attempts.
  - Keep `MONITOR_PING_URL` in a server-only environment file outside the repository; never commit
    it. Deploy installs the timer but monitoring remains disabled until the URL is configured.
  - Verification: unit tests for each check and threshold, deploy render tests for the timer/service,
    a manual success/failure ping against a test check, and a live timer/deploy check.
- **Open questions:**
  - Which provider and alert channel (email, chat webhook or pager)?
  - Whether to alert on 5xx rate, 429 bursts, stale planet builds, or certificate renewal failures in
    the first slice.
  - Whether the public HTTPS path or the loopback path is the primary readiness probe.
- **Non-goals:** full metrics/APM, log aggregation, distributed tracing, multi-server high
  availability.

> [!WARNING]
> `MONITOR_PING_URL` is a server-only secret. Keep it in the server environment file outside the
> repository and never commit it.

## Application authentication and authorisation (deferred)

- **Status:** deferred; not started. There is no authentication, authorisation, account model or
  per-client quota.
- **Why deferred:** the API is public and read-only, serves only public OpenStreetMap-derived layers,
  and has no accounts, private layers or write endpoints. Edge per-IP limits in nginx already cover
  casual abuse. Adding identity would add a credential store, rotation process and failure modes
  without a current use case.
- **Trigger:** a private layer, a paid or partner tier, a write or admin endpoint, per-client quotas
  or SLAs, a requirement to revoke access, or a customer asking for a key they can rotate.
- **Current state:**
  - [`src/app.mjs`](src/app.mjs) dispatches every route directly; there is no middleware chain and no
    token, cookie or signature check. [`src/lib/http.mjs`](src/lib/http.mjs) adds
    `Access-Control-Allow-Origin: *` to every JSON, empty and tile response.
  - `/health`, `/ready`, `/sources`, `/<source>.json` and both tile routes are public. nginx adds
    per-IP rate and connection limits from `EDGE_LIMITS` in
    [`src/deploy/render.mjs`](src/deploy/render.mjs); the Node application has no application-level
    rate limiting, quotas or identity.
  - [`config/layers.json`](config/layers.json) has no account, key or scope fields, and
    [`src/lib/config.mjs`](src/lib/config.mjs) rejects unknown keys. Any manifest-driven auth setting
    is a schema change.
  - `server.trustProxy` only affects derived TileJSON URLs; it does not authenticate a proxy or a
    client.
  - There is no database or session store. `data/` holds PMTiles archives and contour state is
    in-memory, so an identity store would be a new component.
- **Approach options:**
  1. **Edge authentication (recommended for a single private deployment).** Use nginx basic auth,
     mutual TLS, or `auth_request` against an identity provider. It protects selected locations
     without touching the Node request path. It is coarse-grained and does not give per-key quotas
     without extra log processing.
  2. **Application API keys.** Add a check before route dispatch in `src/app.mjs`, with keys in a
     server-only file or environment variable, constant-time comparison and per-source or per-route
     scopes. This fits the read-only API and supports rotation and revocation, but needs issuance
     and storage rules.
  3. **Signed tile URLs.** Sign each tile URL with an HMAC and expiry. This works well behind a CDN
     and for offline clients, but every URL changes, TileJSON must sign URLs, cache keys fragment and
     key rotation is harder.
  4. **Full OIDC and accounts.** Only worth it if the product needs user accounts, saved state or
     private layers; it needs a database, session or token handling and a production frontend.
- **Recommendation:** use edge authentication first when a private deployment is the only
  requirement. Add application-level keys only when per-client scopes, quotas or revocation are
  needed. Do not build accounts before a product requirement exists.
- **Dependencies and prerequisites:** auth settings and validation, server-only secret storage,
  nginx render and deploy changes, a CORS policy decision (the current wildcard is deliberate),
  monitoring for `401`/`403`, and tests for the chosen mechanism. A CDN in front requires trusted
  real-IP handling before per-client limits remain meaningful.
- **Verification:**
  - An unauthenticated request to a protected route returns `401` or `403`, while the intended
    public routes keep their current status codes.
  - A valid credential returns the same body, status, `ETag` and cache headers as today.
  - `OPTIONS` preflight still succeeds for the permitted origin and headers.
  - Credentials never appear in responses, access logs or the journal; rotating a key invalidates the
    old one.
  - nginx still distinguishes clients by address, and `/health` and `/ready` follow the agreed
    public/private policy.
- **Open questions:**
  - Is the goal a private deployment, paid access, per-client quotas, or all three?
  - Which routes are protected: tiles only, or TileJSON and the catalogue as well?
  - Should `/health` and `/ready` stay public for monitoring and load balancers?
  - Who issues and rotates keys, and what is the revocation path?
  - Is edge auth sufficient, or are per-key usage records required?

## Scheduled planet refreshes (deferred)

- **Status:** deferred; builds and promotions are manual.
- **Why deferred:** the dated pin, remote build, transfer, one-source-at-a-time promotion and
  rollback path are deliberately observed by hand before any scheduler is trusted. A bad automatic
  refresh can replace all three live sources and consume a build box budget without an operator
  watching.
- **Trigger:** a regular refresh cadence, stale-data complaints, a second operator, or enough
  confidence in monitoring, backups and rollback to accept unattended builds.
- **Current state:**
  - A planet refresh means new pins in [`config/layers.json`](config/layers.json), a remote build,
    verified transfers into `data/incoming/<source>/`, and `ogis promote --source=<name>` one
    source at a time. The flow is documented in
    [docs/7.roadmap.md](docs/7.roadmap.md#phase-6--complete) and
    [docs/6.operations.md](docs/6.operations.md#remote-builds).
  - `node bin/ogis.mjs build --remote --yes` creates a labelled, billable Hetzner build box, syncs
    the repository, runs the pipeline and transfers each pair. It never promotes. The default box is
    `cpx62` in `nbg1`; the default whole-build timeout is 24 hours and the per-source transfer
    timeout is four hours ([`src/build/remote.mjs`](src/build/remote.mjs)).
  - Remote builds need `HCLOUD_TOKEN`, `TILE_SERVER_HOST`, `SSH_PRIVATE_KEY_PATH` and, unless
    `--no-transfer` is used, `BUILD_SSH_PRIVATE_KEY_PATH` in the local `.env`; the build key is
    restricted to `/opt/ogis-tiles/data/incoming`.
  - Builds are sequential across sources and the planet download is cached locally and reused
    across sources. There is no scheduler, queue, run lock or automatic promotion. The CI workflow
    runs tests only ([`.github/workflows/test.yml`](.github/workflows/test.yml)).
  - A dated snapshot URL is mandatory; `planet-latest` is rejected by the remote preflight. Planet
    build IDs are `<YYYYMMDD>-<12 hex>`, so a refresh changes the advertised ID for every source;
    the three sources still have independent archive hashes.
- **Approach options:**
  1. **Operator-host systemd timer or cron (recommended first).** A small wrapper runs
     `node bin/ogis.mjs build --remote --yes`, verifies each `build.json`, and stops before
     promotion. This reuses the existing CLI, requires an always-on host with the checkout and
     secrets, and needs its own failure alert.
  2. **Scheduled CI workflow.** A GitHub Actions schedule runs the same command with repository
     secrets, giving an audit trail and no dedicated host. Scheduled runs can be delayed, the runner
     must reach the Hetzner API and build box, and the workflow should be separate from the test
     workflow until CI deployment is settled.
  3. **Tile-server timer.** Not recommended: it puts the build toolchain, planet cache and build load
     on the serving host, which has a small disk and a different role.
  4. **External orchestrator or queue.** Adds scheduling, retries and visibility, but is more
     operational surface than a single scheduled command needs now.
- **Recommendation:** automate build and transfer first, with an explicit stop before promotion.
  Keep promotion manual or behind an approval gate until monitoring, backups and rollback have been
  exercised. Promote one source at a time and let each readiness and build-ID check finish before
  starting the next.
- **Dependencies and prerequisites:** monitoring and alerting, a scheduler host or CI with secrets,
  a run lock to prevent overlapping builds, capacity for incoming and rollback pairs (the CX33
  upgrade may be needed), backup and rollback policy, and a cleanup rule for failed or kept build
  boxes. Object storage is not required for a single server.
- **Verification:**
  - A dry run resolves the expected date and pins; a scheduled run produces manifests whose
    `planet.sha256`, date and build IDs match the pins.
  - Each pair arrives in `data/incoming/<source>/` and passes the promotion validation.
  - Promoting one source at a time leaves `/health`, `/ready`, `/sources` and a sample tile correct
    after each restart.
  - A failed run alerts, leaves no orphaned build box, and does not consume or promote a partial
    pair. A rerun is safe and does not overlap a previous run.
  - Rollback to the previous pair still works after the refresh.
- **Open questions:**
  - What cadence is wanted, and which snapshot source is authoritative?
  - Should promotion ever be automatic, or always gated on a human?
  - What is the monthly build-box budget and maximum box type?
  - Who responds to a failed run, and how many previous pairs should be retained?
  - Is a run lock enough, or is a proper queue needed for retries and history?

## Object storage, CDN or shared cache (deferred)

- **Status:** deferred; all archives and caches are local to the single server.
- **Why deferred:** the server is single-node with local disk. A CDN or object store adds cost,
  configuration and another failure domain before traffic, origin egress or multi-server needs
  justify it.
- **Trigger:** origin bandwidth or latency becomes the bottleneck, a second server needs the same
  archives, archives must be shared or backed up off-site, or a CDN is needed for global users.
- **Current state:**
  - PMTiles archives live at `data/<source>/current.pmtiles` and `previous.pmtiles`; the reader and
    source adapter use local file paths ([`src/lib/pmtiles.mjs`](src/lib/pmtiles.mjs),
    [`src/sources/pmtiles.mjs`](src/sources/pmtiles.mjs)). There is no object-storage backend or
    archive downloader.
  - nginx caches each source under `/var/cache/nginx/<source>`. The budget is 20 GB, with 2 GB
    reserved for contours and the remainder split evenly across PMTiles sources
    ([`src/deploy/render.mjs`](src/deploy/render.mjs)). PMTiles TileJSON and tiles are cached for an
    hour; contour responses for a day with a cache lock.
  - Versioned PMTiles URLs are immutable (`public, max-age=31536000, immutable`); current PMTiles
    tiles and TileJSON use `public, max-age=300`; contour tiles use `cacheMaxAge` (86400 by default).
    Health, readiness, catalogue, index and errors are `no-store`.
  - There is no CDN, shared cache tier or cache-purge command. nginx cache is cleared by stopping
    nginx, removing the directory contents and starting it again
    ([docs/6.operations.md](docs/6.operations.md#tls-nginx-and-logs)).
  - Edge limits key on `$binary_remote_addr`. The architecture warns that a CDN or reverse proxy in
    front of nginx needs trusted real-IP handling first, or every client shares one limit bucket
    ([docs/2.architecture.md](docs/2.architecture.md#edge-protection)).
- **Approach options:**
  1. **CDN in front of nginx (recommended first).** Cache immutable versioned tiles at the edge and
     reduce origin traffic. No data-model change. It requires cache rules, real-IP handling, a purge
     path tied to promotion, and a decision about whether TileJSON, current tiles and contours are
     cached at the edge.
  2. **Object storage for archives, with or without a CDN.** Upload archive pairs to S3-compatible
     storage and either sync them to each server or add a reader that fetches byte ranges from the
     object store. This is the natural companion to multi-server and off-site backup, but it changes
     or wraps the PMTiles read path and needs credentials and lifecycle rules.
  3. **Shared cache tier.** A shared nginx/Varnish/Redis-style cache across application nodes. Only
     useful after multi-server; it adds another service and another consistency model.
  4. **Hybrid.** CDN for versioned PMTiles tiles, origin for current tiles, TileJSON and contours,
     with nginx cache retained. Lowest risk and easiest to roll back.
- **Recommendation:** add a CDN first if the problem is origin egress or latency. Choose object
  storage when archives must be shared across nodes or protected off-site. Do not add a shared cache
  tier before multi-server makes it necessary.
- **Dependencies and prerequisites:** monitoring, trusted real-IP configuration, DNS and TLS,
  cache-purge automation tied to promotion, a decision on origin privacy, cost approval, and
  object-storage credentials and lifecycle rules if used. Object storage as a source of truth also
  depends on the backup and multi-server items.
- **Verification:**
  - Cache hit ratio and origin request rate improve, with correct `200`, `204`, `206`, `304` and
    range responses.
  - `ETag`, `Vary: Accept-Encoding` and cache-control headers survive the edge.
  - Promotion or rollback purges or bypasses the old build; no stale build ID is served after the
    documented TTL.
  - Per-client `429` behaviour still works with the real client address.
  - The origin still serves correctly when the CDN is bypassed, and contour traffic follows the
    agreed cache policy.
  - Object-storage reads survive a missing local archive and have bounded retries and timeouts.
- **Open questions:**
  - Which provider and budget are acceptable?
  - Should the origin stay private, or may clients reach nginx directly?
  - Are contours cached at the edge, and for how long?
  - What purges the CDN on promotion, and who owns that automation?
  - Is object storage a mirror, a backup target, or the source of truth?
  - Is multi-region or data-residency a requirement?

## Archive watcher or reload signal (deferred)

- **Status:** deferred; every archive change requires a service restart.
- **Why deferred:** promotion and rollback already restart the service explicitly, and a watcher
  would add a second, less predictable reload path. A restart is simple and its readiness race is
  already handled by promotion's retries.
- **Trigger:** restart downtime becomes material, archive drops become frequent, or promotion needs
  to avoid a full process restart.
- **Current state:**
  - `createPmtilesSource()` opens `current.pmtiles` and `previous.pmtiles` at startup and keeps the
    file handles ([`src/sources/pmtiles.mjs`](src/sources/pmtiles.mjs)). There is no file watcher.
  - [`src/server.mjs`](src/server.mjs) handles `SIGINT` and `SIGTERM` only. Shutdown stops accepting
    connections, waits up to five seconds for in-flight requests, then closes the readers.
  - `node bin/ogis.mjs promote --source=<name>` and `rollback --source=<name>` install the pair,
    restart `ogis-tiles.service`, wait for `/health` and `/sources` (30-second window per check),
    then `/ready` and the advertised build ID. `--install` also requires a restart.
  - Replacing `current.pmtiles` under a running process is not detected. The service is
    `Type=simple` and has no readiness notification, so a manual restart needs the retry loop in
    [docs/6.operations.md](docs/6.operations.md#service-restart-and-readiness).
  - A missing previous archive only removes the rollback URL; a missing or corrupt current archive
    makes the source unavailable but does not stop the process.
- **Approach options:**
  1. **SIGHUP reload (recommended).** Add a handler that builds a new set of sources, swaps them
     atomically and closes the old readers; add `ExecReload` to the systemd unit and let promotion
     use `systemctl reload` with restart as a fallback. It keeps the process and listener alive,
     handles in-flight requests, and can preserve the old readers if the new archive fails to open.
  2. **Filesystem watcher.** Watch `current.pmtiles` and `current.json` with a debounce and perform
     the same atomic swap. Convenient for manual drops, but atomic rename semantics, duplicate
     events and missed events make it harder to test than an explicit signal.
  3. **systemd path unit restart.** Simple and external to the application, but still a restart and
     still subject to the startup race.
  4. **HTTP admin reload endpoint.** Avoid unless the auth item is implemented; it adds a remote
     control surface and another way to fail.
- **Recommendation:** implement SIGHUP plus `systemctl reload` first. Add a watcher only if manual
  archive drops are a real workflow. Keep promotion's build-ID verification and keep restart as the
  fallback if reload fails.
- **Dependencies and prerequisites:** source lifecycle changes in `src/app.mjs` and
  `src/sources/pmtiles.mjs`, a systemd `ExecReload` render change, promotion and rollback changes,
  tests for in-flight requests and failed opens, and monitoring. No new external service is needed.
- **Verification:**
  - Replacing the live pair and sending SIGHUP serves the new build ID and a new tile without a
    connection error; the old versioned URL still serves from `previous`.
  - A missing, corrupt or non-MVT new archive leaves the old readers serving and reports the
    failure.
  - Repeated reloads do not leak file descriptors; in-flight requests finish within the grace
    period; `/ready` returns 200 throughout.
  - Promotion's existing restart and restore path still passes its checks.
- **Open questions:**
  - Is restart downtime material enough to justify an in-process reload?
  - Should promotion use reload by default, or only when explicitly requested?
  - Is a watcher needed for manual archive drops, or is an explicit signal sufficient?
  - Do configuration changes still require a restart even if archives can reload?
  - Does the deployment environment support SIGHUP and `systemctl reload` consistently?

## Pre-generated contour or DEM cache (deferred)

- **Status:** deferred; contours are generated on demand with in-memory caches only.
- **Why deferred:** on-demand generation avoids storing a worldwide contour set, and the current
  nginx cache already absorbs repeat requests for a day. A local cache or pre-generation is only
  worth it if Mapterhorn availability, latency or quota becomes a user-visible problem.
- **Trigger:** upstream outages or rate limits affect users, contour latency is too high, a region
  needs guaranteed offline coverage, or provider quota or terms change.
- **Current state:**
  - [`src/sources/contour.mjs`](src/sources/contour.mjs) fetches the 3×3 DEM neighbourhood, decodes
    WebP with [`src/lib/dem.mjs`](src/lib/dem.mjs), derives isolines with `maplibre-contour` and
    gzips the result. A missing neighbour returns `204`; upstream `429`/`5xx`, timeouts and unusable
    statuses return `503 upstream_unavailable` with `Retry-After`.
  - `LocalDemManager` keeps three bounded in-memory caches — raw DEM, parsed DEM and generated
    contours — each with `cacheSize` entries (100 in the shipped manifest). The cache is per process
    and cleared on close. There is no disk cache and no shared cache
    ([docs/4.contours.md](docs/4.contours.md#caching-etag-and-versioning)).
  - nginx caches contour TileJSON and tiles for 24 hours with a cache lock, within the 2 GB contour
    cache budget. Contour tiles are unversioned; the build ID is a configuration hash used in ETags.
  - Health and readiness are local signals and do not probe Mapterhorn. Construction performs no
    network request, so an upstream outage does not remove the process from readiness.
  - Contours are not part of the build pipeline and there is no pre-generated contour archive.
- **Approach options:**
  1. **Local disk DEM cache (recommended first).** Cache raw WebP tiles keyed by provider, encoding
     and `z/x/y`, with a bounded size and TTL, before decoding. It reduces upstream calls and
     latency and can bridge short outages if the policy allows stale reads. It needs eviction, a
     disk budget and a clear stale-versus-error rule.
  2. **Pre-generated contour PMTiles for a bounded region.** Generate contour tiles into a PMTiles
     archive for a fixed area and zoom range and serve it as a `pmtiles` source, with the same
     promote and rollback model. Good for a popular area or an offline product; a worldwide set is
     too large to build and store casually.
  3. **Shared or edge cache.** Extend the existing nginx cache with a CDN or a shared cache tier.
     This caches generated tiles rather than DEM data and does not remove the first-miss upstream
     dependency.
  4. **Secondary DEM provider or fallback.** A configuration or adapter change, not a cache. Useful
     only if a second provider has compatible encoding, coverage and terms.
- **Recommendation:** start with a bounded local DEM cache if Mapterhorn reliability or latency is
  the trigger. Pre-generate only a bounded region as a separate PMTiles source when users need
  guaranteed coverage. Avoid a worldwide contour archive.
- **Dependencies and prerequisites:** disk capacity (the CX23's 40 GB is shared by data and cache;
  the CX33 upgrade may be needed), monitoring, a cache eviction policy, provider terms that permit
  caching, attribution, and build-pipeline or source changes for pre-generation. Large archives may
  depend on object storage or the CX33 upgrade.
- **Verification:**
  - Cold and warm requests show a measurable reduction in upstream DEM requests, with a bounded
    cache size.
  - Blocking or rate-limiting the upstream still serves cached tiles under the agreed policy, and
    uncached tiles fail with the documented `503` rather than a wrong elevation.
  - Cached and uncached tiles are byte-equivalent for the same input and configuration; eviction and
    TTL behave as specified.
  - `/health` and `/ready` remain local; attribution remains visible; a change to a hashed
    configuration field changes the build ID and ETags.
  - A pre-generated archive passes the normal PMTiles verification and promotion checks.
- **Open questions:**
  - Which region, zoom range and demand justify pre-generation?
  - How stale may a cached DEM tile be, and should stale data be served during an outage?
  - Do Mapterhorn's terms permit persistent caching of raw DEM tiles?
  - What disk budget is acceptable alongside archives and the nginx cache?
  - Is offline coverage a hard requirement or a nice-to-have?
  - Would a second DEM provider be simpler than a cache?

## Automated capacity resize (deferred)

- **Status:** deferred; capacity growth is a manual Hetzner console operation.
- **Why deferred:** a resize costs money and reboots the server, and the current CX23 to CX33 path
  is infrequent enough to keep under human control. Automatic resizing could surprise the operator
  or reboot during traffic.
- **Trigger:** repeated high-water warnings, a failed transfer because the destination floor was not
  met, a planet refresh that needs more headroom, or a predictable growth curve.
- **Current state:**
  - The tile server is a CX23 with a 40 GB disk shared by the operating system, application, `data/`
    and the 20 GB nginx cache. The approved growth path is a manual CX33 upgrade in the Hetzner
    console, taken before the disk fills; take a snapshot first, expect a reboot and retain the
    public address ([docs/6.operations.md](docs/6.operations.md#disk-capacity)).
  - The remote-build preflight requires 8 GiB free on the data filesystem and warns from 70% usage.
    It never resizes anything. The constants and policy text are in
    [`src/build/remote.mjs`](src/build/remote.mjs).
  - `node bin/ogis.mjs provision` rebuilds the existing server type from cloud-init; it verifies the
    type and rejects a type change. It is not a resize command.
  - `node bin/ogis.mjs status` reports cloud and server state, but there is no capacity alert while
    monitoring is deferred.
- **Approach options:**
  1. **Alert-only (recommended).** Monitoring checks `df` on `/opt/ogis-tiles/data` and
     `/var/cache/nginx` and warns at agreed thresholds. The operator follows the manual CX33
     runbook. No reboot or cost surprise.
  2. **Semi-automated resize command.** A command snapshots the server, calls the Hetzner API or CLI
     to change the type or resize the disk, waits for the action, then verifies service and
     capacity. It requires an explicit `--yes`, a maintenance window and a tested rollback.
  3. **Fully automatic resize on threshold.** Not recommended: it can reboot during traffic, incur
     unexpected cost, and may not have the required capacity available.
  4. **Volume expansion or migration.** Attach a Hetzner volume, move `data/` and the nginx cache,
     and update mounts. This is not automated today, needs a migration plan, and does not
     necessarily avoid a reboot.
- **Recommendation:** keep alert-only now. If automation is wanted, add a snapshot-plus-resize
  command with an explicit confirmation and post-resize checks, not a threshold-triggered reboot.
  Keep the build preflight free-space floor.
- **Dependencies and prerequisites:** monitoring alerts, snapshot and backup policy, a cloud token
  with resize permission, a maintenance window, DNS and address retention, cache warm-up or clearing,
  and an updated runbook. `ogis provision` is not the resize path.
- **Verification:**
  - The alert fires before the preflight floor is breached.
  - A dry-run resize plan names the target type, snapshot and reboot; a real run creates the
    snapshot, completes the resize and retains the public address.
  - `df`, `node bin/ogis.mjs status`, `/health`, `/ready`, `/sources` and a sample tile pass after the
    resize; the cache repopulates.
  - A failed or interrupted resize has a documented restore path from the snapshot.
  - The cost change is visible and approved.
- **Open questions:**
  - What is the monthly cost ceiling and the approved target type?
  - Which maintenance window is acceptable for a reboot?
  - Is CX33 enough for the next planning horizon, or is a larger type needed?
  - Should automation stop at snapshot-and-notify, or actually resize?
  - Would a volume be preferable to a larger server, and who would migrate the data?
  - Who approves a resize?

## Automated backups beyond snapshots (deferred)

- **Status:** deferred; recovery relies on provisioning snapshots, the previous archive pair and
  deploy's config backups.
- **Why deferred:** snapshots cover rebuilds, the previous pair covers archive rollback, and
  deploy keeps `.ogis-backup` files when a restore fails. A real backup policy needs a recovery
  point objective (RPO) and recovery time objective (RTO), retention rules, an off-site target and
  a restore drill, none of which exist yet.
- **Trigger:** a recovery-time or recovery-point requirement, a provider or account-loss risk, an
  accidental-deletion incident, compliance, or a rebuild that would take too long.
- **Current state:**
  - `node bin/ogis.mjs provision --yes` creates a Hetzner snapshot before a rebuild unless
    `--no-snapshot` is used. The snapshot is provider-side and tied to the server
    ([`src/provision/provision.mjs`](src/provision/provision.mjs),
    [`src/provision/hcloud.mjs`](src/provision/hcloud.mjs)).
  - Promotion and rollback snapshot the live pair to `data/<source>/.deploy-backup-<uuid>/` and
    restore it on failure ([`src/deploy/promote.mjs`](src/deploy/promote.mjs)). The previous pair is
    the normal rollback copy.
  - Deploy backs up the systemd unit and nginx site as `.ogis-backup` files and restores them on a
    failed install ([`src/deploy/deploy.mjs`](src/deploy/deploy.mjs)).
  - There is no scheduled snapshot, retention policy, off-site copy or automated restore. TLS
    certificates, the nginx site and the systemd unit are server state; certificates can be
    reissued. Archives are reproducible from the pinned planet and the build profiles, but a rebuild
    is expensive. Credentials stay in the local `.env` and are not synced to the server.
  - There is no database to back up.
- **Approach options:**
  1. **Baseline: snapshot plus rebuild (recommended for now).** Document the Hetzner snapshot and
     rebuild-from-pins path, test a restore, and record the expected RTO. Lowest cost, but does not
     protect against provider or account loss.
  2. **Scheduled provider snapshots with retention.** A timer or API job creates snapshots and
     prunes old ones. Easy and provider-native, but still tied to the provider and account.
  3. **Off-site backup.** Use restic, borg or an equivalent to copy `/opt/ogis-tiles/data`
     (archives and manifests), `/etc/letsencrypt`, the nginx site, the systemd unit and any
     server-only config to S3-compatible storage, with encryption and retention. This is the only
     option that survives account loss.
  4. **Config and manifests only.** Back up small state and rebuild archives from pins. Cheapest
     storage, longest RTO; useful as a minimum even if full archives are not copied.
- **Recommendation:** keep the snapshot-plus-rebuild baseline, add scheduled provider snapshots with
  retention, and add off-site restic/borg only if provider or account loss is in scope. Back up the
  build manifests and server configuration even when archives are rebuilt.
- **Dependencies and prerequisites:** object storage (or another off-site target), credentials and
  encryption keys, monitoring for backup failures, a restore target and drill, a retention policy,
  a backup window, and enough capacity to stage a restore. This item overlaps with object storage
  and multi-server.
- **Verification:**
  - A restore into a clean server or snapshot yields the expected build IDs and archive checksums.
  - `/health`, `/ready`, `/sources`, a sample tile and `node bin/ogis.mjs status` pass after restore.
  - TLS, nginx and systemd configuration are restored or reissued correctly.
  - Backup freshness and failure alerts work, an old generation can be pruned, and an encrypted
    backup can be decrypted with the escrowed key.
  - The measured RTO and RPO match the documented target.
- **Open questions:**
  - What RPO and RTO are required, and for which failure modes?
  - Is off-site or cross-account protection required, or is a provider snapshot enough?
  - How many snapshots or backup generations should be retained?
  - Should archives be backed up, or rebuilt from the pinned planet and profiles?
  - Who holds the encryption keys and the restore credentials?
  - Is compliance or a customer contract driving this?

## Multi-server or high availability (deferred)

- **Status:** deferred; the service is a single CX23 with local disk.
- **Why deferred:** one server keeps the data, cache and restart model simple. A load balancer,
  shared or replicated archives, coordinated promotion and split-brain avoidance are a larger design
  change than the current traffic justifies.
- **Trigger:** an uptime or maintenance-window requirement, traffic growth beyond one server, a
  customer SLA, regional latency, or a business need to survive a host failure automatically.
- **Current state:**
  - One CX23 runs nginx, certbot and `ogis-tiles.service`; archives and the nginx cache are local.
    There is no load balancer, shared storage, database or shared cache tier.
  - The API is read-only and sessionless, which helps, but a contour source keeps in-memory caches,
    and every PMTiles source opens local archives at startup.
  - `node bin/ogis.mjs deploy`, `status`, `promote` and `rollback` assume one SSH target and one
    `data/incoming/` directory. Promotion restarts the one service and verifies its build ID.
  - DNS has one A record; certbot runs on the host; edge limits key on the client address at nginx.
  - `/ready` is a local signal: every configured PMTiles source must be available, and contours do
    not affect it.
- **Approach options:**
  1. **Active-passive (recommended first).** A standby server holds the same code, archives and
     configuration; a provider floating IP or DNS failover moves traffic. Promotion and rollback run
     on the active node, then the standby is synced. Simpler than active-active, but still needs
     data replication, a fence against split brain and a tested failover.
  2. **Active-active behind a load balancer.** Both nodes serve; archives must be shared or
     replicated, contour caches are per node, and deploys and promotions must be coordinated.
     Object storage and CI deployment become prerequisites.
  3. **CDN plus single origin.** Improves edge availability and absorbs traffic, but the origin
     remains a single point of failure. It is not HA.
  4. **Multi-region read replicas.** A later step, with data residency, replication lag and
     promotion coordination questions.
- **Recommendation:** use a CDN and backups first. Choose active-passive only when an SLA or
  maintenance requirement justifies it. If active-active is needed later, implement object storage
  and CI deployment first.
- **Dependencies and prerequisites:** object storage or archive replication, backups, monitoring and
  alerting, CI or automated deployment, DNS or floating-IP control, shared configuration and
  secrets, capacity for a second server, and a failover runbook. Promotion and rollback tooling must
  learn about more than one target.
- **Verification:**
  - A controlled failover moves traffic to the standby with correct `/health`, `/ready`, `/sources`
    and sample tiles, and the advertised build IDs match.
  - Promotion on the active node propagates to the standby, or the standby is explicitly fenced
    during the change; there is no split brain.
  - A deploy reaches every node and a failed node is removed from rotation.
  - TLS, DNS TTL, cache warm-up and monitoring behave as documented; the measured RTO matches the
    target.
  - Rolling back to the single-server topology is possible.
- **Open questions:**
  - What SLA, RTO and RPO would justify the cost?
  - Is active-passive enough, or is active-active required?
  - Which provider features are available: floating IP, load balancer, private network?
  - How are archives replicated, and which node is authoritative during promotion?
  - Can contours be regenerated per node, or do they need a shared cache?
  - Who operates a failover, and how often is it drilled?

## CI deployment (deferred)

- **Status:** deferred; CI runs tests, deployment remains a local command.
- **Why deferred:** deploy is a deliberate local action over SSH, rsync and certbot. Automating it
  adds production credentials to CI and the risk of an unintended deploy before the server,
  monitoring and rollback paths are ready.
- **Trigger:** more frequent deploys, multiple operators, a need for an audit trail or reproducible
  releases, a staging environment, or a desire to gate production on the test suite automatically.
- **Current state:**
  - [`.github/workflows/test.yml`](.github/workflows/test.yml) runs `npm ci`, `npm run format:check`,
    `npm test`, installs Playwright Chromium and runs `npm run test:e2e` on pushes to `master` and
    pull requests. It does not deploy. `npm run test:build` is local-only because it needs the
    external tile toolchain.
  - `node bin/ogis.mjs deploy` syncs `src/`, `bin/`, `config/` and package files, runs
    `npm ci --omit=dev`, renders and installs the systemd unit and nginx site, creates cache
    directories, issues or reuses TLS, restarts the service, reloads nginx and runs smoke checks.
    `--dry-run` prints the plan; `--skip-certbot`, `--skip-smoke`, `--allow-degraded` and
    `--require-ready` change the checks ([docs/6.operations.md](docs/6.operations.md#deploying-code-and-configuration)).
  - Deploy needs `SSH_PRIVATE_KEY_PATH`, `TILE_SERVER_HOST` and normally `CERTBOT_EMAIL`.
    Provisioning, the cloud-backed status view and remote builds also need `HCLOUD_TOKEN`;
    deploy itself is not provisioning and assumes the server, Node.js, users and directories exist.
  - Deploy restores the previous systemd unit and nginx site on an install or certbot failure, and
    retains `.ogis-backup` files if the restore fails. There is no staging server.
- **Approach options:**
  1. **Manual-dispatch GitHub Actions workflow (recommended).** A workflow with environment
     protection and required reviewers runs the test job, then `deploy --dry-run`, then `deploy`.
     Secrets hold the deploy key, host and certbot email. Keep the local command as a fallback.
  2. **On-merge staging, manual production.** Deploy automatically to a staging server, run browser
     smoke tests, then require approval for production. Needs a second server, DNS and certificate,
     so it overlaps with multi-server and backups.
  3. **CI checks only.** Run `deploy --dry-run` or render the unit and nginx site in CI without
     production credentials, and keep the real deploy local. This improves confidence without
     automating production.
  4. **Another CI system.** The same manual-dispatch or staging pattern with different secret and
     approval mechanics.
- **Recommendation:** start with a manual-dispatch workflow with required review and a test gate.
  Do not deploy to production on every push. Add staging only when a second server exists. Keep
  behavioural rollback as revert-and-redeploy.
- **Dependencies and prerequisites:** CI secrets and a rotation policy, a deploy key and sudo-capable
  deploy user, network access to the server, monitoring, a snapshot or backup before deploy,
  environment protection and audit logs, and optionally a staging server. The workflow must not
  sync `.env*` files or expose credentials in logs.
- **Verification:**
  - The workflow runs the same commands as a local dry run and fails on a test, format or smoke
    failure.
  - A manual dispatch deploys to production only after approval; the smoke checks pass.
  - A failed deploy restores the previous unit and nginx site, and the rollback path is tested.
  - Secrets are masked, not printed, and the deploy key can be revoked; concurrent deploys are
    prevented by a concurrency group.
  - A staging deploy, if present, exercises the same code before production.
- **Open questions:**
  - Which CI provider and approval model?
  - Is a staging server wanted, and who owns its DNS and certificate?
  - Should certbot run in CI, or should CI reuse an existing certificate with `--skip-certbot`?
  - Who holds the deploy key, and how is it rotated?
  - Should deploy run on merge, on a tag, or only by manual dispatch?
  - What maintenance window is acceptable for a deploy-induced restart?

## Unfiltered planet builds (deferred)

- **Status:** deferred; the filtered planet pipeline is the supported production path.
- **Why deferred:** an unfiltered build needs about 850 GiB on the build box, beyond the default
  CPX62's 640 GB disk. The filtered pipeline is smaller, faster and already validated end-to-end.
- **Trigger:** a need to validate that the shared osmium filter loses nothing important, a new layer
  that needs objects outside the current filter union, a debugging exercise, or a decision to stop
  filtering.
- **Current state:**
  - `--skip-filter` is implemented locally and remotely. It builds directly from the input PBF and
    records `filter.applied: false` and `filter.skipped: true` in the manifest
    ([docs/5.pipelines.md](docs/5.pipelines.md#2-filter)).
  - The remote build-box disk preflight requires about 850 GiB for `--skip-filter`, about 500 GiB
    for a filtered planet build and about 10 GiB for a fixture. A CPX62 provides a 640 GB disk
    (about 596 GiB usable), so `--skip-filter` is rejected before the build starts
    ([`src/build/remote.mjs`](src/build/remote.mjs)).
  - The build box must be x86; ARM server types are rejected because the image and Node.js tarball
    are x86 only. A larger server type is the supported escape hatch; attaching a volume is
    deliberately not automated.
  - An unfiltered archive can be larger than the filtered set, so the transfer destination and
    the tile server's 40 GB disk are also constraints. The tile server may need the CX33 upgrade or
    object storage.
  - Planet builds still require a dated URL, a date and at least one checksum pin; `planet-latest`
    is rejected.
- **Approach options:**
  1. **Larger x86 build box (recommended for a one-off).** Pass a larger `--build-server-type` and
     confirm the disk preflight. This uses the existing pipeline and transfer path; the cost and
     build time are higher.
  2. **Attach a volume for build scratch.** Not automated today; it needs cloud-init or remote
     changes to mount and clean the volume, and it adds a failure mode. Worth it only for recurring
     unfiltered builds.
  3. **Build locally on suitable hardware.** Avoids cloud cost and the box lifecycle, but needs a
     large local disk, the full toolchain and a reproducible environment; transfer to the server is
     still required.
  4. **Keep the filtered path and sample the difference.** If the goal is filter validation, build a
     representative extract rather than the whole planet.
- **Recommendation:** use a larger x86 build box for a one-off validation. Keep the filtered
  pipeline for routine refreshes. Automate a volume only if unfiltered builds become recurring.
- **Dependencies and prerequisites:** a larger x86 server type, cloud quota and budget, a longer
  build timeout if needed, destination capacity (CX33 or object storage), a revised transfer and
  verification plan, and monitoring. The build verification floors and sample tiles may need review
  for the unfiltered output.
- **Verification:**
  - The disk preflight accepts the chosen box, the build completes within the timeout and
    `pmtiles verify` plus sample-tile decoding pass.
  - The manifest records the unfiltered flags and the expected planet provenance.
  - A comparison with the filtered output shows the expected extra features without breaking the
    configured layers; archive size and tile counts are recorded.
  - The pair transfers, promotes and serves through the normal checks; the tile server has enough
    disk for incoming and rollback pairs.
  - The build box is destroyed or intentionally kept, and the cost is reviewed.
- **Open questions:**
  - Is the purpose filter validation, a new layer, or replacing the filtered pipeline?
  - Is this a one-off or a recurring build?
  - What box type and budget are acceptable?
  - Will the unfiltered archive fit the tile server, or is object storage/CX33 required?
  - Do the size floors and sample tiles need a separate unfiltered profile?

## Production frontend or embeddable viewer (deferred)

- **Status:** deferred; the server is API-only and `dev/` is a development harness.
- **Why deferred:** a public map, portal or embed is a separate product decision with design,
  hosting, basemap licensing, attribution and possibly accounts. The harness already proves the API
  and rendering path.
- **Trigger:** a public map or portal, a partner embed, user demand for a ready-made viewer, or a
  need to show the layers without a custom client.
- **Current state:**
  - [`dev/`](dev/) is a Vite and MapLibre harness: `dev/index.html`, `dev/src/main.js`,
    `dev/src/layers.js` and `dev/src/style.css`, with a vendored Canmore–Banff basemap and a
    four-source panel for `pois`, `routes`, `paths` and `contours`. It proxies API routes to the tile
    server and is covered by Playwright.
  - The harness is not deployed and is not part of the server process. It is offline and
    deterministic in the browser test; the Playwright fixture uses a local DEM block and absent
    PMTiles archives.
  - The server exposes `/sources`, `/<source>.json` TileJSON and tile routes with absolute tile URLs
    and `Access-Control-Allow-Origin: *`. There is no search, accounts, saved state, analytics or
    responsive product UI.
  - The basemap style, fonts, sprites and licence texts are vendored under `dev/basemap/` with
    provenance in `dev/basemap/manifest.json` and notices in `dev/basemap/NOTICE`.
- **Approach options:**
  1. **Minimal static viewer (recommended).** Extract the reusable layer builders and styling from
     `dev/src/layers.js` and `dev/src/main.js` into a small static MapLibre app that reads
     `/sources` and TileJSON, takes the API base URL from configuration, and is hosted separately.
     No server change beyond CORS review.
  2. **Embeddable widget.** A small script or iframe that takes a source, centre, zoom and optional
     layers, renders the map and attribution, and can be dropped into a third-party page. It needs a
     stable API, CORS, CSP compatibility, versioning and a size budget.
  3. **Full portal.** Search, accounts, saved maps, admin and analytics. This depends on the auth
     item and a database, and is a much larger product decision.
  4. **Server-rendered pages.** Not necessary for a map viewer; a static build is simpler and fits
     the current API.
- **Recommendation:** build a minimal static viewer from the harness first, then add an embeddable
  variant if partners need one. Defer the portal until auth and product requirements exist.
- **Dependencies and prerequisites:** a CORS review (the wildcard works but may need tightening), a
  static host or CDN, basemap licence and attribution, the code licence, accessibility and browser
  testing, and optionally auth for private layers. A CDN or object storage helps if the viewer is
  popular.
- **Verification:**
  - A production build loads `/sources` and all four sources, uses absolute TileJSON URLs, shows the
    required attribution and has no console errors.
  - The viewer works on mobile and desktop, with keyboard navigation and acceptable contrast.
  - An embed works on a separate origin with the documented CSP and CORS headers, and does not
    depend on the Vite proxy.
  - Tile caching, 404/503 handling and contour attribution behave as in the API contract.
  - A Playwright smoke test covers the production build, not only the harness.
- **Open questions:**
  - What is the audience and primary use case: public map, partner embed, or internal preview?
  - Standalone site, embeddable widget, or both?
  - Which basemap and licence are acceptable for production?
  - Where will it be hosted, and does it need a CDN?
  - Are accounts, saved maps or search in scope?
  - What accessibility and browser-support baseline is required?
  - Does the code licence decision need to happen before the viewer is published?

## Code licence (deferred)

- **Status:** deferred; there is no root `LICENSE` or `NOTICE`, and the code licence is undecided.
- **Why deferred:** the licence is a legal and product decision separate from the technical roadmap.
  The package is marked `"private": true`, and no public reuse terms have been published.
- **Trigger:** publishing the source, accepting outside contributions, allowing commercial reuse,
  embedding the code in another product, or a legal or funding requirement.
- **Current state:**
  - There is no root `LICENSE` or `NOTICE` file, and [`package.json`](package.json) has no
    `license` field. Without a licence, the default copyright position is that reuse is not granted.
  - [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) records the runtime dependencies:
    `maplibre-contour` (BSD-3-Clause), `sharp` (Apache-2.0) and bundled libvips
    (LGPL-2.1-or-later). It also records the data position: OpenStreetMap-derived data is ODbL,
    Mapterhorn attribution is required, and the vendored development basemap has its own notices in
    `dev/basemap/NOTICE`.
  - [`README.md`](README.md#data-and-licences) and
    [docs/5.pipelines.md](docs/5.pipelines.md#caveats) both state that the code licence is not yet
    decided.
  - The code licence is separate from the data licences and from the basemap assets. A code licence
    does not grant rights to OpenStreetMap data, Mapterhorn DEM data or the vendored basemap.
- **Approach options:**
  1. **MIT.** Short and permissive; simple for reuse and contributions. No explicit patent grant.
  2. **Apache-2.0.** Permissive with an explicit patent grant and a `NOTICE` convention; a good fit
     if broader contribution or commercial adoption is expected.
  3. **AGPL-3.0.** Copyleft that covers network use; may fit a hosted service if reciprocity is
     wanted, but can deter embedding and commercial use.
  4. **Proprietary or all rights reserved.** Keep the current default and add an explicit notice if
     the source is published without a reuse grant.
  5. **Dual licence.** An open licence plus a commercial licence; needs legal advice, a contributor
     agreement and clear branding.
- **Recommendation:** no technical recommendation; choose based on the intended reuse and
  contribution model. If the project is opened up, Apache-2.0 or MIT are the simplest options. Add a
  root `LICENSE`, a `NOTICE` if Apache-2.0 is chosen, a `license` field in `package.json`, a README
  statement, and keep the third-party and data notices.
- **Dependencies and prerequisites:** confirmation of copyright ownership (including any outside
  contributions), compatibility with the third-party notices, a decision about the ODbL data and
  Mapterhorn attribution, trademark and branding policy, and legal review if the project is
  commercialised. A contributor licence agreement or sign-off may be needed before accepting
  contributions.
- **Verification:**
  - A root `LICENSE` exists and matches the chosen SPDX identifier.
  - `package.json` declares the same licence, and the README states it.
  - `THIRD_PARTY_NOTICES.md` remains accurate and any required `NOTICE` file is present.
  - Data attribution and the basemap notices are unchanged and visible in the product.
  - A reuse or distribution check confirms the chosen terms are internally consistent.
- **Open questions:**
  - Is the intention to open-source the code, keep it proprietary, or dual-licence it?
  - If open source, is a permissive licence or a copyleft licence preferred?
  - Is an explicit patent grant important?
  - Will the code be used in commercial or hosted products?
  - Are outside contributions expected, and is a contributor licence agreement (CLA) or developer
    certificate of origin (DCO) acceptable?
  - Is there a trademark or branding policy?
  - Does legal review need to happen before publication?

**Previous:** [7. Roadmap](docs/7.roadmap.md) · **Next:** [Documentation index](docs/README.md) · [Documentation index](docs/README.md)
