import { describe, expect, it } from 'vitest';

import {
  javaProfileArgs,
  javaVersionArgs,
  osmiumCatArgs,
  osmiumFileinfoArgs,
  osmiumTagsFilterArgs,
  osmiumVersionArgs,
  planetilerArgs,
  pmtilesEditHeaderArgs,
  pmtilesShowArgs,
  pmtilesShowHeaderArgs,
  pmtilesTileArgs,
  pmtilesVerifyArgs,
  pmtilesVersionArgs,
} from '../../../src/build/commands.mjs';

describe('command construction', () => {
  it('builds version and fileinfo commands', () => {
    expect(javaVersionArgs()).toEqual(['-version']);
    expect(osmiumVersionArgs()).toEqual(['--version']);
    expect(pmtilesVersionArgs()).toEqual(['version']);
    expect(osmiumFileinfoArgs('/data/planet.osm.pbf')).toEqual([
      'fileinfo',
      '-e',
      '/data/planet.osm.pbf',
    ]);
  });

  it('builds tags-filter and metadata-stripping commands', () => {
    expect(
      osmiumTagsFilterArgs({
        inputPath: '/data/planet.osm.pbf',
        expressionsPath: '/work/expressions.txt',
        outputPath: '/work/tagged.osm.pbf',
      }),
    ).toEqual([
      'tags-filter',
      '-O',
      '-e',
      '/work/expressions.txt',
      '-t',
      '/data/planet.osm.pbf',
      '-o',
      '/work/tagged.osm.pbf',
    ]);

    expect(
      osmiumCatArgs({
        inputPath: '/work/tagged.osm.pbf',
        outputPath: '/work/filtered.osm.pbf',
      }),
    ).toEqual([
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
      '/work/tagged.osm.pbf',
      '-o',
      '/work/filtered.osm.pbf',
    ]);
  });

  it('builds the Planetiler generate-custom command', () => {
    expect(
      planetilerArgs({
        jarPath: '/tools/planetiler.jar',
        schemaPath: '/repo/build/profiles/pois.yml',
        osmPath: '/work/filtered.osm.pbf',
        outputPath: '/dist/build/pois/current.pmtiles',
        tmpDir: '/work/planetiler-tmp',
        minzoom: 0,
        maxzoom: 16,
      }),
    ).toEqual([
      '-jar',
      '/tools/planetiler.jar',
      'generate-custom',
      '--schema=/repo/build/profiles/pois.yml',
      '--osm_path=/work/filtered.osm.pbf',
      '--output=/dist/build/pois/current.pmtiles',
      '--tmpdir=/work/planetiler-tmp',
      '--minzoom=0',
      '--maxzoom=16',
      '--force',
      '--use_wikidata=false',
    ]);
  });

  it('builds the Java source-file profile command', () => {
    expect(
      javaProfileArgs({
        heap: '2g',
        jarPath: '/tools/planetiler.jar',
        profilePath: '/repo/build/profiles/routes.java',
        osmPath: '/work/filtered.osm.pbf',
        outputPath: '/dist/build/routes/current.pmtiles',
        tmpDir: '/work/planetiler-tmp',
        minzoom: 8,
        maxzoom: 14,
        threads: 6,
      }),
    ).toEqual([
      '-Xmx2g',
      '-cp',
      '/tools/planetiler.jar',
      '/repo/build/profiles/routes.java',
      '--osm_path=/work/filtered.osm.pbf',
      '--download=false',
      '--minzoom=8',
      '--maxzoom=14',
      '--nodemap-type=array',
      '--nodemap-storage=mmap',
      '--storage=mmap',
      '--threads=6',
      '--tmpdir=/work/planetiler-tmp',
      '--output=/dist/build/routes/current.pmtiles',
      '--force',
    ]);
  });

  it('builds PMTiles inspection, editing and verification commands', () => {
    const archive = '/dist/build/pois/current.pmtiles';

    expect(pmtilesShowHeaderArgs(archive)).toEqual(['show', '--header-json', archive]);
    expect(pmtilesEditHeaderArgs(archive, '/work/header.json')).toEqual([
      'edit',
      archive,
      '--header-json=/work/header.json',
    ]);
    expect(pmtilesVerifyArgs(archive)).toEqual(['verify', archive]);
    expect(pmtilesShowArgs(archive)).toEqual(['show', archive]);
    expect(pmtilesTileArgs(archive, { z: 13, x: 1471, y: 2739 })).toEqual([
      'tile',
      archive,
      '13',
      '1471',
      '2739',
    ]);
  });
});
