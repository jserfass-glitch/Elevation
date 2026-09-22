import * as maplibregl from 'https://cdn.jsdelivr.net/npm/maplibre-gl@6.10.0/dist/maplibre-gl.mjs';
import { sunPosition, sunTimes } from './sun.js';
import { ShadowRenderer } from './shadow.js';

// Time zone of the map location, so the time slider reads in local time there.
const tzLookup = import('https://cdn.jsdelivr.net/npm/@photostructure/tz-lookup@11.7.0/+esm')
  .then((m) => m.default)
  .catch(() => null);

// AWS Open Data terrain tiles (Terrarium encoding): elevation in meters =
// R * 256 + G + B / 256 - 32768.
const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const DEM_MAX_ZOOM = 15;
const DEM_TILE_SIZE = 256;
const M_TO_FT = 3.28084;

// Low-to-high ramp applied from the threshold up to the highest point in view.
const RAMP = ['#ffffb2', '#fecc5c', '#fd8d3c', '#f03b20', '#bd0026'];

const BASEMAPS = {
  usgs: {
    tiles: ['https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}'],
    maxzoom: 16,
    attribution: 'USGS The National Map',
  },
  opentopo: {
    tiles: ['https://tile.opentopomap.org/{z}/{x}/{y}.png'],
    maxzoom: 17,
    attribution: '© <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA), © OpenStreetMap contributors',
  },
  streets: {
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    maxzoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
  imagery: {
    tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
    maxzoom: 19,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
  },
};

const ROADS_TILES = [
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
];

const $ = (id) => document.getElementById(id);
const ui = {
  panel: $('panel'),
  collapse: $('collapse'),
  threshold: $('threshold'),
  thresholdValue: $('threshold-value'),
  rangeMin: $('range-min'),
  rangeMax: $('range-max'),
  peak: $('peak'),
  status: $('status'),
  opacity: $('opacity'),
  shade: $('ov-shade'),
  hillshade: $('ov-hillshade'),
  roads: $('ov-roads'),
  cursor: $('cursor'),
  sun: $('ov-sun'),
  sunSection: $('sun-section'),
  sunDate: $('sun-date'),
  sunTime: $('sun-time'),
  sunTimeValue: $('sun-time-value'),
  sunPlay: $('sun-play'),
  sunrise: $('sunrise'),
  sunset: $('sunset'),
  sunInfo: $('sun-info'),
};

const state = {
  units: 'ft',
  min: null, // meters, lowest point in view
  max: null, // meters, highest point in view
  peak: null, // [lng, lat] of the highest point in view
  threshold: null, // meters; null means "at minimum", shade everything
  statsZoom: 0,
};

// ---------- Map ----------

const sources = {
  dem: {
    type: 'raster-dem',
    tiles: [DEM_URL],
    encoding: 'terrarium',
    tileSize: DEM_TILE_SIZE,
    maxzoom: DEM_MAX_ZOOM,
    attribution: 'Terrain: <a href="https://registry.opendata.aws/terrain-tiles/">Mapzen/AWS Terrain Tiles</a>',
  },
  roads: { type: 'raster', tiles: [ROADS_TILES[0]], tileSize: 256, maxzoom: 19, attribution: '© Esri' },
  places: { type: 'raster', tiles: [ROADS_TILES[1]], tileSize: 256, maxzoom: 19 },
  sun: {
    type: 'canvas',
    canvas: Object.assign(document.createElement('canvas'), { width: 1, height: 1 }),
    coordinates: [[-100, 40], [-99, 40], [-99, 39], [-100, 39]],
    animate: false,
  },
};
const layers = [];
for (const [id, b] of Object.entries(BASEMAPS)) {
  sources[`base-${id}`] = { type: 'raster', tiles: b.tiles, tileSize: 256, maxzoom: b.maxzoom, attribution: b.attribution };
  layers.push({ id: `base-${id}`, type: 'raster', source: `base-${id}`, layout: { visibility: id === 'usgs' ? 'visible' : 'none' } });
}
layers.push(
  {
    id: 'hillshade',
    type: 'hillshade',
    source: 'dem',
    paint: { 'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#3a3a3a' },
  },
  {
    id: 'elevation-shading',
    type: 'color-relief',
    source: 'dem',
    paint: { 'color-relief-opacity': Number(ui.opacity.value), 'color-relief-color': reliefExpression() },
  },
  {
    id: 'sun',
    type: 'raster',
    source: 'sun',
    layout: { visibility: 'none' },
    paint: { 'raster-opacity': Number(ui.opacity.value), 'raster-fade-duration': 0 },
  },
  { id: 'roads', type: 'raster', source: 'roads', layout: { visibility: 'none' } },
  { id: 'places', type: 'raster', source: 'places', layout: { visibility: 'none' } },
);

const map = new maplibregl.Map({
  container: 'map',
  style: { version: 8, sources, layers },
  center: [-98.5, 39.5],
  zoom: 3.6,
  maxZoom: 17,
  dragRotate: false,
  pitchWithRotate: false,
  touchPitch: false,
  hash: true,
});
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-right');

const peakMarker = new maplibregl.Marker({ element: Object.assign(document.createElement('div'), { className: 'peak-marker', title: 'Highest point in view' }) });

// ---------- Elevation shading ----------

// Colors everything at or above the threshold, ramping up to the highest point
// in view. Below the threshold is transparent.
function reliefExpression() {
  const lo = state.min ?? 0;
  const hi = state.max ?? 4500;
  const start = state.threshold == null ? lo : Math.max(state.threshold, lo);
  const end = Math.max(hi, start + 1);
  const expr = ['interpolate', ['linear'], ['elevation']];
  if (state.threshold == null) {
    // Slider at minimum: shade everything, including anything below the sampled minimum.
    expr.push(-12000, RAMP[0]);
  } else {
    expr.push(start - 0.5, 'rgba(0,0,0,0)');
  }
  RAMP.forEach((color, i) => {
    const stop = start + ((end - start) * i) / (RAMP.length - 1);
    // Stops must be strictly increasing.
    expr.push(i === 0 && state.threshold == null ? Math.max(stop, -11999) : stop, color);
  });
  return expr;
}

let pendingPaint = false;
function updateShading() {
  if (pendingPaint) return;
  pendingPaint = true;
  requestAnimationFrame(() => {
    pendingPaint = false;
    map.setPaintProperty('elevation-shading', 'color-relief-color', reliefExpression());
  });
}

// ---------- Viewport elevation statistics ----------
// MapLibre does not expose decoded DEM data, so we fetch the same terrain tiles
// at a coarser zoom and scan the pixels inside the current view.

const tileCache = new Map(); // key "z/x/y" -> Promise<Float32Array|null>
const TILE_CACHE_LIMIT = 150;
const MAX_STATS_TILES = 16;

function loadTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  let entry = tileCache.get(key);
  if (entry) {
    tileCache.delete(key); // refresh LRU position
    tileCache.set(key, entry);
    return entry;
  }
  entry = fetch(DEM_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y))
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(r.status))))
    .then((blob) => createImageBitmap(blob))
    .then((bmp) => {
      const canvas = new OffscreenCanvas(DEM_TILE_SIZE, DEM_TILE_SIZE);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      const px = ctx.getImageData(0, 0, DEM_TILE_SIZE, DEM_TILE_SIZE).data;
      const elev = new Float32Array(DEM_TILE_SIZE * DEM_TILE_SIZE);
      for (let i = 0; i < elev.length; i++) {
        elev[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768;
      }
      return elev;
    })
    .catch(() => {
      tileCache.delete(key);
      return null;
    });
  tileCache.set(key, entry);
  while (tileCache.size > TILE_CACHE_LIMIT) tileCache.delete(tileCache.keys().next().value);
  return entry;
}

const MAX_LAT = 85.0511;
const lngToX = (lng, n) => ((lng + 180) / 360) * n;
function latToY(lat, n) {
  const r = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
}
const xToLng = (x, n) => (x / n) * 360 - 180;
const yToLat = (y, n) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;

function viewTileRange(z) {
  const b = map.getBounds();
  const n = 2 ** z;
  const fx0 = lngToX(b.getWest(), n);
  const fx1 = lngToX(b.getEast(), n);
  const fy0 = Math.max(0, latToY(b.getNorth(), n));
  const fy1 = Math.min(n, latToY(b.getSouth(), n));
  return { n, fx0, fx1, fy0, fy1, x0: Math.floor(fx0), x1: Math.ceil(fx1) - 1, y0: Math.floor(fy0), y1: Math.ceil(fy1) - 1 };
}

let statsRun = 0;
async function computeViewStats() {
  const run = ++statsRun;
  // Start near screen resolution and back off until the tile count is reasonable.
  let z = Math.min(DEM_MAX_ZOOM, Math.max(0, Math.floor(map.getZoom()) + 1));
  let r = viewTileRange(z);
  while (z > 0 && (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1) > MAX_STATS_TILES) {
    z--;
    r = viewTileRange(z);
  }
  ui.status.textContent = 'Scanning…';

  const jobs = [];
  for (let ty = r.y0; ty <= r.y1; ty++) {
    for (let tx = r.x0; tx <= r.x1; tx++) {
      const wx = ((tx % r.n) + r.n) % r.n; // wrap across the antimeridian
      jobs.push(loadTile(z, wx, ty).then((elev) => ({ tx, ty, elev })));
    }
  }
  const tiles = await Promise.all(jobs);
  if (run !== statsRun) return; // a newer pan/zoom superseded this one

  let min = Infinity;
  let max = -Infinity;
  let peak = null;
  const S = DEM_TILE_SIZE;
  for (const { tx, ty, elev } of tiles) {
    if (!elev) continue;
    const px0 = Math.max(0, Math.floor((r.fx0 - tx) * S));
    const px1 = Math.min(S, Math.ceil((r.fx1 - tx) * S));
    const py0 = Math.max(0, Math.floor((r.fy0 - ty) * S));
    const py1 = Math.min(S, Math.ceil((r.fy1 - ty) * S));
    for (let py = py0; py < py1; py++) {
      const row = py * S;
      for (let px = px0; px < px1; px++) {
        const e = elev[row + px];
        if (e < min) min = e;
        if (e > max) {
          max = e;
          peak = [tx + (px + 0.5) / S, ty + (py + 0.5) / S];
        }
      }
    }
  }
  ui.status.textContent = '';
  if (!Number.isFinite(min)) {
    ui.status.textContent = 'No terrain data';
    return;
  }

  state.statsZoom = z;
  state.min = min;
  state.max = max;
  state.peak = [xToLng(peak[0], r.n), yToLat(peak[1], r.n)];
  // Keep an absolute threshold across pans; drop it if it now falls below the view minimum.
  if (state.threshold != null && state.threshold <= min) state.threshold = null;
  if (state.threshold != null && state.threshold > max) state.threshold = max;
  syncSlider();
  updateShading();

  peakMarker.setLngLat(state.peak).addTo(map);
}

// ---------- UI ----------

const toUnits = (m) => (state.units === 'ft' ? m * M_TO_FT : m);
const fromUnits = (v) => (state.units === 'ft' ? v / M_TO_FT : v);
const fmt = (m) => `${Math.round(toUnits(m)).toLocaleString()} ${state.units}`;

function syncSlider() {
  if (state.min == null) return;
  const lo = Math.floor(toUnits(state.min));
  const hi = Math.ceil(toUnits(state.max));
  const span = Math.max(1, hi - lo);
  const s = ui.threshold;
  s.disabled = false;
  s.min = lo;
  s.max = hi;
  s.step = span > 2000 ? 10 : 1;
  s.value = state.threshold == null ? lo : toUnits(state.threshold);
  ui.rangeMin.textContent = fmt(state.min);
  ui.rangeMax.textContent = fmt(state.max);
  ui.thresholdValue.textContent = state.threshold == null ? 'everything' : fmt(state.threshold);
  ui.peak.disabled = false;
  ui.peak.textContent = `Highest in view: ${fmt(state.max)}`;
}

ui.threshold.addEventListener('input', () => {
  const v = Number(ui.threshold.value);
  state.threshold = v <= Number(ui.threshold.min) ? null : fromUnits(v);
  ui.thresholdValue.textContent = state.threshold == null ? 'everything' : fmt(state.threshold);
  updateShading();
});

ui.peak.addEventListener('click', () => {
  if (state.peak) map.flyTo({ center: state.peak, zoom: Math.max(map.getZoom(), 12) });
});

ui.opacity.addEventListener('input', () => {
  map.setPaintProperty('elevation-shading', 'color-relief-opacity', Number(ui.opacity.value));
  map.setPaintProperty('sun', 'raster-opacity', Number(ui.opacity.value));
});

const setVisible = (id, on) => map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
ui.shade.addEventListener('change', () => {
  setVisible('elevation-shading', ui.shade.checked);
  if (state.peak) {
    if (ui.shade.checked) peakMarker.addTo(map);
    else peakMarker.remove();
  }
});
ui.hillshade.addEventListener('change', () => setVisible('hillshade', ui.hillshade.checked));
ui.roads.addEventListener('change', () => {
  setVisible('roads', ui.roads.checked);
  setVisible('places', ui.roads.checked);
});

document.querySelectorAll('input[name=base]').forEach((el) =>
  el.addEventListener('change', () => {
    for (const id of Object.keys(BASEMAPS)) setVisible(`base-${id}`, id === el.value);
  }),
);

document.querySelectorAll('input[name=units]').forEach((el) =>
  el.addEventListener('change', () => {
    state.units = el.value;
    syncSlider();
    showCursor(lastCursor);
  }),
);

ui.collapse.addEventListener('click', () => {
  const collapsed = ui.panel.classList.toggle('collapsed');
  ui.collapse.textContent = collapsed ? '+' : '–';
  ui.collapse.setAttribute('aria-expanded', String(!collapsed));
});

// Elevation under the cursor, read from the tiles already fetched for the stats.
let lastCursor = null;
async function showCursor(lngLat) {
  lastCursor = lngLat;
  if (!lngLat) return;
  const z = state.statsZoom;
  const n = 2 ** z;
  const fx = lngToX(lngLat.lng, n);
  const fy = latToY(lngLat.lat, n);
  const tx = Math.floor(fx);
  const ty = Math.floor(fy);
  const key = `${z}/${((tx % n) + n) % n}/${ty}`;
  const entry = tileCache.get(key);
  const elev = entry && (await entry);
  if (lastCursor !== lngLat) return;
  if (!elev) {
    ui.cursor.textContent = 'Hover the map for elevation.';
    return;
  }
  const px = Math.min(DEM_TILE_SIZE - 1, Math.floor((fx - tx) * DEM_TILE_SIZE));
  const py = Math.min(DEM_TILE_SIZE - 1, Math.floor((fy - ty) * DEM_TILE_SIZE));
  const e = elev[py * DEM_TILE_SIZE + px];
  ui.cursor.textContent = `Cursor: ${fmt(e)}  (${lngLat.lat.toFixed(4)}, ${lngLat.lng.toFixed(4)})`;
}
map.on('mousemove', (e) => showCursor(e.lngLat));
map.on('click', (e) => showCursor(e.lngLat));

// ---------- Sun exposure ----------

const sun = {
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  lat: 0,
  lng: 0,
  times: null,
  time: null, // ms since epoch shown on the slider
  playTimer: null,
};
const MIN_MS = 60000;
const MARGIN_MS = 20 * MIN_MS; // slider starts this long before sunrise and ends after sunset
let shadowRenderer = null;

const formatTime = (ms, withZone = false) =>
  new Intl.DateTimeFormat([], { timeZone: sun.tz, hour: 'numeric', minute: '2-digit', ...(withZone && { timeZoneName: 'short' }) })
    .format(new Date(ms));
const todayIn = (tz) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// Recomputes sunrise/sunset for the view center and the chosen date, keeping
// the slider at the same offset from solar noon.
async function updateSunRange() {
  const c = map.getCenter();
  const lookup = await tzLookup;
  try {
    if (lookup) sun.tz = lookup(c.lat, c.lng);
  } catch {
    // outside any zone polygon: keep the previous zone
  }
  if (!ui.sunDate.value) ui.sunDate.value = todayIn(sun.tz);
  const [y, m, d] = ui.sunDate.value.split('-').map(Number);
  // Roughly local noon on the chosen date, so the lookup lands on that solar day.
  const ref = new Date(Date.UTC(y, m - 1, d, 12) - (c.lng / 15) * 3600000);
  const prev = sun.times;
  const times = sunTimes(ref, c.lat, c.lng);
  const noon = times.noon.getTime();
  const lo = times.sunrise ? times.sunrise.getTime() - MARGIN_MS : noon - 12 * 3600000;
  const hi = times.sunset ? times.sunset.getTime() + MARGIN_MS : noon + 12 * 3600000;

  let t;
  if (sun.time != null && prev) t = noon + (sun.time - prev.noon.getTime());
  else t = Date.now() >= lo && Date.now() <= hi && ui.sunDate.value === todayIn(sun.tz) ? Date.now() : noon;
  sun.lat = c.lat;
  sun.lng = c.lng;
  sun.times = times;
  sun.time = Math.min(hi, Math.max(lo, t));

  const s = ui.sunTime;
  s.min = Math.floor(lo / MIN_MS);
  s.max = Math.ceil(hi / MIN_MS);
  s.step = 1;
  s.value = Math.round(sun.time / MIN_MS);
  if (times.polar) {
    ui.sunrise.textContent = times.polar === 'day' ? 'Sun up all day' : 'Sun down all day';
    ui.sunset.textContent = '';
  } else {
    ui.sunrise.textContent = `Sunrise ${formatTime(times.sunrise)}`;
    ui.sunset.textContent = `Sunset ${formatTime(times.sunset)}`;
  }
  drawSun();
}

function drawSun() {
  ui.sunTimeValue.textContent = formatTime(sun.time, true);
  const { azimuth, altitude } = sunPosition(new Date(sun.time), sun.lat, sun.lng);
  const deg = (r) => Math.round((r * 180) / Math.PI);
  const az = (deg(azimuth) + 360) % 360;
  const compass = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(az / 45) % 8];
  ui.sunInfo.textContent = altitude > 0 ? `Sun ${deg(altitude)}° above the horizon, toward ${compass} (${az}°)` : 'Sun is below the horizon';
  if (!ui.sun.checked || !shadowRenderer) return;
  shadowRenderer.render(azimuth, altitude);
  // The canvas source only re-reads the canvas while "playing".
  const source = map.getSource('sun');
  source.play();
  requestAnimationFrame(() => requestAnimationFrame(() => source.pause()));
}

// Loads elevation for the view plus a one-tile margin, so ridges just outside
// the view still cast shadows into it, and hands it to the shadow renderer.
let sunRun = 0;
async function updateSunGrid() {
  if (!ui.sun.checked) return;
  const run = ++sunRun;
  if (!shadowRenderer) {
    try {
      shadowRenderer = new ShadowRenderer(map.getSource('sun').getCanvas());
    } catch (e) {
      ui.sunInfo.textContent = `Sun exposure needs WebGL2: ${e.message}`;
      return;
    }
  }
  const MAX_SIDE = 7; // tiles per side including margin, 1792 px
  let z = Math.min(DEM_MAX_ZOOM, Math.max(0, Math.floor(map.getZoom()) + 1));
  let r = viewTileRange(z);
  while (z > 0 && (r.x1 - r.x0 + 3 > MAX_SIDE || r.y1 - r.y0 + 3 > MAX_SIDE)) {
    z--;
    r = viewTileRange(z);
  }
  const gx0 = r.x0 - 1;
  const gy0 = Math.max(0, r.y0 - 1);
  const gy1 = Math.min(r.n - 1, r.y1 + 1);
  const nx = r.x1 + 1 - gx0 + 1;
  const ny = gy1 - gy0 + 1;
  const S = DEM_TILE_SIZE;
  const W = nx * S;
  const H = ny * S;

  const jobs = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const tx = gx0 + i;
      jobs.push(loadTile(z, ((tx % r.n) + r.n) % r.n, gy0 + j).then((elev) => ({ i, j, elev })));
    }
  }
  const tiles = await Promise.all(jobs);
  if (run !== sunRun || !ui.sun.checked) return;

  const data = new Float32Array(W * H);
  let maxElev = -Infinity;
  for (const { i, j, elev } of tiles) {
    if (!elev) continue;
    for (let py = 0; py < S; py++) {
      const row = elev.subarray(py * S, py * S + S);
      data.set(row, (j * S + py) * W + i * S);
      for (let k = 0; k < S; k++) if (row[k] > maxElev) maxElev = row[k];
    }
  }
  shadowRenderer.setGrid({ data, width: W, height: H, z, originY: gy0 * S, maxElev });
  map.getSource('sun').setCoordinates([
    [xToLng(gx0, r.n), yToLat(gy0, r.n)],
    [xToLng(gx0 + nx, r.n), yToLat(gy0, r.n)],
    [xToLng(gx0 + nx, r.n), yToLat(gy0 + ny, r.n)],
    [xToLng(gx0, r.n), yToLat(gy0 + ny, r.n)],
  ]);
  drawSun();
}

function setSunEnabled(on) {
  ui.sun.checked = on;
  ui.sunSection.classList.toggle('on', on);
  setVisible('sun', on);
  if (on) updateSunGrid();
  else stopPlay();
}

ui.sun.addEventListener('change', () => setSunEnabled(ui.sun.checked));

ui.sunTime.addEventListener('input', () => {
  if (!ui.sun.checked) setSunEnabled(true);
  sun.time = Number(ui.sunTime.value) * MIN_MS;
  drawSun();
});

ui.sunDate.addEventListener('change', () => {
  if (!ui.sunDate.value) ui.sunDate.value = todayIn(sun.tz);
  if (!ui.sun.checked) setSunEnabled(true);
  updateSunRange();
});

function stopPlay() {
  clearInterval(sun.playTimer);
  sun.playTimer = null;
  ui.sunPlay.textContent = '▶';
  ui.sunPlay.setAttribute('aria-label', 'Play');
}
ui.sunPlay.addEventListener('click', () => {
  if (sun.playTimer) return stopPlay();
  if (!ui.sun.checked) setSunEnabled(true);
  const s = ui.sunTime;
  if (Number(s.value) >= Number(s.max)) s.value = s.min;
  ui.sunPlay.textContent = '❚❚';
  ui.sunPlay.setAttribute('aria-label', 'Pause');
  sun.playTimer = setInterval(() => {
    const next = Math.min(Number(s.max), Number(s.value) + 5);
    s.value = next;
    sun.time = next * MIN_MS;
    drawSun();
    if (next >= Number(s.max)) stopPlay();
  }, 80);
});

// ---------- View changes ----------

let statsTimer;
map.on('moveend', () => {
  clearTimeout(statsTimer);
  statsTimer = setTimeout(() => {
    computeViewStats();
    updateSunRange();
    updateSunGrid();
  }, 150);
});
map.on('load', () => {
  computeViewStats();
  updateSunRange();
});
