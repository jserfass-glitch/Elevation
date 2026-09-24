import * as maplibregl from 'https://cdn.jsdelivr.net/npm/maplibre-gl@6.10.0/dist/maplibre-gl.mjs';
import { DEM_URL, DEM_MAX_ZOOM, DEM_TILE_SIZE, loadTile, lngToX, latToY, xToLng, yToLat, wrapX } from './dem.js';
import { sunPosition, sunTimes, lightPhase, GOLDEN_LOW, GOLDEN_HIGH } from './sun.js';
import { SunRenderer, AspectRenderer } from './terrain.js';
import { initSearch } from './search.js';
import { pointInfo } from './pointinfo.js';

// Time zone of a map location, so times read in local time there.
const tzLookup = import('https://cdn.jsdelivr.net/npm/@photostructure/tz-lookup@11.7.0/+esm')
  .then((m) => m.default)
  .catch(() => null);
const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
async function timeZoneAt(lat, lng) {
  const lookup = await tzLookup;
  try {
    return lookup ? lookup(lat, lng) : browserTz;
  } catch {
    return browserTz; // outside any zone polygon, e.g. open ocean
  }
}

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
  shade: $('ov-shade'),
  hillshade: $('ov-hillshade'),
  hillshadeStrength: $('hillshade-strength'),
  roads: $('ov-roads'),
  sun: $('ov-sun'),
  sunDate: $('sun-date'),
  sunTime: $('sun-time'),
  sunTimeValue: $('sun-time-value'),
  sunPlay: $('sun-play'),
  sunrise: $('sunrise'),
  sunset: $('sunset'),
  sunInfo: $('sun-info'),
  aspect: $('ov-aspect'),
  opacity: { shade: $('op-shade'), sun: $('op-sun'), aspect: $('op-aspect') },
};

const state = {
  units: 'ft',
  min: null, // meters, lowest point in view
  max: null, // meters, highest point in view
  peak: null, // [lng, lat] of the highest point in view
  threshold: null, // meters; null means "at minimum", shade everything
};

// ---------- Map ----------

// Hillshade strength 0..1 -> paint properties; the top of the range is
// noticeably darker and higher-contrast than MapLibre's default.
const hillshadePaint = (v) => ({
  'hillshade-exaggeration': 0.15 + 0.7 * v,
  'hillshade-shadow-color': `rgba(0, 0, 0, ${(0.3 + 0.6 * v).toFixed(2)})`,
  'hillshade-highlight-color': `rgba(255, 255, 255, ${(0.1 + 0.3 * v).toFixed(2)})`,
});

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
};
// Overlays drawn by the WebGL renderers in terrain.js, positioned over the
// elevation grid they were computed from.
for (const id of ['sun', 'aspect']) {
  sources[id] = {
    type: 'canvas',
    canvas: Object.assign(document.createElement('canvas'), { width: 1, height: 1 }),
    coordinates: [[-100, 40], [-99, 40], [-99, 39], [-100, 39]],
    animate: false,
  };
}
const layers = [];
for (const [id, b] of Object.entries(BASEMAPS)) {
  sources[`base-${id}`] = { type: 'raster', tiles: b.tiles, tileSize: 256, maxzoom: b.maxzoom, attribution: b.attribution };
  layers.push({ id: `base-${id}`, type: 'raster', source: `base-${id}`, layout: { visibility: id === 'usgs' ? 'visible' : 'none' } });
}
const canvasLayer = (id) => ({
  id,
  type: 'raster',
  source: id,
  layout: { visibility: 'none' },
  paint: { 'raster-opacity': Number(ui.opacity[id].value), 'raster-fade-duration': 0 },
});
layers.push(
  { id: 'hillshade', type: 'hillshade', source: 'dem', paint: hillshadePaint(Number(ui.hillshadeStrength.value)) },
  {
    id: 'elevation-shading',
    type: 'color-relief',
    source: 'dem',
    paint: { 'color-relief-opacity': Number(ui.opacity.shade.value), 'color-relief-color': reliefExpression() },
  },
  canvasLayer('aspect'),
  canvasLayer('sun'),
  { id: 'roads', type: 'raster', source: 'roads', layout: { visibility: 'none' } },
  { id: 'places', type: 'raster', source: 'places', layout: { visibility: 'none' } },
);

// Opened without a position in the URL (e.g. from the home-screen icon):
// start where the map was last left.
let lastView = null;
try {
  lastView = JSON.parse(localStorage.getItem('lastView'));
} catch {
  // storage unavailable or empty
}

const map = new maplibregl.Map({
  container: 'map',
  style: { version: 8, sources, layers },
  center: lastView?.center ?? [-98.5, 39.5],
  zoom: lastView?.zoom ?? 3.6,
  maxZoom: 17,
  dragRotate: false,
  pitchWithRotate: false,
  touchPitch: false,
  hash: true,
  attributionControl: { compact: true },
});
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');

const marker = (className, title) => new maplibregl.Marker({ element: Object.assign(document.createElement('div'), { className, title }) });
const peakMarker = marker('peak-marker', 'Highest point in view');
const placeMarker = marker('place-marker', 'Search result');

const setVisible = (id, on) => map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');

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

const MAX_STATS_TILES = 16;

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
      jobs.push(loadTile(z, wrapX(tx, r.n), ty).then((elev) => ({ tx, ty, elev })));
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

  state.min = min;
  state.max = max;
  state.peak = [xToLng(peak[0], r.n), yToLat(peak[1], r.n)];
  // Keep an absolute threshold across pans; drop it if it now falls below the view minimum.
  if (state.threshold != null && state.threshold <= min) state.threshold = null;
  if (state.threshold != null && state.threshold > max) state.threshold = max;
  syncSlider();
  updateShading();

  peakMarker.setLngLat(state.peak);
  if (ui.shade.checked) peakMarker.addTo(map);
}

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
  paintThresholdTrack();
}

// Gray up to the thumb, then the same yellow-to-red ramp the map uses for
// the shaded range above it.
function paintThresholdTrack() {
  const s = ui.threshold;
  const span = Number(s.max) - Number(s.min);
  const p = span > 0 ? ((Number(s.value) - Number(s.min)) / span) * 100 : 0;
  const stops = RAMP.map((c, i) => `${c} ${(p + ((100 - p) * i) / (RAMP.length - 1)).toFixed(2)}%`);
  s.style.background = `linear-gradient(to right, var(--border) 0 ${p.toFixed(2)}%, ${stops.join(', ')})`;
}

ui.threshold.addEventListener('input', () => {
  if (!ui.shade.checked) overlays.shade.set(true);
  const v = Number(ui.threshold.value);
  state.threshold = v <= Number(ui.threshold.min) ? null : fromUnits(v);
  ui.thresholdValue.textContent = state.threshold == null ? 'everything' : fmt(state.threshold);
  paintThresholdTrack();
  updateShading();
});

ui.peak.addEventListener('click', () => {
  if (state.peak) map.flyTo({ center: state.peak, zoom: Math.max(map.getZoom(), 12) });
});

// ---------- Sun exposure ----------

const sun = {
  tz: browserTz,
  lat: 0,
  lng: 0,
  times: null,
  time: null, // ms since epoch shown on the slider
  playTimer: null,
};
const MIN_MS = 60000;
const MARGIN_MS = 20 * MIN_MS; // slider starts this long before sunrise and ends after sunset
const renderers = { sun: null, aspect: null };

const formatTime = (ms, tz, withZone = false) =>
  new Intl.DateTimeFormat([], { timeZone: tz, hour: 'numeric', minute: '2-digit', ...(withZone && { timeZoneName: 'short' }) })
    .format(new Date(ms));
const todayIn = (tz) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// Recomputes sunrise/sunset for the view center and the chosen date, keeping
// the slider at the same offset from solar noon.
async function updateSunRange() {
  const c = map.getCenter();
  sun.tz = await timeZoneAt(c.lat, c.lng);
  if (!ui.sunDate.value) ui.sunDate.value = todayIn(sun.tz);
  const [y, m, d] = ui.sunDate.value.split('-').map(Number);
  // Roughly local noon on the chosen date, so the lookup lands on that solar day.
  const ref = new Date(Date.UTC(y, m - 1, d, 12) - (c.lng / 15) * 3600000);
  const prev = sun.times;
  const times = sunTimes(ref, c.lat, c.lng);
  const noon = times.noon.getTime();
  // Start just before morning golden hour and end just after evening golden
  // hour (it begins with the sun 4° below the horizon), or at least 20
  // minutes either side of sunrise and sunset.
  const altDeg = (t) => (sunPosition(new Date(t), c.lat, c.lng).altitude * 180) / Math.PI;
  const edge = (from, step) => {
    let t = from;
    for (let i = 0; i < 180 && altDeg(t) >= GOLDEN_LOW; i++) t += step;
    return t + step * 5;
  };
  const lo = times.sunrise ? Math.min(times.sunrise.getTime() - MARGIN_MS, edge(times.sunrise.getTime(), -MIN_MS)) : noon - 12 * 3600000;
  const hi = times.sunset ? Math.max(times.sunset.getTime() + MARGIN_MS, edge(times.sunset.getTime(), MIN_MS)) : noon + 12 * 3600000;

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
    ui.sunrise.textContent = `Sunrise ${formatTime(times.sunrise, sun.tz)}`;
    ui.sunset.textContent = `Sunset ${formatTime(times.sunset, sun.tz)}`;
  }
  paintSunTrack(lo, hi, c);
  drawSun();
}

// Colors the time slider by light phase (night, blue hour, golden hour, day)
// and lists the golden-hour windows under it.
const PHASE_COLORS = { night: '#1f2a44', blue: '#4063a8', golden: '#f2a93b', day: '#cfe6f7' };
function paintSunTrack(lo, hi, c) {
  const phaseAt = (t) => lightPhase((sunPosition(new Date(t), c.lat, c.lng).altitude * 180) / Math.PI);
  const stops = [];
  const windows = [];
  let prev = null;
  let start = null;
  for (let t = lo; t <= hi; t += MIN_MS) {
    const ph = phaseAt(t);
    if (ph !== prev) {
      const pct = (((t - lo) / (hi - lo)) * 100).toFixed(2);
      if (prev) stops.push(`${PHASE_COLORS[prev]} ${pct}%`);
      stops.push(`${PHASE_COLORS[ph]} ${pct}%`);
      if (prev === 'golden') windows.push([start, t]);
      if (ph === 'golden') start = t;
      prev = ph;
    }
  }
  if (prev === 'golden') windows.push([start, hi]);
  stops.push(`${PHASE_COLORS[prev]} 100%`);
  ui.sunTime.style.background = `linear-gradient(to right, ${stops.join(', ')})`;
  $('golden-hours').textContent = windows.length
    ? `Golden hour ${windows.map(([a, b]) => `${formatTime(a, sun.tz)}–${formatTime(b, sun.tz)}`).join(' and ')}`
    : '';
}

function drawSun() {
  ui.sunTimeValue.textContent = formatTime(sun.time, sun.tz, true);
  const { azimuth, altitude } = sunPosition(new Date(sun.time), sun.lat, sun.lng);
  const deg = (r) => Math.round((r * 180) / Math.PI);
  const az = (deg(azimuth) + 360) % 360;
  const compass = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(az / 45) % 8];
  const phase = lightPhase((altitude * 180) / Math.PI);
  const phaseNote = { golden: ' · golden hour', blue: ' · blue hour' }[phase] ?? '';
  ui.sunInfo.textContent =
    (altitude > 0 ? `Sun ${deg(altitude)}° above the horizon, toward ${compass} (${az}°)` : 'Sun is below the horizon') + phaseNote;
  if (!ui.sun.checked || !renderers.sun?.grid) return;
  // Full glow below the top of golden hour, fading out over the next 2°.
  const altDeg = (altitude * 180) / Math.PI;
  const golden = altDeg > 0 ? 1 - Math.min(1, Math.max(0, (altDeg - (GOLDEN_HIGH - 1)) / 2)) : 0;
  renderers.sun.render(azimuth, altitude, golden);
  refreshCanvasSource('sun');
}

// The canvas source only re-reads its canvas while "playing".
function refreshCanvasSource(id) {
  const source = map.getSource(id);
  source.play();
  requestAnimationFrame(() => requestAnimationFrame(() => source.pause()));
}

const RENDERER_CLASSES = { sun: SunRenderer, aspect: AspectRenderer };
function ensureRenderer(id) {
  if (!renderers[id]) {
    try {
      renderers[id] = new RENDERER_CLASSES[id](map.getSource(id).getCanvas());
    } catch (e) {
      (id === 'sun' ? ui.sunInfo : $('aspect-label')).textContent = `Needs WebGL2: ${e.message}`;
    }
  }
  return renderers[id];
}

// Loads elevation for the view plus a one-tile margin, so ridges just outside
// the view still cast shadows into it, and hands it to the enabled overlays.
let gridRun = 0;
async function updateTerrainGrid() {
  const ids = ['sun', 'aspect'].filter((id) => ui[id].checked && ensureRenderer(id));
  if (!ids.length) return;
  const run = ++gridRun;
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
      jobs.push(loadTile(z, wrapX(gx0 + i, r.n), gy0 + j).then((elev) => ({ i, j, elev })));
    }
  }
  const tiles = await Promise.all(jobs);
  if (run !== gridRun) return;

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
  const grid = { data, width: W, height: H, z, originY: gy0 * S, maxElev };
  const corners = [
    [xToLng(gx0, r.n), yToLat(gy0, r.n)],
    [xToLng(gx0 + nx, r.n), yToLat(gy0, r.n)],
    [xToLng(gx0 + nx, r.n), yToLat(gy0 + ny, r.n)],
    [xToLng(gx0, r.n), yToLat(gy0 + ny, r.n)],
  ];
  for (const id of ids) {
    renderers[id].setGrid(grid);
    map.getSource(id).setCoordinates(corners);
  }
  if (ids.includes('sun')) drawSun();
  if (ids.includes('aspect')) drawAspect();
}

ui.sunTime.addEventListener('input', () => {
  if (!ui.sun.checked) overlays.sun.set(true);
  sun.time = Number(ui.sunTime.value) * MIN_MS;
  drawSun();
});

ui.sunDate.addEventListener('change', () => {
  if (!ui.sunDate.value) ui.sunDate.value = todayIn(sun.tz);
  if (!ui.sun.checked) overlays.sun.set(true);
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
  if (!ui.sun.checked) overlays.sun.set(true);
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

// ---------- Slope direction ----------
// A compass with two arms. Slopes whose downhill direction lies clockwise from
// arm A to arm B are shaded.

const aspect = { from: 315, to: 45 }; // default: north-facing slopes
const compass = $('compass');
const HANDLE_R = 42;
const COMPASS_POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const norm = (deg) => ((Math.round(deg) % 360) + 360) % 360;
const polar = (deg, r) => [r * Math.sin((deg * Math.PI) / 180), -r * Math.cos((deg * Math.PI) / 180)];
const pointName = (deg) => COMPASS_POINTS[Math.round(norm(deg) / 22.5) % 16];

function drawCompass() {
  const { from, to } = aspect;
  const span = norm(to - from) || 360;
  const [ax, ay] = polar(from, HANDLE_R);
  const [bx, by] = polar(to, HANDLE_R);
  $('aspect-wedge').setAttribute(
    'd',
    span >= 360
      ? `M0,${-HANDLE_R}A${HANDLE_R},${HANDLE_R} 0 1 1 0,${HANDLE_R}A${HANDLE_R},${HANDLE_R} 0 1 1 0,${-HANDLE_R}Z`
      : `M0,0L${ax},${ay}A${HANDLE_R},${HANDLE_R} 0 ${span > 180 ? 1 : 0} 1 ${bx},${by}Z`,
  );
  for (const [key, x, y, deg] of [['a', ax, ay, from], ['b', bx, by, to]]) {
    const line = $(`aspect-line-${key}`);
    line.setAttribute('x2', x);
    line.setAttribute('y2', y);
    const handle = $(`aspect-handle-${key}`);
    handle.setAttribute('cx', x);
    handle.setAttribute('cy', y);
    handle.setAttribute('aria-valuenow', deg);
    handle.setAttribute('aria-valuetext', `${deg}° ${pointName(deg)}`);
  }
  const label = $('aspect-label');
  if (span >= 360) label.textContent = 'All directions';
  else {
    label.textContent = `${pointName(from)} → ${pointName(to)}`;
    label.append(Object.assign(document.createElement('div'), { className: 'muted', textContent: `${from}°–${to}° (${span}°)` }));
  }
}

function drawAspect() {
  drawCompass();
  if (!ui.aspect.checked || !renderers.aspect?.grid) return;
  renderers.aspect.render(aspect.from, aspect.to);
  refreshCanvasSource('aspect');
}

// Compass bearing of a pointer position relative to the dial center.
function pointerBearing(e) {
  const box = compass.getBoundingClientRect();
  const dx = e.clientX - (box.left + box.width / 2);
  const dy = e.clientY - (box.top + box.height / 2);
  return (Math.atan2(dx, -dy) * 180) / Math.PI;
}

let drag = null;
compass.addEventListener('pointerdown', (e) => {
  const id = e.target.id;
  if (id === 'aspect-handle-a') drag = { key: 'from' };
  else if (id === 'aspect-handle-b') drag = { key: 'to' };
  else if (id === 'aspect-wedge') drag = { key: 'rotate', start: pointerBearing(e), from: aspect.from, to: aspect.to };
  else return;
  e.preventDefault();
  compass.setPointerCapture(e.pointerId);
  if (!ui.aspect.checked) overlays.aspect.set(true);
});
compass.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const b = pointerBearing(e);
  if (drag.key === 'rotate') {
    const delta = b - drag.start;
    aspect.from = norm(drag.from + delta);
    aspect.to = norm(drag.to + delta);
  } else {
    aspect[drag.key] = norm(Math.round(b / 5) * 5); // snap to 5°
  }
  drawAspect();
});
const endDrag = () => (drag = null);
compass.addEventListener('pointerup', endDrag);
compass.addEventListener('pointercancel', endDrag);

for (const [key, prop] of [['a', 'from'], ['b', 'to']]) {
  $(`aspect-handle-${key}`).addEventListener('keydown', (e) => {
    const step = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5 }[e.key];
    if (!step) return;
    e.preventDefault();
    if (!ui.aspect.checked) overlays.aspect.set(true);
    aspect[prop] = norm(aspect[prop] + step);
    drawAspect();
  });
}

$('aspect-invert').addEventListener('click', () => {
  [aspect.from, aspect.to] = [aspect.to, aspect.from];
  if (!ui.aspect.checked) overlays.aspect.set(true);
  drawAspect();
});

drawCompass();

// ---------- Overlay toggles ----------
// Each overlay has a checkbox in the panel and a button in the slide-out bar;
// both go through set() so they stay in sync.

const layerButtons = Object.fromEntries([...document.querySelectorAll('#layerbar-items [data-overlay]')].map((b) => [b.dataset.overlay, b]));

const overlays = {
  shade: {
    input: ui.shade,
    apply(on) {
      setVisible('elevation-shading', on);
      if (on && state.peak) peakMarker.addTo(map);
      else peakMarker.remove();
    },
  },
  sun: {
    input: ui.sun,
    apply(on) {
      setVisible('sun', on);
      if (on) updateTerrainGrid();
      else stopPlay();
    },
  },
  aspect: {
    input: ui.aspect,
    apply(on) {
      setVisible('aspect', on);
      if (on) updateTerrainGrid();
    },
  },
  hillshade: { input: ui.hillshade, apply: (on) => setVisible('hillshade', on) },
  roads: {
    input: ui.roads,
    apply(on) {
      setVisible('roads', on);
      setVisible('places', on);
    },
  },
};
for (const [id, o] of Object.entries(overlays)) {
  o.set = (on) => {
    o.input.checked = on;
    o.input.closest('.feature')?.classList.toggle('on', on);
    layerButtons[id].setAttribute('aria-pressed', String(on));
    o.apply(on);
  };
  o.input.addEventListener('change', () => o.set(o.input.checked));
  layerButtons[id].addEventListener('click', () => o.set(!o.input.checked));
}

const layerbar = $('layerbar');
const layerbarToggle = $('layerbar-toggle');
function setLayerbarOpen(open) {
  layerbar.classList.toggle('open', open);
  layerbarToggle.setAttribute('aria-expanded', String(open));
  try {
    localStorage.setItem('layerbarOpen', open ? '1' : '0');
  } catch {
    // storage unavailable: the choice just won't persist
  }
}
layerbarToggle.addEventListener('click', () => setLayerbarOpen(!layerbar.classList.contains('open')));
{
  let saved = null;
  try {
    saved = localStorage.getItem('layerbarOpen');
  } catch {
    // ignore
  }
  setLayerbarOpen(saved == null ? true : saved === '1');
}

// ---------- Opacity and hillshade strength ----------

const OPACITY_PROPS = { shade: ['elevation-shading', 'color-relief-opacity'], sun: ['sun', 'raster-opacity'], aspect: ['aspect', 'raster-opacity'] };
for (const [id, input] of Object.entries(ui.opacity)) {
  input.addEventListener('input', () => {
    map.setPaintProperty(...OPACITY_PROPS[id], Number(input.value));
    if (!overlays[id].input.checked) overlays[id].set(true);
  });
}
ui.hillshadeStrength.addEventListener('input', () => {
  for (const [prop, value] of Object.entries(hillshadePaint(Number(ui.hillshadeStrength.value)))) {
    map.setPaintProperty('hillshade', prop, value);
  }
  if (!ui.hillshade.checked) overlays.hillshade.set(true);
});

// ---------- Panel, units, base map ----------

document.querySelectorAll('input[name=base]').forEach((el) =>
  el.addEventListener('change', () => {
    for (const id of Object.keys(BASEMAPS)) setVisible(`base-${id}`, id === el.value);
  }),
);

document.querySelectorAll('input[name=units]').forEach((el) =>
  el.addEventListener('change', () => {
    state.units = el.value;
    syncSlider();
  }),
);

ui.collapse.addEventListener('click', () => {
  const collapsed = ui.panel.classList.toggle('collapsed');
  ui.collapse.textContent = collapsed ? '+' : '–';
  ui.collapse.title = collapsed ? 'Expand panel' : 'Minimize panel';
  ui.collapse.setAttribute('aria-expanded', String(!collapsed));
});

// On phones the panel is a bottom sheet; lift the scale bar and attribution above it.
const phone = window.matchMedia('(max-width: 600px)');
new ResizeObserver(() => {
  const h = phone.matches ? ui.panel.offsetHeight + 10 : 0;
  document.documentElement.style.setProperty('--sheet-h', `${h}px`);
}).observe(ui.panel);

// ---------- Search ----------

const searchbox = $('searchbox');
const searchToggle = $('search-toggle');
function setSearchOpen(open) {
  searchbox.classList.toggle('collapsed', !open);
  searchToggle.setAttribute('aria-expanded', String(open));
  searchToggle.setAttribute('aria-label', open ? 'Minimize search' : 'Search for a place');
  searchToggle.title = searchToggle.getAttribute('aria-label');
  searchToggle.querySelector('use').setAttribute('href', open ? '#i-minimize' : '#i-search');
  if (open) $('search-input').focus();
}
searchToggle.addEventListener('click', () => setSearchOpen(searchbox.classList.contains('collapsed')));

initSearch({
  form: $('search'),
  input: $('search-input'),
  list: $('search-results'),
  getCenter: () => map.getCenter(),
  onPick(res) {
    placeMarker.setLngLat(res.center).addTo(map);
    const [w, n, e, s] = res.extent || [];
    if (res.extent && !res.precise && (e - w > 0.01 || n - s > 0.01)) {
      map.fitBounds([[w, s], [e, n]], { padding: 40, maxZoom: 14 });
    } else {
      map.flyTo({ center: res.center, zoom: res.precise ? 15 : 13 });
    }
  },
});

// ---------- Tap for point details ----------

const popup = new maplibregl.Popup({ maxWidth: '260px', focusAfterOpen: false });
let infoRun = 0;

map.on('click', async (e) => {
  const run = ++infoRun;
  const { lng, lat } = e.lngLat.wrap();
  const date = ui.sunDate.value || todayIn(browserTz);
  const box = document.createElement('div');
  box.className = 'info';
  box.innerHTML = `<div class="info-coords"></div><dl>
    <dt>Elevation</dt><dd data-k="elev">…</dd>
    <dt>Slope faces</dt><dd data-k="facing">…</dd>
    <dt>Direct sun</dt><dd data-k="sun">…</dd></dl>`;
  box.querySelector('.info-coords').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
  const set = (k, text, sub) => {
    const dd = box.querySelector(`[data-k="${k}"]`);
    dd.textContent = text;
    if (sub) dd.append(Object.assign(document.createElement('span'), { className: 'sub', textContent: sub }));
  };
  popup.setLngLat(e.lngLat).setDOMContent(box).addTo(map);

  try {
    const [info, tz] = await Promise.all([pointInfo(lng, lat, date), timeZoneAt(lat, lng)]);
    if (run !== infoRun) return;
    set('elev', fmt(info.elevation));
    set('facing', info.facing ? info.facing.name : 'N/A (flat)', info.facing ? `${Math.round(info.slope)}° slope, facing ${info.facing.deg}°` : 'under 5° slope');
    const [y, m, d] = date.split('-').map(Number);
    const day = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const { minutes, first, last, polar: p } = info.sun;
    const hours = `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
    if (p === 'night') set('sun', 'None', `Sun stays down on ${day}`);
    else if (!minutes) set('sun', '0 h', `Terrain shades this spot all day on ${day}`);
    else set('sun', hours, `on ${day}, ${formatTime(first, tz)} – ${formatTime(last, tz)}`);
  } catch {
    if (run !== infoRun) return;
    for (const k of ['elev', 'facing', 'sun']) set(k, 'Unavailable');
  }
});

// ---------- View changes ----------

let viewTimer;
map.on('moveend', () => {
  try {
    const c = map.getCenter();
    localStorage.setItem('lastView', JSON.stringify({ center: [c.lng, c.lat], zoom: map.getZoom() }));
  } catch {
    // storage unavailable: the view just won't be remembered
  }
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => {
    computeViewStats();
    updateSunRange();
    updateTerrainGrid();
  }, 150);
});
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {
    // installability and offline start are optional; the map works without them
  });
}

map.on('load', () => {
  // Start with the attribution collapsed to its (i) button so it doesn't cover the map.
  document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  computeViewStats();
  updateSunRange();
});
