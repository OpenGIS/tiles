import { describe, expect, it } from 'vitest';

import { buildLayers, formatAttribution } from '../../dev/src/layers.js';

describe('buildLayers', () => {
  it('builds POI circle and label layers', () => {
    const layers = buildLayers('pois', 'outdoor_pois');

    expect(layers.map((layer) => layer.id)).toEqual(['pois-circle', 'pois-labels']);
    expect(layers.every((layer) => layer.source === 'pois')).toBe(true);
    expect(layers.every((layer) => layer['source-layer'] === 'outdoor_pois')).toBe(true);

    expect(layers[0]).toMatchObject({
      type: 'circle',
      minzoom: 12,
      maxzoom: 16,
    });
    expect(layers[0].paint['circle-color']).toBeInstanceOf(Array);
    expect(layers[0].paint['circle-radius']).toBeInstanceOf(Array);

    expect(layers[1]).toMatchObject({
      type: 'symbol',
      minzoom: 13.5,
      maxzoom: 16,
    });
    expect(layers[1].layout['text-font']).toEqual(['Noto Sans Regular']);
    expect(layers[1].layout['text-field']).toEqual(['coalesce', ['get', 'name'], '']);
  });

  it('builds route line and label layers', () => {
    const layers = buildLayers('routes', 'outdoor_routes');

    expect(layers.map((layer) => layer.id)).toEqual(['routes-line', 'routes-labels']);
    expect(layers[0]).toMatchObject({
      type: 'line',
      minzoom: 8,
      maxzoom: 14,
    });
    expect(layers[0].paint['line-color']).toBeInstanceOf(Array);
    expect(layers[0].paint['line-width']).toBeInstanceOf(Array);

    expect(layers[1]).toMatchObject({
      type: 'symbol',
      minzoom: 12,
      maxzoom: 14,
    });
    expect(layers[1].layout['symbol-placement']).toBe('line');
    expect(layers[1].layout['text-font']).toEqual(['Noto Sans Regular']);
  });

  it('builds path line and label layers', () => {
    const layers = buildLayers('paths', 'outdoor_paths');

    expect(layers.map((layer) => layer.id)).toEqual(['paths-line', 'paths-labels']);
    expect(layers[0]).toMatchObject({
      type: 'line',
      minzoom: 9,
      maxzoom: 13,
    });
    expect(layers[0].paint['line-color']).toBeInstanceOf(Array);
    expect(layers[0].paint['line-width']).toBeInstanceOf(Array);

    expect(layers[1]).toMatchObject({
      type: 'symbol',
      minzoom: 13,
      maxzoom: 13,
    });
    expect(layers[1].layout['text-font']).toEqual(['Noto Sans Regular']);
  });

  it('returns no layers for an unknown source', () => {
    expect(buildLayers('unknown', 'some_layer')).toEqual([]);
  });

  it('returns no layers without a source layer', () => {
    expect(buildLayers('pois', null)).toEqual([]);
  });
});

describe('formatAttribution', () => {
  it('escapes titles and only renders http(s) links', () => {
    expect(
      formatAttribution([
        { title: 'A & <B>', href: 'https://example.com/?a=1&b=2' },
        { title: 'Unsafe', href: 'javascript:alert(1)' },
      ]),
    ).toBe('<a href="https://example.com/?a=1&amp;b=2">A &amp; &lt;B&gt;</a>');
  });

  it('returns an empty string for empty or invalid input', () => {
    expect(formatAttribution([])).toBe('');
    expect(formatAttribution(undefined)).toBe('');
    expect(formatAttribution([{ title: 'Missing href' }])).toBe('');
  });
});
