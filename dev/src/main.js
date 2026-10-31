import { Map, NavigationControl, addProtocol, setWorkerUrl } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { Protocol } from 'pmtiles';

import { addLayers, formatAttribution, removeLayers } from './layers.js';

const KNOWN_SOURCE_LAYERS = {
  pois: 'outdoor_pois',
  routes: 'outdoor_routes',
  paths: 'outdoor_paths',
  contours: 'contours',
};

const busy = new Set();

setWorkerUrl(maplibreWorkerUrl);
addProtocol('pmtiles', new Protocol().tile);

function setMapError(message) {
  document.body.dataset.mapError = message;
}

function describeMapError(event) {
  const error = event?.error ?? event;

  if (typeof error === 'string') {
    return error;
  }

  if (error && typeof error.message === 'string') {
    return error.message;
  }

  return 'Map rendering error';
}

async function fetchJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }

  return response.json();
}

function sourceStatus(label, text) {
  const status = document.createElement('span');
  status.className = 'status';
  status.textContent = text;
  status.setAttribute('aria-label', `${label}: ${text}`);
  return status;
}

function sourceLayerFor(tileJson, name) {
  const layers = Array.isArray(tileJson.vector_layers) ? tileJson.vector_layers : [];
  return layers[0]?.id ?? KNOWN_SOURCE_LAYERS[name];
}

async function addSource(map, source, checkbox) {
  const tileJsonUrl = source.tilejson || `/${source.name}.json`;
  const tileJson = await fetchJson(tileJsonUrl);
  const sourceLayer = sourceLayerFor(tileJson, source.name);

  if (!sourceLayer) {
    throw new Error(`No vector layer reported for ${source.name}`);
  }

  const options = {
    type: 'vector',
    url: tileJsonUrl,
    attribution: formatAttribution(source.attribution) || undefined,
  };

  if (Number.isFinite(source.minzoom)) {
    options.minzoom = source.minzoom;
  }

  if (Number.isFinite(source.maxzoom)) {
    options.maxzoom = source.maxzoom;
  }

  map.addSource(source.name, options);
  addLayers(map, source.name, sourceLayer);
  checkbox.disabled = false;

  if (source.kind === 'contour') {
    document.body.dataset.contourLayer = 'true';
  }
}

function removeSource(map, name) {
  removeLayers(map, name);
}

async function renderSources(map, sources) {
  const container = document.querySelector('#sources');

  if (!container) {
    return;
  }

  container.textContent = '';
  const list = document.createElement('ul');
  const fragment = document.createDocumentFragment();
  const autoSources = [];

  for (const source of sources) {
    const item = document.createElement('li');
    const label = document.createElement('label');
    const checkbox = document.createElement('input');

    checkbox.type = 'checkbox';
    checkbox.dataset.source = source.name;
    checkbox.disabled = !source.available;

    label.append(checkbox, document.createTextNode(` ${source.title}`));
    item.append(label);

    if (source.available) {
      item.append(sourceStatus(source.title, 'available'));
    } else {
      item.append(sourceStatus(source.title, 'unavailable'));
    }

    checkbox.addEventListener('change', async () => {
      if (busy.has(source.name)) {
        return;
      }

      busy.add(source.name);
      checkbox.disabled = true;

      try {
        if (checkbox.checked) {
          await addSource(map, source, checkbox);
        } else {
          removeSource(map, source.name);
        }
      } catch (error) {
        checkbox.checked = !checkbox.checked;
        removeSource(map, source.name);
        console.error(`Unable to toggle ${source.name}:`, error);
      } finally {
        busy.delete(source.name);
        checkbox.disabled = !source.available;
      }
    });

    if (source.available && source.kind === 'contour') {
      checkbox.checked = true;
      autoSources.push({ source, checkbox });
    }

    fragment.append(item);
  }

  list.append(fragment);
  container.append(list);

  for (const { source, checkbox } of autoSources) {
    busy.add(source.name);
    checkbox.disabled = true;

    try {
      await addSource(map, source, checkbox);
    } catch (error) {
      checkbox.checked = false;
      removeSource(map, source.name);
      console.error(`Unable to add ${source.name}:`, error);
    } finally {
      busy.delete(source.name);
      checkbox.disabled = !source.available;
    }
  }
}

async function loadSources(map) {
  const container = document.querySelector('#sources');

  try {
    const payload = await fetchJson('/sources');
    const sources = Array.isArray(payload.sources) ? payload.sources : [];
    await renderSources(map, sources);
  } catch (error) {
    if (container) {
      container.textContent = 'Tile server unavailable';
    }
    console.error('Unable to load the source catalogue:', error);
  } finally {
    container?.setAttribute('data-sources-ready', 'true');
  }
}

async function start() {
  let style;

  try {
    style = await fetchJson('/style.json');
    style.sources.openmaptiles.url = `pmtiles://${location.origin}/canmore.pmtiles`;

    if (typeof style.sprite === 'string' && style.sprite.startsWith('/')) {
      style.sprite = `${location.origin}${style.sprite}`;
    }

    if (typeof style.glyphs === 'string' && style.glyphs.startsWith('/')) {
      style.glyphs = `${location.origin}${style.glyphs}`;
    }

    const basemapAttribution = style.sources.attribution?.attribution;
    if (basemapAttribution) {
      style.sources.openmaptiles.attribution = basemapAttribution;
      delete style.sources.attribution;
    }
  } catch (error) {
    setMapError(`Unable to load the basemap style: ${error.message}`);
    return;
  }

  const map = new Map({
    container: 'map',
    style,
    center: [-115.35, 51.15],
    zoom: 12,
    maxZoom: 16,
    attributionControl: true,
  });

  map.addControl(new NavigationControl(), 'top-left');

  map.on('idle', () => {
    document.body.dataset.mapReady = 'true';
  });

  map.on('error', (event) => {
    setMapError(describeMapError(event));
  });

  await loadSources(map);
}

start().catch((error) => {
  setMapError(`Unable to start the harness: ${error.message}`);
  console.error(error);
});
