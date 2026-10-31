import { execFile as execFileCallback } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';

import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { javaProfileArgs } from '../../src/build/commands.mjs';
import { ensurePlanetiler } from '../../src/build/tools.mjs';
import { PmtilesReader } from '../../src/lib/pmtiles.mjs';
import { createTempDirectory, removeTempDirectory, repoRoot } from '../helpers/temp.mjs';

const execFile = promisify(execFileCallback);

const SAMPLE_ZOOM = 14;
const SAMPLE_LON = -115.35;
const SAMPLE_LAT = 51.15;

const OSM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="ogis-tiles-test">
  <node id="1" lat="51.1500" lon="-115.3500"/>
  <node id="2" lat="51.1502" lon="-115.3498"/>
  <node id="3" lat="51.1504" lon="-115.3496"/>
  <node id="4" lat="51.1506" lon="-115.3494"/>
  <node id="5" lat="51.1508" lon="-115.3492"/>
  <way id="10">
    <nd ref="1"/><nd ref="2"/>
    <tag k="highway" v="path"/>
    <tag k="name" v="Dual Activity Path"/>
  </way>
  <way id="11">
    <nd ref="2"/><nd ref="3"/>
    <tag k="highway" v="path"/>
    <tag k="name" v="Proposed Cycling Path"/>
  </way>
  <way id="12">
    <nd ref="3"/><nd ref="4"/>
    <tag k="highway" v="path"/>
    <tag k="name" v="Node Network Cycling Path"/>
  </way>
  <way id="13">
    <nd ref="4"/><nd ref="5"/>
    <tag k="highway" v="path"/>
    <tag k="name" v="Proposed Dual Path"/>
  </way>
  <way id="14">
    <nd ref="1"/><nd ref="5"/>
    <tag k="highway" v="path"/>
    <tag k="name" v="Semicolon Cycling Path"/>
  </way>
  <relation id="100">
    <member type="way" ref="10" role=""/>
    <tag k="type" v="route"/>
    <tag k="route" v="hiking;bicycle"/>
    <tag k="network" v="ncn"/>
    <tag k="name" v="Dual Activity Route"/>
  </relation>
  <relation id="101">
    <member type="way" ref="11" role=""/>
    <tag k="type" v="route"/>
    <tag k="route" v="bicycle"/>
    <tag k="network" v="ncn"/>
    <tag k="state" v="proposed"/>
    <tag k="name" v="Proposed Cycling Route"/>
  </relation>
  <relation id="102">
    <member type="way" ref="12" role=""/>
    <tag k="type" v="route"/>
    <tag k="route" v="bicycle"/>
    <tag k="network" v="lcn"/>
    <tag k="network:type" v="node_network"/>
    <tag k="name" v="Node Network Route"/>
  </relation>
  <relation id="103">
    <member type="way" ref="13" role=""/>
    <tag k="type" v="route"/>
    <tag k="route" v="hiking;bicycle"/>
    <tag k="network" v="lwn"/>
    <tag k="state" v="proposed"/>
    <tag k="name" v="Proposed Dual Route"/>
  </relation>
  <relation id="104">
    <member type="way" ref="14" role=""/>
    <tag k="type" v="route"/>
    <tag k="route" v="bicycle;canoe"/>
    <tag k="network" v="ncn;npn"/>
    <tag k="name" v="Semicolon Cycling Route"/>
  </relation>
</osm>
`;

function lonToTileX(lon, zoom) {
  return Math.floor(((lon + 180) / 360) * 2 ** zoom);
}

function latToTileY(lat, zoom) {
  const radians = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) * 2 ** zoom,
  );
}

async function decodeRouteTile(archivePath) {
  const reader = new PmtilesReader(archivePath);

  try {
    await reader.open();
    const tile = await reader.getTile(
      SAMPLE_ZOOM,
      lonToTileX(SAMPLE_LON, SAMPLE_ZOOM),
      latToTileY(SAMPLE_LAT, SAMPLE_ZOOM),
    );
    expect(tile).not.toBeNull();

    const data = tile.compression === 'gzip' ? gunzipSync(tile.data) : tile.data;
    const layer = new VectorTile(new PbfReader(data)).layers.outdoor_routes;
    expect(layer).toBeDefined();

    const features = [];
    for (let index = 0; index < layer.length; index += 1) {
      const feature = layer.feature(index);
      features.push({ type: feature.type, properties: feature.properties });
    }

    return features;
  } finally {
    await reader.close();
  }
}

function byName(features, name) {
  return features.filter((feature) => feature.properties.name === name);
}

let tempDir;
let features;

beforeAll(async () => {
  tempDir = await createTempDirectory('tiles-dual-routes-');
  const osmPath = path.join(tempDir, 'dual.osm');
  const pbfPath = path.join(tempDir, 'dual.osm.pbf');
  const archivePath = path.join(tempDir, 'outdoor_routes.pmtiles');
  const planetilerTmpDir = path.join(tempDir, 'planetiler-tmp');
  const config = JSON.parse(await readFile(path.join(repoRoot, 'config', 'layers.json'), 'utf8'));

  await writeFile(osmPath, OSM_XML, 'utf8');
  await execFile('osmium', ['cat', '-o', pbfPath, osmPath], { cwd: repoRoot });

  const planetiler = await ensurePlanetiler({
    planetiler: config.build.tools.planetiler,
    toolsDir: path.join(repoRoot, 'tmp', 'tools'),
  });

  await execFile(
    'java',
    javaProfileArgs({
      heap: '512m',
      jarPath: planetiler.path,
      profilePath: path.join(repoRoot, 'build', 'profiles', 'routes.java'),
      osmPath: pbfPath,
      outputPath: archivePath,
      tmpDir: planetilerTmpDir,
      minzoom: 8,
      maxzoom: 14,
      threads: 2,
    }),
    { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024, timeout: 120000 },
  );

  features = await decodeRouteTile(archivePath);
}, 180000);

afterAll(async () => {
  if (tempDir) {
    await removeTempDirectory(tempDir);
  }
});

describe('routes profile dual-activity contract', () => {
  it('emits one feature per activity with the full activity set in priority order', () => {
    const dual = byName(features, 'Dual Activity Route');

    expect(dual).toHaveLength(2);
    expect(dual.map((feature) => feature.properties.activity).sort()).toEqual([
      'cycling',
      'hiking',
    ]);

    for (const feature of dual) {
      expect(feature.type).toBe(2);
      expect(feature.properties.activities).toBe('hiking;cycling');
      expect(feature.properties.activities.split(';')).toContain(feature.properties.activity);
    }

    expect(
      dual.find((feature) => feature.properties.activity === 'cycling').properties.network,
    ).toBe('ncn');
    expect(
      dual.find((feature) => feature.properties.activity === 'hiking').properties.network,
    ).toBeUndefined();
  });

  it('applies cycling exclusions per activity while keeping a surviving hiking activity', () => {
    expect(byName(features, 'Proposed Cycling Route')).toEqual([]);
    expect(byName(features, 'Node Network Route')).toEqual([]);

    const proposedDual = byName(features, 'Proposed Dual Route');

    expect(proposedDual).toHaveLength(1);
    expect(proposedDual[0].properties).toMatchObject({
      activity: 'hiking',
      activities: 'hiking',
      network: 'lwn',
    });
  });

  it('matches semicolon route tokens and keeps the network value whole', () => {
    const semicolon = byName(features, 'Semicolon Cycling Route');

    expect(semicolon).toHaveLength(1);
    expect(semicolon[0].properties).toMatchObject({
      activity: 'cycling',
      activities: 'cycling',
    });
    expect(semicolon[0].properties.network).toBeUndefined();
  });
});
