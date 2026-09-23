// Details for a single tapped point: elevation, slope, the direction the slope
// faces, and how long it gets direct sun on a given date once surrounding
// terrain is taken into account.

import { areaSampler, pixelMeters } from './dem.js';
import { sunPosition, sunTimes } from './sun.js';

const DEG = Math.PI / 180;
const EARTH_RADIUS = 6371000;
const REFRACTION = 0.13; // standard atmospheric refraction coefficient
const FLAT_SLOPE_DEG = 5; // below this a slope faces no particular direction
const NEAR_RADIUS = 3000; // meters sampled at high resolution
const FAR_RADIUS = 30000; // meters searched for a blocking horizon
const SUN_STEP_MIN = 2;
const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/**
 * @param {number} lng
 * @param {number} lat
 * @param {string} date "YYYY-MM-DD", the local calendar day at the point
 * @returns {Promise<{elevation, slope, facing, sun}>} facing is null on flat
 *   ground; sun is { minutes, first, last, polar } with Date first/last.
 */
export async function pointInfo(lng, lat, date) {
  const [near, far] = await Promise.all([areaSampler(13, lng, lat, NEAR_RADIUS), areaSampler(10, lng, lat, FAR_RADIUS)]);
  const pix = pixelMeters(near.z, lat);

  // Elevation and gradient from the high-resolution sampler (Horn's method).
  const e = (dx, dy) => near.sample(near.px + dx, near.py + dy);
  const elevation = e(0, 0);
  const dzdx = (e(1, -1) + 2 * e(1, 0) + e(1, 1) - (e(-1, -1) + 2 * e(-1, 0) + e(-1, 1))) / (8 * pix);
  const dzdn = (e(-1, -1) + 2 * e(0, -1) + e(1, -1) - (e(-1, 1) + 2 * e(0, 1) + e(1, 1))) / (8 * pix);
  const slope = Math.atan(Math.hypot(dzdx, dzdn)) / DEG;
  const facingDeg = ((Math.atan2(-dzdx, -dzdn) / DEG) % 360 + 360) % 360;
  const facing = slope < FLAT_SLOPE_DEG ? null : { deg: Math.round(facingDeg), name: POINTS[Math.round(facingDeg / 45) % 8] };
  const normal = normalize([-dzdx, -dzdn, 1]);

  // Highest angle of terrain above the point, looking toward a compass bearing.
  const observer = elevation + 2; // eye height keeps DEM noise from blocking the point itself
  const horizons = new Map();
  const horizon = (bearing) => {
    const key = Math.round(bearing / DEG) % 360;
    if (horizons.has(key)) return horizons.get(key);
    const b = key * DEG;
    const ex = Math.sin(b);
    const ny = -Math.cos(b); // pixel y grows southward
    let best = -Math.PI / 2;
    for (let d = pix; d < FAR_RADIUS; d += Math.max(pix, d * 0.03)) {
      const src = d < NEAR_RADIUS - 200 ? near : far;
      const p = d / pixelMeters(src.z, lat);
      const h = src.sample(src.px + ex * p, src.py + ny * p);
      if (Number.isNaN(h)) continue;
      const drop = ((d * d) / (2 * EARTH_RADIUS)) * (1 - REFRACTION);
      best = Math.max(best, Math.atan2(h - drop - observer, d));
    }
    horizons.set(key, best);
    return best;
  };

  // Walk the day in small steps, counting time the sun is above the local
  // horizon and striking the slope's face.
  const [y, m, d] = date.split('-').map(Number);
  const ref = new Date(Date.UTC(y, m - 1, d, 12) - (lng / 15) * 3600000);
  const times = sunTimes(ref, lat, lng);
  const noon = times.noon.getTime();
  const start = times.sunrise ? times.sunrise.getTime() : noon - 12 * 3600000;
  const end = times.sunset ? times.sunset.getTime() : noon + 12 * 3600000;
  let minutes = 0;
  let first = null;
  let last = null;
  if (times.polar !== 'night') {
    for (let t = start; t <= end; t += SUN_STEP_MIN * 60000) {
      const { azimuth, altitude } = sunPosition(new Date(t), lat, lng);
      if (altitude <= 0) continue;
      const c = Math.cos(altitude);
      const toSun = [Math.sin(azimuth) * c, Math.cos(azimuth) * c, Math.sin(altitude)];
      if (dot(normal, toSun) <= 0) continue; // slope faces away
      if (altitude <= horizon(azimuth)) continue; // terrain in the way
      minutes += SUN_STEP_MIN;
      first ??= new Date(t);
      last = new Date(t);
    }
  }
  return { elevation, slope, facing, sun: { minutes, first, last, polar: times.polar } };
}

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function normalize(v) {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
}
