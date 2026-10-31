import { readFile } from 'node:fs/promises';

import { beforeAll, describe, expect, it } from 'vitest';

import { deriveMinZoom, describeProfile, resolveProfile } from '../../../src/build/profiles.mjs';
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
      schema: 'build/profiles/pois.yml',
      layer: 'outdoor_pois',
    });
  });

  it('rejects an unknown profile', () => {
    expect(() => describeProfile('routes')).toThrow(BuildError);
  });

  it('resolves the committed profile file', async () => {
    const profile = await resolveProfile(process.cwd(), 'pois');

    expect(profile.layer).toBe('outdoor_pois');
    expect(profile.schemaPath).toMatch(/build\/profiles\/pois\.yml$/);
  });
});
