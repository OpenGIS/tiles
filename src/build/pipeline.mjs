import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import path from 'node:path';

import { computeBuildId, computeRunId, isBuildId } from './build-id.mjs';
import {
  javaProfileArgs,
  osmiumCatArgs,
  osmiumFileinfoArgs,
  osmiumTagsFilterArgs,
  planetilerArgs,
  pmtilesEditHeaderArgs,
  pmtilesShowArgs,
  pmtilesShowHeaderArgs,
} from './commands.mjs';
import {
  loadBuildConfig,
  normaliseOutputDir,
  normalisePlanetDate,
  normalisePlanetSha256,
  normalisePlanetUrl,
  resolveSizeFloor,
} from './config.mjs';
import { normaliseCalendarDate } from './dates.mjs';
import { BuildError, BuildConfigError } from './errors.mjs';
import { runCommand } from './exec.mjs';
import { fileSize, pathExists, removePath, sha256File, sha256Text } from './fs.mjs';
import { repairHeader, serialiseHeader } from './header.mjs';
import { renderExpressionsFile, sourceExpressionUnion } from './expressions.mjs';
import { installArchives } from './install.mjs';
import { createBuildManifest } from './manifest.mjs';
import { deriveMinZoom, resolveProfile, resolveProfileHeap } from './profiles.mjs';
import { resolveArchiveDir } from '../lib/config.mjs';
import { PmtilesReader } from '../lib/pmtiles.mjs';
import {
  detectJavaVersion,
  detectOsmiumVersion,
  detectPmtiles,
  downloadFile,
  ensurePlanetiler,
  resolveExecutable,
} from './tools.mjs';
import {
  inspectArchiveWithoutVerification,
  parseTileCount,
  verificationLayers,
  verifyArchive,
} from './verify.mjs';

function resolvePath(repoRoot, target) {
  return path.isAbsolute(target) ? path.normalize(target) : path.resolve(repoRoot, target);
}

function assertWithinRoot(root, target, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);

  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new BuildError(`${label} resolves outside the output directory`);
  }

  return resolvedTarget;
}

function relativePath(repoRoot, target) {
  return path.relative(repoRoot, target).split(path.sep).join('/');
}

function firstValue(...values) {
  return values.find((value) => typeof value === 'string' && value.trim() !== '') ?? '';
}

function validatePathOption(value, label) {
  if (value === undefined) {
    return '';
  }

  if (typeof value !== 'string' || value.trim() === '') {
    throw new BuildConfigError(`${label} must be a non-empty path`);
  }

  return value.trim();
}

function resolveOutputDir(repoRoot, value, fallback) {
  if (value !== undefined) {
    return resolvePath(repoRoot, normaliseOutputDir(value, '--output-dir'));
  }

  return resolvePath(repoRoot, normaliseOutputDir(fallback, 'build.outputDir'));
}

async function removeEmptyDirectory(target) {
  try {
    await rmdir(target);
  } catch {
    // The directory is absent or still has entries; either is fine here.
  }
}

function validateRunOptions({ options, env }) {
  if (options.only !== undefined && String(options.only).trim() === '') {
    throw new BuildConfigError('--only requires at least one source name');
  }

  validatePathOption(options.fixture, '--fixture');
  validatePathOption(options.archive, '--archive');

  if (options.skipDownload && options.force) {
    throw new BuildConfigError('--skip-download cannot be combined with --force');
  }

  const url = firstValue(options.planetUrl, env.PLANET_URL);
  if (url !== '') {
    normalisePlanetUrl(url, 'Planet URL');
  }

  const sha256 = firstValue(options.planetSha256, env.PLANET_SHA256);
  if (sha256 !== '') {
    normalisePlanetSha256(sha256, 'Planet SHA-256');
  }

  const date = firstValue(options.planetDate, env.PLANET_DATE);
  if (date !== '') {
    normalisePlanetDate(date, 'Planet date');
  }
}

function selectSources(config, only) {
  if (only === undefined || only === null) {
    return Object.keys(config.sources);
  }

  const requested = [
    ...new Set(
      String(only)
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== ''),
    ),
  ];

  if (requested.length === 0) {
    throw new BuildConfigError('--only requires at least one source name');
  }

  for (const name of requested) {
    if (!Object.hasOwn(config.sources, name)) {
      throw new BuildConfigError(`Source "${name}" has no build profile`);
    }
  }

  return requested;
}

async function readFixtureManifest(pbfPath) {
  const candidate = pbfPath.replace(/\.osm\.pbf$/i, '.manifest.json');
  const manifestPath = candidate === pbfPath ? `${pbfPath}.manifest.json` : candidate;

  if (!(await pathExists(manifestPath))) {
    return { manifestPath: '', manifest: null };
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new BuildError(`Fixture manifest is not valid JSON: ${manifestPath}`, { cause: error });
  }

  return { manifestPath, manifest };
}

async function resolvePlanetInput({ repoRoot, options, config, env, force, fetchImpl }) {
  const fixture = firstValue(options.fixture);
  if (fixture !== '') {
    const pbfPath = resolvePath(repoRoot, fixture);
    if (!(await pathExists(pbfPath))) {
      throw new BuildError(`Fixture PBF not found: ${relativePath(repoRoot, pbfPath)}`);
    }

    const { manifestPath, manifest } = await readFixtureManifest(pbfPath);
    const actualSha256 = await sha256File(pbfPath);
    const expected = firstValue(options.planetSha256, env.PLANET_SHA256, manifest?.sha256);

    if (expected !== '' && expected !== actualSha256) {
      throw new BuildError(
        `Fixture checksum mismatch for ${relativePath(repoRoot, pbfPath)}: expected ${expected}, received ${actualSha256}`,
      );
    }

    return {
      mode: 'fixture',
      pbfPath,
      url: manifest?.sourceUrl ?? '',
      sha256: actualSha256,
      fixture: {
        manifestPath,
        manifest,
      },
    };
  }

  const localPlanet = firstValue(options.planetPbf);
  const url = firstValue(options.planetUrl, env.PLANET_URL, config.build.planet.url);
  const providedSha = firstValue(
    options.planetSha256,
    env.PLANET_SHA256,
    config.build.planet.sha256,
  );

  if (providedSha === '') {
    throw new BuildConfigError(
      'A pinned planet SHA-256 is required; set build.planet.sha256, PLANET_SHA256 or --planet-sha256',
    );
  }

  if (localPlanet !== '') {
    const pbfPath = resolvePath(repoRoot, localPlanet);
    if (!(await pathExists(pbfPath))) {
      throw new BuildError(`Planet PBF not found: ${relativePath(repoRoot, pbfPath)}`);
    }

    const actualSha256 = await sha256File(pbfPath);
    if (actualSha256 !== providedSha) {
      throw new BuildError(
        `Planet PBF checksum mismatch for ${relativePath(repoRoot, pbfPath)}: expected ${providedSha}, received ${actualSha256}`,
      );
    }

    return {
      mode: 'planet',
      pbfPath,
      url: url || '',
      sha256: actualSha256,
      fixture: null,
    };
  }

  if (url === '') {
    throw new BuildConfigError(
      'No planet URL is configured; set build.planet.url, PLANET_URL or --planet-url',
    );
  }

  const parsedUrl = new URL(url);
  const filename = path.basename(parsedUrl.pathname) || 'planet.osm.pbf';
  const pbfPath = path.join(repoRoot, 'tmp', 'planet', filename);
  const cached = await pathExists(pbfPath);

  if (!cached || force) {
    if (options.skipDownload && !cached) {
      throw new BuildError(
        `Planet PBF is not available at ${relativePath(repoRoot, pbfPath)} and --skip-download was set`,
      );
    }

    if (!cached || force) {
      await downloadFile({
        url,
        destination: pbfPath,
        expectedSha256: providedSha,
        fetchImpl,
      });
    }
  }

  const actualSha256 = await sha256File(pbfPath);
  if (actualSha256 !== providedSha) {
    throw new BuildError(
      `Planet PBF checksum mismatch at ${relativePath(repoRoot, pbfPath)}: expected ${providedSha}, received ${actualSha256}; the cached file is stale or corrupt${force ? '' : ' (use --force to download it again)'}`,
    );
  }

  return {
    mode: 'planet',
    pbfPath,
    url,
    sha256: actualSha256,
    fixture: null,
  };
}

function resolvePlanetDate({ mode, options, env, config, fixture }) {
  const explicit = firstValue(options.planetDate, env.PLANET_DATE);
  const configured = config.build.planet.date;

  if (mode === 'fixture') {
    return firstValue(fixture?.manifest?.extractDate, explicit, configured);
  }

  const date = firstValue(explicit, configured);
  if (date === '') {
    throw new BuildConfigError(
      'A planet date is required for planet builds; set build.planet.date, PLANET_DATE or --planet-date',
    );
  }

  return date;
}

async function detectToolchain({ mode, config, execFileImpl, warn }) {
  const javaVersion = await detectJavaVersion({ execFileImpl });
  const javaPath = await resolveExecutable('java', { execFileImpl });
  const osmiumVersion = await detectOsmiumVersion({ execFileImpl });
  const osmiumPath = await resolveExecutable('osmium', { execFileImpl });
  const pmtiles = await detectPmtiles({ execFileImpl });
  const pmtilesPath = await resolveExecutable('pmtiles', { execFileImpl });

  if (pmtiles.version !== config.build.tools.pmtiles) {
    const message = `pmtiles CLI reports "${pmtiles.version}" but the configured pin is "${config.build.tools.pmtiles}"`;

    if (mode === 'planet') {
      throw new BuildError(`${message}; planet builds require the pinned pmtiles version`);
    }

    warn(`${message}; continuing with the actual binary for the fixture build`);
  }

  return {
    pmtiles: {
      version: pmtiles.version,
      sha256: pmtiles.sha256,
      pinned: config.build.tools.pmtiles,
      path: pmtilesPath,
    },
    java: {
      version: javaVersion,
      path: javaPath,
      sha256: await sha256File(javaPath),
    },
    osmium: {
      version: osmiumVersion,
      path: osmiumPath,
      sha256: await sha256File(osmiumPath),
    },
  };
}

function fixtureRecord(repoRoot, planet) {
  if (planet.mode !== 'fixture' || !planet.fixture?.manifest) {
    return null;
  }

  const manifest = planet.fixture.manifest;

  return {
    path: relativePath(repoRoot, planet.pbfPath),
    sha256: planet.sha256,
    manifest: planet.fixture.manifestPath
      ? relativePath(repoRoot, planet.fixture.manifestPath)
      : '',
    sourceUrl: manifest.sourceUrl ?? '',
    extractDate: manifest.extractDate ?? '',
    bbox: manifest.bbox ?? [],
  };
}

async function archiveMinimumZoom(archivePath) {
  const reader = new PmtilesReader(archivePath);

  try {
    await reader.open();
    return reader.getMinimumZoom();
  } finally {
    await reader.close();
  }
}

async function findExistingArchive(outputRoot, sourceName) {
  const candidates = [path.join(outputRoot, sourceName, 'current.pmtiles')];

  let entries = [];
  try {
    entries = await readdir(outputRoot, { withFileTypes: true });
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== '.staging') {
      candidates.push(path.join(outputRoot, entry.name, sourceName, 'current.pmtiles'));
    }
  }

  const existing = [];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      existing.push({ path: candidate, mtimeMs: (await stat(candidate)).mtimeMs });
    }
  }

  existing.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return existing[0]?.path ?? '';
}

async function readExistingManifest(archivePath) {
  const archiveDir = path.dirname(archivePath);
  const archiveName = path.basename(archivePath);
  const sidecarName =
    archiveName === 'current.pmtiles'
      ? 'current.json'
      : archiveName === 'previous.pmtiles'
        ? 'previous.json'
        : '';
  const candidates = [
    path.join(archiveDir, 'build.json'),
    ...(sidecarName === '' ? [] : [path.join(archiveDir, sidecarName)]),
    path.join(path.dirname(archiveDir), 'build.json'),
  ];

  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) {
      continue;
    }

    try {
      return { manifestPath: candidate, manifest: JSON.parse(await readFile(candidate, 'utf8')) };
    } catch {
      // An unreadable manifest is treated as absent.
    }
  }

  return { manifestPath: '', manifest: null };
}

async function readFixtureProvenance(repoRoot, fixture) {
  const pbfPath = resolvePath(repoRoot, fixture);
  if (!(await pathExists(pbfPath))) {
    throw new BuildError(`Fixture PBF not found: ${relativePath(repoRoot, pbfPath)}`);
  }

  const { manifestPath, manifest } = await readFixtureManifest(pbfPath);
  const record = {
    path: relativePath(repoRoot, pbfPath),
    sha256: await sha256File(pbfPath),
    manifest: manifestPath ? relativePath(repoRoot, manifestPath) : '',
    sourceUrl: '',
    extractDate: '',
    bbox: [],
  };

  if (!manifest) {
    return record;
  }

  return {
    ...record,
    sourceUrl: manifest.sourceUrl ?? '',
    extractDate: normaliseCalendarDate(manifest.extractDate ?? '', 'fixture.extractDate'),
    bbox: manifest.bbox ?? [],
  };
}

async function buildFromArchive({
  repoRoot,
  config,
  sourceName,
  sourceConfig,
  options,
  env,
  execFileImpl,
  log,
  warn,
  outputRoot,
  dataDir,
}) {
  const archivePath = options.archive
    ? resolvePath(repoRoot, validatePathOption(options.archive, '--archive'))
    : await findExistingArchive(outputRoot, sourceName);

  if (archivePath === '' || !(await pathExists(archivePath))) {
    throw new BuildError(
      `--skip-build requires an existing archive; pass --archive or build ${sourceName} first`,
    );
  }

  const { manifest: existingManifest } = await readExistingManifest(archivePath);
  const profile = await resolveProfile(repoRoot, sourceConfig.profile, sourceConfig);
  const profileContents = await readFile(profile.filePath, 'utf8');
  const profileHash = sha256Text(profileContents);
  const expressions = sourceExpressionUnion(config.sources);
  const filterHash = sha256Text(renderExpressionsFile(expressions));
  const fixtureOption = firstValue(options.fixture);
  const mode =
    existingManifest?.mode === 'fixture' || existingManifest?.mode === 'planet'
      ? existingManifest.mode
      : fixtureOption !== ''
        ? 'fixture'
        : 'planet';
  let fixture = existingManifest?.fixture ?? null;

  if (!fixture && mode === 'fixture' && fixtureOption !== '') {
    fixture = await readFixtureProvenance(repoRoot, fixtureOption);
  }

  const planetDate = firstValue(
    options.planetDate,
    env.PLANET_DATE,
    existingManifest?.planet?.date,
    fixture?.extractDate,
    config.build.planet.date,
  );

  if (mode === 'planet' && planetDate === '') {
    throw new BuildConfigError(
      'A planet date is required for planet builds; set build.planet.date, PLANET_DATE or --planet-date',
    );
  }

  const pmtiles = await detectPmtiles({ execFileImpl });
  if (pmtiles.version !== config.build.tools.pmtiles) {
    const message = `pmtiles CLI reports "${pmtiles.version}" but the configured pin is "${config.build.tools.pmtiles}"`;

    if (mode === 'planet') {
      throw new BuildError(`${message}; planet builds require the pinned pmtiles version`);
    }

    warn(`${message}; continuing with the actual binary for the archive build`);
  }

  const pmtilesRecord = {
    version: pmtiles.version,
    sha256: pmtiles.sha256,
    pinned: config.build.tools.pmtiles,
  };
  const archiveSha256 = await sha256File(archivePath);
  const sizeFloor = resolveSizeFloor(sourceConfig.sizeFloor, mode);
  const sources = options.skipVerify
    ? await inspectArchiveWithoutVerification({ archivePath, sizeFloor, execFileImpl })
    : await verifyArchive({
        archivePath,
        samples: sourceConfig.sampleTiles,
        sizeFloor,
        verification: sourceConfig.verification,
        execFileImpl,
      });

  if (options.install && sources.verification.ok !== true && !options.allowUnverifiedInstall) {
    throw new BuildError(
      'Refusing to install an archive whose verification was skipped; pass --allow-unverified-install to override',
    );
  }

  const computedBuildId = computeBuildId({ mode, planetDate, archiveSha256 });
  const sidecarBuildId = existingManifest?.buildId;
  const sidecarSha256 = existingManifest?.archive?.sha256;
  const sidecarIsContentAddressed =
    isBuildId(sidecarBuildId) &&
    sidecarBuildId.slice(-12) === archiveSha256.slice(0, 12) &&
    (typeof sidecarSha256 !== 'string' || sidecarSha256 === archiveSha256);
  const buildId = sidecarIsContentAddressed ? sidecarBuildId : computedBuildId;
  const filterExpressions = existingManifest?.filter?.expressions ?? expressions.length;
  const filterSha256 = existingManifest?.filter?.sha256 ?? filterHash;

  const manifest = createBuildManifest({
    buildId,
    runId: existingManifest?.runId ?? '',
    source: sourceName,
    mode,
    minzoom: sourceConfig.minzoom,
    maxzoom: sourceConfig.maxzoom,
    planet: {
      date: planetDate,
      url: existingManifest?.planet?.url ?? '',
      sha256: existingManifest?.planet?.sha256 ?? '',
    },
    fixture,
    tools: {
      planetiler: existingManifest?.tools?.planetiler ?? {
        version: config.build.tools.planetiler.version,
        url: config.build.tools.planetiler.url,
        sha256: config.build.tools.planetiler.sha256,
        path: '',
      },
      pmtiles: pmtilesRecord,
      java: existingManifest?.tools?.java ?? {
        version: 'not checked',
        path: '',
        sha256: '',
      },
      osmium: existingManifest?.tools?.osmium ?? {
        version: 'not checked',
        path: '',
        sha256: '',
      },
    },
    profile: existingManifest?.profile ?? {
      path: relativePath(repoRoot, profile.filePath),
      sha256: profileHash,
    },
    filter: {
      sha256: filterSha256,
      expressions: filterExpressions,
      applied: existingManifest?.filter?.applied ?? false,
      skipped: existingManifest?.filter?.skipped ?? true,
    },
    skips: {
      download: Boolean(options.skipDownload ?? existingManifest?.skips?.download),
      filter: existingManifest?.filter?.skipped ?? true,
      build: true,
      verify: Boolean(options.skipVerify),
    },
    verification: {
      ok: sources.verification.ok,
      skipped: sources.verification.skipped,
      layers: verificationLayers(sourceConfig.verification),
    },
    archive: {
      path: 'current.pmtiles',
      sha256: archiveSha256,
      bytes: sources.bytes,
      tiles: sources.tiles,
      compression: sources.compression,
      metadata: sources.metadata,
    },
    samples: sources.samples,
    sizeFloor,
  });

  const finalSourceDir = assertWithinRoot(
    outputRoot,
    path.join(outputRoot, buildId, sourceName),
    'build directory',
  );
  const finalArchivePath = path.join(finalSourceDir, 'current.pmtiles');
  const finalManifestPath = path.join(finalSourceDir, 'build.json');

  if (path.resolve(path.dirname(archivePath)) !== path.resolve(finalSourceDir)) {
    if (await pathExists(finalSourceDir)) {
      await removePath(finalSourceDir);
    }
    await mkdir(finalSourceDir, { recursive: true });
    await copyFile(archivePath, finalArchivePath);
  }

  await writeFile(finalManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  log(`${sourceName}: reused ${sources.tiles} tiles, ${sources.bytes} bytes, build ${buildId}`);

  return {
    buildId,
    source: sourceName,
    mode,
    archivePath: finalArchivePath,
    manifestPath: finalManifestPath,
    archiveSha256,
    bytes: sources.bytes,
    tiles: sources.tiles,
    samples: sources.samples,
    installed: null,
    built: false,
    dataDir,
  };
}

async function buildSource({
  repoRoot,
  config,
  sourceName,
  sourceConfig,
  options,
  env,
  fetchImpl,
  execFileImpl,
  log,
  warn,
  outputRoot,
  dataDir,
}) {
  if (options.skipBuild) {
    return buildFromArchive({
      repoRoot,
      config,
      sourceName,
      sourceConfig,
      options,
      env,
      execFileImpl,
      log,
      warn,
      outputRoot,
      dataDir,
    });
  }

  const profile = await resolveProfile(repoRoot, sourceConfig.profile, sourceConfig);
  const planet = await resolvePlanetInput({
    repoRoot,
    options,
    config,
    env,
    force: Boolean(options.force),
    fetchImpl,
  });
  const planetDate = resolvePlanetDate({
    mode: planet.mode,
    options,
    env,
    config,
    fixture: planet.fixture,
  });

  log(`Preparing ${sourceName} build from ${planet.mode} PBF`);

  const toolchain = await detectToolchain({
    mode: planet.mode,
    config,
    execFileImpl,
    warn,
  });

  let planetiler = {
    version: config.build.tools.planetiler.version,
    url: config.build.tools.planetiler.url,
    sha256: config.build.tools.planetiler.sha256,
    path: '',
  };

  const ensured = await ensurePlanetiler({
    planetiler: config.build.tools.planetiler,
    toolsDir: path.join(repoRoot, 'tmp', 'tools'),
    fetchImpl,
    force: Boolean(options.force),
  });
  planetiler = { ...planetiler, ...ensured };

  const profileContents = await readFile(profile.filePath, 'utf8');
  const profileHash = sha256Text(profileContents);
  const expressions = sourceExpressionUnion(config.sources);
  const filterHash = sha256Text(renderExpressionsFile(expressions));
  const filterApplied = !options.skipFilter;
  const filterSkipped = Boolean(options.skipFilter);
  const skips = {
    download: Boolean(options.skipDownload),
    filter: filterSkipped,
    build: false,
    verify: Boolean(options.skipVerify),
  };

  const runId = computeRunId({
    mode: planet.mode,
    source: sourceName,
    planetDate,
    planetSha256: planet.sha256,
    minzoom: sourceConfig.minzoom,
    maxzoom: sourceConfig.maxzoom,
    filterApplied,
    filterSkipped,
    profileHash,
    filterHash,
    skips,
    tools: {
      planetiler: { version: planetiler.version, sha256: planetiler.sha256 },
      pmtiles: toolchain.pmtiles,
      java: toolchain.java,
      osmium: toolchain.osmium,
    },
  });

  const workDir = path.join(repoRoot, 'tmp', 'work', runId, sourceName);
  const stagingParent = path.join(outputRoot, '.staging', runId);
  const stagingSourceDir = path.join(stagingParent, sourceName);
  const partialArchivePath = path.join(stagingSourceDir, 'current.partial.pmtiles');
  const stagedArchivePath = path.join(stagingSourceDir, 'current.pmtiles');
  const stagedManifestPath = path.join(stagingSourceDir, 'build.json');

  log(`Build run ${runId}`);

  try {
    await removePath(workDir);
    await mkdir(workDir, { recursive: true });
    await mkdir(stagingSourceDir, { recursive: true });

    await runCommand('osmium', osmiumFileinfoArgs(planet.pbfPath), { execFileImpl });

    let buildPbf = planet.pbfPath;

    if (!options.skipFilter) {
      const expressionsPath = path.join(workDir, 'expressions.txt');
      const taggedPath = path.join(workDir, 'tagged.osm.pbf');
      const filteredPath = path.join(workDir, 'filtered.osm.pbf');

      await writeFile(expressionsPath, renderExpressionsFile(expressions), 'utf8');
      await runCommand(
        'osmium',
        osmiumTagsFilterArgs({
          inputPath: planet.pbfPath,
          expressionsPath,
          outputPath: taggedPath,
        }),
        { execFileImpl },
      );
      await runCommand(
        'osmium',
        osmiumCatArgs({ inputPath: taggedPath, outputPath: filteredPath }),
        { execFileImpl },
      );

      buildPbf = filteredPath;
    }

    const planetilerTmpDir = path.join(workDir, 'planetiler-tmp');
    const profileArgs =
      profile.kind === 'java'
        ? javaProfileArgs({
            heap: resolveProfileHeap(profile, { mode: planet.mode, env }),
            jarPath: planetiler.path,
            profilePath: profile.filePath,
            osmPath: buildPbf,
            outputPath: partialArchivePath,
            tmpDir: planetilerTmpDir,
            minzoom: sourceConfig.minzoom,
            maxzoom: sourceConfig.maxzoom,
            threads: availableParallelism(),
          })
        : planetilerArgs({
            jarPath: planetiler.path,
            schemaPath: profile.filePath,
            osmPath: buildPbf,
            outputPath: partialArchivePath,
            tmpDir: planetilerTmpDir,
            minzoom: sourceConfig.minzoom,
            maxzoom: sourceConfig.maxzoom,
          });

    await runCommand('java', profileArgs, {
      execFileImpl,
      maxBuffer: 64 * 1024 * 1024,
    });

    const { stdout } = await runCommand('pmtiles', pmtilesShowHeaderArgs(partialArchivePath), {
      execFileImpl,
    });
    const parsedHeader = JSON.parse(stdout);
    const headerMinZoom =
      profile.kind === 'yaml'
        ? (deriveMinZoom(profileContents) ?? parsedHeader.minzoom)
        : await archiveMinimumZoom(partialArchivePath);
    const header = repairHeader(parsedHeader, {
      minzoom: headerMinZoom,
    });
    const headerPath = path.join(workDir, 'header.json');
    await writeFile(headerPath, serialiseHeader(header), 'utf8');
    await runCommand('pmtiles', pmtilesEditHeaderArgs(partialArchivePath, headerPath), {
      execFileImpl,
    });

    const sizeFloor = resolveSizeFloor(sourceConfig.sizeFloor, planet.mode);
    const archiveStats = options.skipVerify
      ? await inspectArchiveWithoutVerification({
          archivePath: partialArchivePath,
          sizeFloor,
          execFileImpl,
        })
      : await verifyArchive({
          archivePath: partialArchivePath,
          samples: sourceConfig.sampleTiles,
          sizeFloor,
          verification: sourceConfig.verification,
          execFileImpl,
        });

    await rename(partialArchivePath, stagedArchivePath);

    const archiveSha256 = await sha256File(stagedArchivePath);
    const buildId = computeBuildId({ mode: planet.mode, planetDate, archiveSha256 });

    const manifest = createBuildManifest({
      buildId,
      runId,
      source: sourceName,
      mode: planet.mode,
      minzoom: sourceConfig.minzoom,
      maxzoom: sourceConfig.maxzoom,
      planet: {
        date: planetDate,
        url: planet.url,
        sha256: planet.sha256,
      },
      fixture: fixtureRecord(repoRoot, planet),
      tools: {
        planetiler,
        pmtiles: toolchain.pmtiles,
        java: toolchain.java,
        osmium: toolchain.osmium,
      },
      profile: {
        path: relativePath(repoRoot, profile.filePath),
        sha256: profileHash,
      },
      filter: {
        sha256: filterHash,
        expressions: expressions.length,
        applied: filterApplied,
        skipped: filterSkipped,
      },
      skips,
      verification: {
        ok: archiveStats.verification.ok,
        skipped: archiveStats.verification.skipped,
        layers: verificationLayers(sourceConfig.verification),
      },
      archive: {
        path: 'current.pmtiles',
        sha256: archiveSha256,
        bytes: archiveStats.bytes,
        tiles: archiveStats.tiles,
        compression: archiveStats.compression,
        metadata: archiveStats.metadata,
      },
      samples: archiveStats.samples,
      sizeFloor,
    });

    await writeFile(stagedManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    if (
      options.install &&
      archiveStats.verification.ok !== true &&
      !options.allowUnverifiedInstall
    ) {
      throw new BuildError(
        'Refusing to install an archive whose verification was skipped; pass --allow-unverified-install to override',
      );
    }

    const finalSourceDir = assertWithinRoot(
      outputRoot,
      path.join(outputRoot, buildId, sourceName),
      'build directory',
    );
    const finalArchivePath = path.join(finalSourceDir, 'current.pmtiles');
    const finalManifestPath = path.join(finalSourceDir, 'build.json');

    if (await pathExists(finalSourceDir)) {
      await removePath(finalSourceDir);
    }
    await mkdir(path.dirname(finalSourceDir), { recursive: true });
    await rename(stagingSourceDir, finalSourceDir);
    await removePath(path.join(outputRoot, '.staging')).catch(() => {});

    if (!options.keepWork) {
      await removePath(path.dirname(workDir));
    } else if (await pathExists(workDir)) {
      log(`Work directory kept at ${relativePath(repoRoot, workDir)}`);
    }

    log(
      `${sourceName}: ${archiveStats.tiles} tiles, ${archiveStats.bytes} bytes, build ${buildId}`,
    );

    return {
      buildId,
      source: sourceName,
      mode: planet.mode,
      archivePath: finalArchivePath,
      manifestPath: finalManifestPath,
      archiveSha256,
      bytes: archiveStats.bytes,
      tiles: archiveStats.tiles,
      samples: archiveStats.samples,
      installed: null,
      built: true,
      dataDir,
    };
  } catch (error) {
    await removePath(partialArchivePath).catch(() => {});
    await removePath(stagedArchivePath).catch(() => {});
    await removePath(stagedManifestPath).catch(() => {});

    if (!options.keepWork) {
      await removePath(path.dirname(workDir)).catch(() => {});
      await removePath(path.join(outputRoot, '.staging')).catch(() => {});
    } else if (await pathExists(workDir)) {
      log(`Build failed; work directory kept at ${relativePath(repoRoot, workDir)}`);
    }

    await removeEmptyDirectory(stagingSourceDir);
    await removeEmptyDirectory(stagingParent);
    await removeEmptyDirectory(path.join(outputRoot, '.staging'));

    throw error;
  }
}

export async function runBuild({
  repoRoot,
  configPath,
  only,
  fixture,
  archive,
  planetPbf,
  planetUrl,
  planetDate,
  planetSha256,
  skipDownload = false,
  skipFilter = false,
  skipBuild = false,
  skipVerify = false,
  outputDir,
  install = false,
  allowUnverifiedInstall = false,
  keepWork = false,
  force = false,
  env = process.env,
  fetchImpl = fetch,
  execFileImpl,
  log = console.log,
  warn = console.warn,
}) {
  if (!repoRoot) {
    throw new BuildConfigError('A repository root is required');
  }

  const resolvedConfigPath = configPath ?? path.join(repoRoot, 'config', 'layers.json');
  const config = loadBuildConfig(resolvedConfigPath);
  const options = {
    only,
    fixture,
    archive,
    planetPbf,
    planetUrl,
    planetDate,
    planetSha256,
    skipDownload,
    skipFilter,
    skipBuild,
    skipVerify,
    outputDir,
    install,
    allowUnverifiedInstall,
    keepWork,
    force,
  };

  validateRunOptions({ options, env });

  const selected = selectSources(config, only);
  const outputRoot = resolveOutputDir(repoRoot, outputDir, config.build.outputDir);
  const results = [];

  for (const sourceName of selected) {
    const sourceConfig = config.sources[sourceName];

    let dataDir;
    try {
      dataDir = resolveArchiveDir(
        sourceConfig.archiveDir,
        `sources.${sourceName}.archiveDir`,
        repoRoot,
        { allowAbsolute: false },
      );
    } catch (error) {
      throw new BuildConfigError(error.message, { cause: error });
    }

    results.push(
      await buildSource({
        repoRoot,
        config,
        sourceName,
        sourceConfig,
        options,
        env,
        fetchImpl,
        execFileImpl,
        log,
        warn,
        outputRoot,
        dataDir,
      }),
    );
  }

  if (install) {
    const entries = results.map((result) => ({
      archivePath: result.archivePath,
      manifestPath: result.manifestPath,
      dataDir: result.dataDir,
    }));
    const installed = await installArchives(entries);

    for (const [index, result] of results.entries()) {
      result.installed = installed[index];
    }
  }

  for (const result of results) {
    delete result.dataDir;
  }

  return results;
}
