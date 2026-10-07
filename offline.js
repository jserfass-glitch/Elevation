// Offline maps. Saved areas keep USGS Topo and elevation tiles in Cache
// Storage, and fetchTile() serves them when the network can't: first the exact
// tile, then a scaled-up piece of a saved lower-zoom tile, so zooming in past
// the saved detail still shows something.
//
// Only sources whose terms allow bulk download are saved: USGS Topo is public
// domain and the AWS terrain tiles are an open dataset. OpenStreetMap,
// OpenTopoMap and Esri forbid offline caching without permission or a license.

import { lngToX, latToY } from './dem.js';

const CACHE_NAME = 'offline-tiles-v1';
const AREAS_KEY = 'offlineAreas';
const CONCURRENCY = 6;
const NETWORK_TIMEOUT_MS = 10000;

export const SOURCES = {
  terrain: {
    url: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
    parse: (u) => u.match(/\/terrarium\/(\d+)\/(\d+)\/(\d+)\.png$/)?.slice(1).map(Number), // z, x, y
    smooth: false, // scaled-up elevation tiles must keep exact pixel values
    avgBytes: 110000, // measured in the Colorado Rockies; flatter ground is smaller
  },
  topo: {
    url: (z, x, y) => `https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/${z}/${y}/${x}`,
    parse: (u) => {
      const m = u.match(/USGSTopo\/MapServer\/tile\/(\d+)\/(\d+)\/(\d+)$/);
      return m && [Number(m[1]), Number(m[3]), Number(m[2])]; // URL order is z/y/x
    },
    smooth: true,
    avgBytes: 20000,
  },
};

// Highest zoom saved per source. Past it, tiles are scaled up from the
// saved ones.
export const DETAIL = {
  standard: { label: 'Standard', topo: 15, terrain: 14 },
  full: { label: 'Full detail', topo: 16, terrain: 15 },
};

// ---------- Saved-area bookkeeping ----------

let areas = [];
try {
  areas = JSON.parse(localStorage.getItem(AREAS_KEY)) || [];
} catch {
  areas = [];
}
const saveAreas = () => {
  try {
    localStorage.setItem(AREAS_KEY, JSON.stringify(areas));
  } catch {
    // storage full or blocked: the list just won't persist
  }
};
export const listAreas = () => [...areas];
export const hasSavedAreas = () => areas.length > 0;

let cachePromise = null;
const openCache = () => (cachePromise ??= caches.open(CACHE_NAME));

// ---------- Which tiles an area needs ----------

const M_PER_DEG_LAT = 111320;
function expand([w, s, e, n], meters) {
  const dLat = meters / M_PER_DEG_LAT;
  const dLng = meters / (M_PER_DEG_LAT * Math.cos((((s + n) / 2) * Math.PI) / 180));
  return [w - dLng, Math.max(-85, s - dLat), e + dLng, Math.min(85, n + dLat)];
}

function tileRange(z, [w, s, e, n]) {
  const count = 2 ** z;
  return {
    count,
    x0: Math.floor(lngToX(w, count)),
    x1: Math.floor(lngToX(e, count) - 1e-9),
    y0: Math.max(0, Math.floor(latToY(n, count))),
    y1: Math.min(count - 1, Math.floor(latToY(s, count) - 1e-9)),
  };
}
function* tilesIn(z, bounds) {
  const { count, x0, x1, y0, y1 } = tileRange(z, bounds);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) yield [z, ((x % count) + count) % count, y];
}
const countIn = (z, bounds) => {
  const { x0, x1, y0, y1 } = tileRange(z, bounds);
  return Math.max(0, x1 - x0 + 1) * Math.max(0, y1 - y0 + 1);
};
const terrainMargin = (z) => (z <= 10 ? 32000 : z <= 13 ? 3500 : 600);

/**
 * Tile URLs for an area. Elevation gets margins: the tap popup's sun hours
 * look for ridges up to 30 km away at zoom 10 and sample 3 km around the
 * point at zoom 13, and the shading overlays read a little past the view edge.
 */
export function areaTileUrls({ bounds, detail }) {
  const d = DETAIL[detail];
  const urls = new Set();
  for (let z = 8; z <= d.topo; z++) for (const t of tilesIn(z, bounds)) urls.add(SOURCES.topo.url(...t));
  for (let z = 8; z <= d.terrain; z++) {
    for (const t of tilesIn(z, expand(bounds, terrainMargin(z)))) urls.add(SOURCES.terrain.url(...t));
  }
  return urls;
}

/**
 * Tile count, estimated bytes and size in km for a prospective area. Counts
 * arithmetically, so it stays instant even for a view of a whole state.
 */
export function estimateArea({ bounds, detail }) {
  const d = DETAIL[detail];
  let topo = 0;
  let terrain = 0;
  for (let z = 8; z <= d.topo; z++) topo += countIn(z, bounds);
  for (let z = 8; z <= d.terrain; z++) terrain += countIn(z, expand(bounds, terrainMargin(z)));
  const tiles = topo + terrain;
  const bytes = topo * SOURCES.topo.avgBytes + terrain * SOURCES.terrain.avgBytes;
  const [w, s, e, n] = bounds;
  const heightKm = ((n - s) * M_PER_DEG_LAT) / 1000;
  const widthKm = ((e - w) * M_PER_DEG_LAT * Math.cos((((s + n) / 2) * Math.PI) / 180)) / 1000;
  return { tiles, bytes, widthKm, heightKm };
}

// ---------- Downloading and deleting ----------

async function fetchWithRetry(url, signal) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { signal });
      if (r.status === 404) return null; // no tile there (USGS has gaps at sea)
      if (r.ok) return await r.blob();
    } catch (e) {
      if (signal.aborted) throw e;
    }
    await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
  }
  throw new Error(`Could not download ${url}`);
}

async function removeUnshared(urls, keepAreaIds = new Set()) {
  const keep = new Set();
  for (const a of areas) if (!keepAreaIds.has(a.id)) for (const u of areaTileUrls(a)) keep.add(u);
  const cache = await openCache();
  const doomed = [...urls].filter((u) => !keep.has(u));
  for (let i = 0; i < doomed.length; i += 50) await Promise.all(doomed.slice(i, i + 50).map((u) => cache.delete(u)));
}

/**
 * Downloads every tile an area needs and records it. Tiles already saved for
 * another area are reused. `onProgress({ done, total, bytes, failed })`.
 * Rejects with an AbortError if `signal` aborts, after removing what it added.
 */
export async function saveArea({ name, bounds, detail }, { onProgress, signal }) {
  const area = { id: Date.now().toString(36), name, bounds, detail, created: Date.now() };
  const urls = [...areaTileUrls(area)];
  const cache = await openCache();
  navigator.storage?.persist?.().catch(() => {}); // ask the browser not to evict saved maps
  let done = 0;
  let bytes = 0;
  let failed = 0;
  let next = 0;
  const added = [];

  async function worker() {
    while (next < urls.length && !signal.aborted) {
      const url = urls[next++];
      try {
        const existing = await cache.match(url);
        if (existing) {
          bytes += Number(existing.headers.get('x-bytes')) || 0;
        } else {
          const blob = await fetchWithRetry(url, signal);
          if (blob) {
            await cache.put(url, new Response(blob, { headers: { 'Content-Type': blob.type, 'x-bytes': String(blob.size) } }));
            added.push(url);
            bytes += blob.size;
          }
        }
      } catch {
        if (signal.aborted) break;
        failed++;
      }
      done++;
      onProgress?.({ done, total: urls.length, bytes, failed });
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  if (signal.aborted) {
    await removeUnshared(added);
    throw new DOMException('Download canceled', 'AbortError');
  }
  Object.assign(area, { tiles: urls.length, bytes, failed });
  areas.push(area);
  saveAreas();
  return area;
}

/** Deletes an area and every tile no other saved area uses. */
export async function deleteArea(id) {
  const area = areas.find((a) => a.id === id);
  if (!area) return;
  areas = areas.filter((a) => a.id !== id);
  saveAreas();
  await removeUnshared(areaTileUrls(area));
}

// ---------- Serving tiles ----------

/**
 * Fetches a tile, preferring saved copies. With nothing saved this is a plain
 * fetch. Otherwise: a saved copy, then the network (skipped when the device
 * reports being offline, and given up on after 10 s of weak signal), then a
 * scaled-up piece of a saved lower-zoom tile.
 */
export async function fetchTile(url, signal) {
  if (!areas.length) return fetch(url, { signal });
  const cache = await openCache();
  const hit = await cache.match(url);
  if (hit) return hit;

  if (navigator.onLine !== false) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), NETWORK_TIMEOUT_MS);
    signal?.addEventListener('abort', () => ctl.abort());
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (r.ok || r.status === 404) return r;
    } catch (e) {
      if (signal?.aborted) throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  const scaled = await fromSavedAncestor(url, cache);
  if (scaled) return scaled;
  throw new Error('Tile not available offline');
}

async function fromSavedAncestor(url, cache) {
  const source = Object.values(SOURCES).find((s) => s.parse(url));
  if (!source) return null;
  const [z, x, y] = source.parse(url);
  for (let dz = 1; dz <= 6 && z - dz >= 0; dz++) {
    const px = x >> dz;
    const py = y >> dz;
    const hit = await cache.match(source.url(z - dz, px, py));
    if (!hit) continue;
    const bitmap = await createImageBitmap(await hit.blob());
    const size = bitmap.width / 2 ** dz;
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = source.smooth;
    ctx.drawImage(bitmap, (x - (px << dz)) * size, (y - (py << dz)) * size, size, size, 0, 0, bitmap.width, bitmap.height);
    return new Response(await canvas.convertToBlob({ type: 'image/png' }), { headers: { 'Content-Type': 'image/png' } });
  }
  return null;
}
