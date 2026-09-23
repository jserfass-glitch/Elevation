// Elevation tiles: fetching, decoding, and point sampling.
//
// AWS Open Data terrain tiles (Terrarium encoding): elevation in meters =
// R * 256 + G + B / 256 - 32768.

export const DEM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const DEM_MAX_ZOOM = 15;
export const DEM_TILE_SIZE = 256;
const EARTH_CIRCUMFERENCE = 40075016.686;

const tileCache = new Map(); // key "z/x/y" -> Promise<Float32Array|null>
const TILE_CACHE_LIMIT = 200;

/** Decoded elevations (meters, row-major, 256x256) for one tile, or null if it failed. */
export function loadTile(z, x, y) {
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

// Web Mercator tile coordinates (fractional) at n = 2^z tiles per side.
const MAX_LAT = 85.0511;
export const lngToX = (lng, n) => ((lng + 180) / 360) * n;
export function latToY(lat, n) {
  const r = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
}
export const xToLng = (x, n) => (x / n) * 360 - 180;
export const yToLat = (y, n) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
export const wrapX = (x, n) => ((x % n) + n) % n;

/** Meters per DEM pixel at zoom z and latitude. */
export const pixelMeters = (z, lat) => (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / (DEM_TILE_SIZE * 2 ** z);

/**
 * Loads every tile at zoom z within `radius` meters of a point and returns a
 * synchronous bilinear sampler over them, in global pixel coordinates.
 */
export async function areaSampler(z, lng, lat, radius) {
  const n = 2 ** z;
  const S = DEM_TILE_SIZE;
  const rPx = radius / pixelMeters(z, lat) / S; // radius in tiles
  const cx = lngToX(lng, n);
  const cy = latToY(lat, n);
  const tiles = new Map();
  const jobs = [];
  for (let ty = Math.max(0, Math.floor(cy - rPx)); ty <= Math.min(n - 1, Math.floor(cy + rPx)); ty++) {
    for (let tx = Math.floor(cx - rPx); tx <= Math.floor(cx + rPx); tx++) {
      jobs.push(loadTile(z, wrapX(tx, n), ty).then((t) => tiles.set(`${tx}/${ty}`, t)));
    }
  }
  await Promise.all(jobs);

  const at = (gx, gy) => {
    const tx = Math.floor(gx / S);
    const ty = Math.floor(gy / S);
    const t = tiles.get(`${tx}/${ty}`);
    if (!t) return NaN;
    return t[(gy - ty * S) * S + (gx - tx * S)];
  };
  // Bilinear sample at fractional global pixel coords (pixel centers at +0.5).
  const sample = (px, py) => {
    const x = px - 0.5;
    const y = py - 0.5;
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const a = at(x0, y0);
    const b = at(x0 + 1, y0);
    const c = at(x0, y0 + 1);
    const d = at(x0 + 1, y0 + 1);
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
  return { z, n, px: cx * S, py: cy * S, sample };
}
