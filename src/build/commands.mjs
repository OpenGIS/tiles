export function javaVersionArgs() {
  return ['-version'];
}

export function osmiumVersionArgs() {
  return ['--version'];
}

export function pmtilesVersionArgs() {
  return ['version'];
}

export function osmiumFileinfoArgs(inputPath) {
  return ['fileinfo', '-e', inputPath];
}

export function osmiumTagsFilterArgs({ inputPath, expressionsPath, outputPath }) {
  return ['tags-filter', '-O', '-e', expressionsPath, '-t', inputPath, '-o', outputPath];
}

export function osmiumCatArgs({ inputPath, outputPath }) {
  return [
    'cat',
    '-O',
    '-c',
    'version',
    '-c',
    'changeset',
    '-c',
    'timestamp',
    '-c',
    'uid',
    '-c',
    'user',
    inputPath,
    '-o',
    outputPath,
  ];
}

export function planetilerArgs({
  jarPath,
  schemaPath,
  osmPath,
  outputPath,
  tmpDir,
  minzoom,
  maxzoom,
}) {
  return [
    '-jar',
    jarPath,
    'generate-custom',
    `--schema=${schemaPath}`,
    `--osm_path=${osmPath}`,
    `--output=${outputPath}`,
    `--tmpdir=${tmpDir}`,
    `--minzoom=${minzoom}`,
    `--maxzoom=${maxzoom}`,
    '--force',
    '--use_wikidata=false',
  ];
}

export function javaProfileArgs({
  heap,
  jarPath,
  profilePath,
  osmPath,
  outputPath,
  tmpDir,
  minzoom,
  maxzoom,
  threads,
}) {
  return [
    `-Xmx${heap}`,
    '-cp',
    jarPath,
    profilePath,
    `--osm_path=${osmPath}`,
    '--download=false',
    `--minzoom=${minzoom}`,
    `--maxzoom=${maxzoom}`,
    '--nodemap-type=array',
    '--nodemap-storage=mmap',
    '--storage=mmap',
    `--threads=${threads}`,
    `--tmpdir=${tmpDir}`,
    `--output=${outputPath}`,
    '--force',
  ];
}

export function pmtilesShowHeaderArgs(archivePath) {
  return ['show', '--header-json', archivePath];
}

export function pmtilesEditHeaderArgs(archivePath, headerPath) {
  return ['edit', archivePath, `--header-json=${headerPath}`];
}

export function pmtilesVerifyArgs(archivePath) {
  return ['verify', archivePath];
}

export function pmtilesShowArgs(archivePath) {
  return ['show', archivePath];
}

export function pmtilesMetadataArgs(archivePath) {
  return ['show', '--metadata', archivePath];
}

export function pmtilesTileArgs(archivePath, { z, x, y }) {
  return ['tile', archivePath, String(z), String(x), String(y)];
}
