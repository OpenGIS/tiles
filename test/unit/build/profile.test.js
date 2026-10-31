import { readFile } from 'node:fs/promises';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  deriveMinZoom,
  describeProfile,
  profileNames,
  resolveProfile,
} from '../../../src/build/profiles.mjs';
import { BuildError } from '../../../src/build/errors.mjs';

let schema;

beforeAll(async () => {
  schema = await readFile('build/profiles/pois.yml', 'utf8');
});

describe('POI profile', () => {
  it('declares the outdoor_pois layer with eighteen centroid rules', () => {
    expect(schema).toContain('id: outdoor_pois');
    expect(schema.match(/- source: osm/g)).toHaveLength(18);
    expect(schema.match(/geometry: centroid/g)).toHaveLength(18);
  });

  it('builds every rule from zoom 12', () => {
    expect(schema.match(/min_zoom: 12/g)).toHaveLength(18);
    expect(deriveMinZoom(schema)).toBe(12);
  });

  it('emits kind, name and ele attributes', () => {
    expect(schema.match(/key: kind/g)).toHaveLength(18);
    expect(schema.match(/key: name/g)).toHaveLength(18);
    expect(schema.match(/key: ele/g)).toHaveLength(18);
  });

  it('maps every configured expression to a rule', () => {
    const expectedKinds = [
      'hut',
      'shelter',
      'viewpoint',
      'campsite',
      'picnic_site',
      'drinking_water',
      'trailhead',
      'pass',
      'ranger_station',
      'castle',
      'information',
      'parking',
      'park',
      'toilets',
      'playground',
      'ferry',
      'lighthouse',
      'skiing',
    ];

    for (const kind of expectedKinds) {
      expect(schema).toContain(`value: ${kind}`);
    }
  });
});

describe('Java profiles', () => {
  it('declares the outdoor_routes source layer and activity contract', async () => {
    const source = await readFile('build/profiles/routes.java', 'utf8');

    expect(source).toContain('class Routes implements Profile');
    expect(source).toContain('features.line("outdoor_routes")');
    expect(source).toContain('setZoomRange(8, 14)');
    expect(source).toContain('setMinPixelSize(0)');
    expect(source).toContain('FeatureMerge.mergeLineStrings');
    expect(source).toContain('setAttr("activities"');
    expect(source).toContain('type", "route", "superroute"');
    expect(source).toContain('"hiking", "foot", "walking"');
    expect(source).toContain('"bicycle"');
    expect(source).toContain('network:type", "node_network"');
  });

  it('declares the outdoor_paths source layer and the lwn network fix', async () => {
    const source = await readFile('build/profiles/paths.java', 'utf8');

    expect(source).toContain('class Paths implements Profile');
    expect(source).toContain('features.line("outdoor_paths")');
    expect(source).toContain('setZoomRange(minZoom, 13)');
    expect(source).toContain('setMinPixelSize(0)');
    expect(source).toContain('FeatureMerge.mergeLineStrings');
    expect(source).toContain('h.equals("path")');
    expect(source).toContain('h.equals("footway")');
    expect(source).toContain('h.equals("track")');
    expect(source).toContain('case "lwn" -> 12;');
    expect(source).toContain('if (network != null)');
  });
});

describe('deriveMinZoom', () => {
  it('returns the lowest declared min_zoom', () => {
    expect(deriveMinZoom('min_zoom: 12\nmin_zoom: 8\n')).toBe(8);
  });

  it('returns null when no min_zoom is declared', () => {
    expect(deriveMinZoom('id: outdoor_pois\n')).toBeNull();
  });
});

describe('profile registry', () => {
  it('describes the pois profile', () => {
    expect(describeProfile('pois')).toEqual({
      kind: 'yaml',
      file: 'build/profiles/pois.yml',
      layer: 'outdoor_pois',
    });
  });

  it('describes the Java profiles', () => {
    expect(describeProfile('routes')).toEqual({
      kind: 'java',
      file: 'build/profiles/routes.java',
      layer: 'outdoor_routes',
    });
    expect(describeProfile('paths')).toEqual({
      kind: 'java',
      file: 'build/profiles/paths.java',
      layer: 'outdoor_paths',
    });
    expect(profileNames()).toEqual(['pois', 'routes', 'paths']);
  });

  it('uses the registry kind and file by default', async () => {
    const profile = await resolveProfile(process.cwd(), 'routes');

    expect(profile.kind).toBe('java');
    expect(profile.file).toBe('build/profiles/routes.java');
    expect(profile.layer).toBe('outdoor_routes');
    expect(profile.heap).toBe('2g');
    expect(profile.filePath).toMatch(/build\/profiles\/routes\.java$/);
  });

  it('applies configured overrides', async () => {
    const profile = await resolveProfile(process.cwd(), 'paths', {
      profileKind: 'java',
      profileFile: 'build/profiles/paths.java',
      heap: '512m',
    });

    expect(profile).toMatchObject({
      kind: 'java',
      file: 'build/profiles/paths.java',
      heap: '512m',
    });
  });

  it('rejects an unknown profile', () => {
    expect(() => describeProfile('unknown')).toThrow(BuildError);
  });

  it('rejects a missing profile file', async () => {
    await expect(
      resolveProfile(process.cwd(), 'paths', { profileFile: 'build/profiles/missing.java' }),
    ).rejects.toThrow(/not found/);
  });

  it('rejects an unknown profile kind override', async () => {
    await expect(resolveProfile(process.cwd(), 'paths', { profileKind: 'kotlin' })).rejects.toThrow(
      /unknown kind/,
    );
  });

  it('resolves the committed POI profile file', async () => {
    const profile = await resolveProfile(process.cwd(), 'pois');

    expect(profile.layer).toBe('outdoor_pois');
    expect(profile.filePath).toMatch(/build\/profiles\/pois\.yml$/);
  });
});
