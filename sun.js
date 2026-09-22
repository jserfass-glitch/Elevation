// Sun position and sunrise/sunset, adapted from SunCalc
// (https://github.com/mourner/suncalc, BSD-2-Clause, Vladimir Agafonkin).

const { PI, sin, cos, tan, asin, atan2, acos } = Math;
const rad = PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = rad * 23.4397;
const J0 = 0.0009;

const toDays = (date) => date.valueOf() / DAY_MS - 0.5 + J1970 - J2000;
const fromJulian = (j) => new Date((j + 0.5 - J1970) * DAY_MS);

const rightAscension = (l) => atan2(sin(l) * cos(OBLIQUITY), cos(l));
const declination = (l) => asin(sin(OBLIQUITY) * sin(l));
const siderealTime = (d, lw) => rad * (280.16 + 360.9856235 * d) - lw;
const solarMeanAnomaly = (d) => rad * (357.5291 + 0.98560028 * d);

function eclipticLongitude(M) {
  const C = rad * (1.9148 * sin(M) + 0.02 * sin(2 * M) + 0.0003 * sin(3 * M));
  return M + C + rad * 102.9372 + PI;
}

/**
 * Sun position at a moment and place.
 * Returns azimuth in radians clockwise from north, and altitude in radians above the horizon.
 */
export function sunPosition(date, lat, lng) {
  const lw = rad * -lng;
  const phi = rad * lat;
  const d = toDays(date);
  const L = eclipticLongitude(solarMeanAnomaly(d));
  const dec = declination(L);
  const H = siderealTime(d, lw) - rightAscension(L);
  const azimuthFromSouth = atan2(sin(H), cos(H) * sin(phi) - tan(dec) * cos(phi));
  const altitude = asin(sin(phi) * sin(dec) + cos(phi) * cos(dec) * cos(H));
  return { azimuth: azimuthFromSouth + PI, altitude };
}

/**
 * Solar noon, sunrise and sunset for the solar day nearest `date` at a place.
 * sunrise/sunset are null during polar day or night; `polar` says which.
 */
export function sunTimes(date, lat, lng) {
  const lw = rad * -lng;
  const phi = rad * lat;
  const d = toDays(date);
  const n = Math.round(d - J0 - lw / (2 * PI));
  const ds = J0 + lw / (2 * PI) + n;
  const M = solarMeanAnomaly(ds);
  const L = eclipticLongitude(M);
  const dec = declination(L);
  const jNoon = J2000 + ds + 0.0053 * sin(M) - 0.0069 * sin(2 * L);
  const noon = fromJulian(jNoon);

  const h0 = rad * -0.833; // sun's upper limb at the horizon, with refraction
  const cosW = (sin(h0) - sin(phi) * sin(dec)) / (cos(phi) * cos(dec));
  if (cosW < -1) return { noon, sunrise: null, sunset: null, polar: 'day' };
  if (cosW > 1) return { noon, sunrise: null, sunset: null, polar: 'night' };
  const w = acos(cosW);
  const jSet = J2000 + J0 + (w + lw) / (2 * PI) + n + 0.0053 * sin(M) - 0.0069 * sin(2 * L);
  return { noon, sunrise: fromJulian(jNoon - (jSet - jNoon)), sunset: fromJulian(jSet), polar: null };
}
