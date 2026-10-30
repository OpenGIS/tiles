const FONT = ['Noto Sans Regular'];

const POI_COLOURS = {
  hut: '#7a4b2a',
  shelter: '#2f6f4e',
  viewpoint: '#1f5f8b',
};

const ROUTE_COLOURS = {
  hiking: '#1b7f4d',
  cycling: '#b3541e',
};

const PATH_COLOURS = {
  iwn: '#7b2d8e',
  nwn: '#b23c3c',
  rwn: '#2f6f9f',
  lwn: '#6b8e23',
};

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character],
  );
}

function safeHref(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

export function formatAttribution(attribution) {
  if (!Array.isArray(attribution)) {
    return '';
  }

  return attribution
    .map((entry) => {
      if (!entry || typeof entry.title !== 'string' || typeof entry.href !== 'string') {
        return null;
      }

      const href = safeHref(entry.href);
      if (!href) {
        return null;
      }

      return `<a href="${escapeHtml(href)}">${escapeHtml(entry.title)}</a>`;
    })
    .filter((entry) => entry !== null)
    .join(' · ');
}

function poiLayers(name, sourceLayer) {
  return [
    {
      id: `${name}-circle`,
      type: 'circle',
      source: name,
      'source-layer': sourceLayer,
      minzoom: 12,
      maxzoom: 16,
      paint: {
        'circle-color': [
          'match',
          ['get', 'kind'],
          ...Object.entries(POI_COLOURS).flat(),
          '#5b5b5b',
        ],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 3, 16, 7],
        'circle-stroke-width': 1,
        'circle-stroke-color': '#ffffff',
      },
    },
    {
      id: `${name}-labels`,
      type: 'symbol',
      source: name,
      'source-layer': sourceLayer,
      minzoom: 13.5,
      maxzoom: 16,
      layout: {
        'text-field': ['coalesce', ['get', 'name'], ''],
        'text-font': FONT,
        'text-size': ['interpolate', ['linear'], ['zoom'], 13.5, 11, 16, 13],
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
        'text-optional': true,
      },
      paint: {
        'text-color': '#1b1b1b',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.2,
      },
    },
  ];
}

function routeLayers(name, sourceLayer) {
  return [
    {
      id: `${name}-line`,
      type: 'line',
      source: name,
      'source-layer': sourceLayer,
      minzoom: 8,
      maxzoom: 14,
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
      },
      paint: {
        'line-color': [
          'match',
          ['get', 'activity'],
          ...Object.entries(ROUTE_COLOURS).flat(),
          '#555555',
        ],
        'line-width': ['interpolate', ['linear'], ['zoom'], 8, 1.2, 14, 4],
        'line-opacity': 0.85,
      },
    },
    {
      id: `${name}-labels`,
      type: 'symbol',
      source: name,
      'source-layer': sourceLayer,
      minzoom: 12,
      maxzoom: 14,
      layout: {
        'symbol-placement': 'line',
        'text-field': ['coalesce', ['get', 'name'], ''],
        'text-font': FONT,
        'text-size': 11,
        'text-max-angle': 30,
        'symbol-spacing': 300,
        'text-rotation-alignment': 'map',
        'text-pitch-alignment': 'map',
        'text-optional': true,
      },
      paint: {
        'text-color': '#1b1b1b',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.2,
      },
    },
  ];
}

function pathLayers(name, sourceLayer) {
  return [
    {
      id: `${name}-line`,
      type: 'line',
      source: name,
      'source-layer': sourceLayer,
      minzoom: 9,
      maxzoom: 13,
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
      },
      paint: {
        'line-color': [
          'match',
          ['get', 'network'],
          ...Object.entries(PATH_COLOURS).flat(),
          '#666666',
        ],
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1, 13, 3.5],
        'line-opacity': 0.85,
      },
    },
    {
      id: `${name}-labels`,
      type: 'symbol',
      source: name,
      'source-layer': sourceLayer,
      minzoom: 13,
      maxzoom: 13,
      layout: {
        'symbol-placement': 'line',
        'text-field': ['coalesce', ['get', 'name'], ''],
        'text-font': FONT,
        'text-size': 10,
        'text-max-angle': 30,
        'symbol-spacing': 250,
        'text-rotation-alignment': 'map',
        'text-pitch-alignment': 'map',
        'text-optional': true,
      },
      paint: {
        'text-color': '#1b1b1b',
        'text-halo-color': '#ffffff',
        'text-halo-width': 1.2,
      },
    },
  ];
}

export function buildLayers(name, sourceLayer) {
  if (!sourceLayer) {
    return [];
  }

  switch (name) {
    case 'pois':
      return poiLayers(name, sourceLayer);
    case 'routes':
      return routeLayers(name, sourceLayer);
    case 'paths':
      return pathLayers(name, sourceLayer);
    default:
      return [];
  }
}

function firstSymbolLayerId(map) {
  const layers = map.getStyle()?.layers ?? [];
  return layers.find((layer) => layer.type === 'symbol')?.id;
}

export function addLayers(map, name, sourceLayer) {
  const layers = buildLayers(name, sourceLayer);
  const beforeId = firstSymbolLayerId(map);

  for (const layer of layers) {
    map.addLayer(layer, beforeId);
  }
}

export function removeLayers(map, name) {
  const layers = map.getStyle()?.layers ?? [];

  for (const layer of layers) {
    if (layer.id.startsWith(`${name}-`) && map.getLayer(layer.id)) {
      map.removeLayer(layer.id);
    }
  }

  if (map.getSource(name)) {
    map.removeSource(name);
  }
}
