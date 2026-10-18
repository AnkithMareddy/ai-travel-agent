// Sunrise/sunset times and the sun's compass direction at those moments (NOAA-style approximation, ±2 min).
const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
const J1970 = 2440588;
const J2000 = 2451545;

const toJulian = (date) => date.valueOf() / DAY_MS - 0.5 + J1970;
const fromJulian = (j) => new Date((j + 0.5 - J1970) * DAY_MS);
const solarMeanAnomaly = (d) => RAD * (357.5291 + 0.98560028 * d);
const eclipticLongitude = (M) => {
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  return M + C + RAD * 102.9372 + Math.PI;
};
const declination = (L) => Math.asin(Math.sin(L) * Math.sin(RAD * 23.4397));

/**
 * Sun times for the local calendar day containing `date` at (lat, lng).
 * Returns { sunrise, sunset, goldenStart, goldenEnd, riseAzimuth, setAzimuth } (Dates; azimuths in degrees from north).
 * goldenStart = ~45 min before sunset; goldenEnd = ~45 min after sunrise.
 */
export function sunTimes(date, lat, lng) {
  const lw = RAD * -lng;
  const phi = RAD * lat;
  const d = toJulian(date) - J2000;
  const n = Math.round(d - 0.0009 - lw / (2 * Math.PI));
  const ds = 0.0009 + lw / (2 * Math.PI) + n;
  const M = solarMeanAnomaly(ds);
  const L = eclipticLongitude(M);
  const dec = declination(L);
  const Jnoon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const h0 = RAD * -0.833; // sun's upper edge at the horizon, with refraction
  const w = Math.acos((Math.sin(h0) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));
  const a = 0.0009 + (w + lw) / (2 * Math.PI) + n;
  const Jset = J2000 + a + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const Jrise = Jnoon - (Jset - Jnoon);
  const sunset = fromJulian(Jset);
  const sunrise = fromJulian(Jrise);
  // Where on the horizon the sun rises/sets: cos(A) = sin(dec) / cos(lat), measured from north.
  const A = Math.acos(Math.max(-1, Math.min(1, Math.sin(dec) / Math.cos(phi)))) / RAD;
  return {
    sunrise, sunset,
    goldenStart: new Date(sunset - 45 * 60_000),
    goldenEnd: new Date(sunrise.valueOf() + 45 * 60_000),
    riseAzimuth: Math.round(A),
    setAzimuth: Math.round(360 - A),
  };
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (deg) => POINTS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
