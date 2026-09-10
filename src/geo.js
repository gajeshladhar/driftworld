// ── Web Mercator ⇄ world-space maths ─────────────────────────────────────────
// World space is metres, Y-up, X-east, Z-south, with the origin at the spawn
// point. Mercator metres are scaled by cos(lat0) so distances read true.

export const MERC_R = 20037508.342789244;

export function lonLatToMerc(lon, lat) {
  const x = (lon / 180) * MERC_R;
  const s = Math.sin((lat * Math.PI) / 180);
  const y = (MERC_R / Math.PI) * 0.5 * Math.log((1 + s) / (1 - s));
  return [x, y];
}

export function mercToLonLat(x, y) {
  const lon = (x / MERC_R) * 180;
  const lat = (Math.atan(Math.exp((y / MERC_R) * Math.PI)) * 2 - Math.PI / 2) * (180 / Math.PI);
  return [lon, lat];
}

/** Mercator metres per tile edge at zoom z. */
export const tileSpanMerc = (z) => (2 * MERC_R) / Math.pow(2, z);

export function mercToTile(mx, my, z) {
  const span = tileSpanMerc(z);
  return [Math.floor((mx + MERC_R) / span), Math.floor((MERC_R - my) / span)];
}

/** [xmin, ymin, xmax, ymax] in EPSG:3857 for an XYZ tile. */
export function tileBBoxMerc(x, y, z) {
  const span = tileSpanMerc(z);
  const xmin = -MERC_R + x * span;
  const ymax = MERC_R - y * span;
  return [xmin, ymax - span, xmin + span, ymax];
}

/**
 * Projection between mercator metres and world metres.
 * Mercator inflates distance by 1/cos(lat); undo it at the origin latitude.
 */
export function makeFrame(lon0, lat0) {
  const [ox, oy] = lonLatToMerc(lon0, lat0);
  const k = Math.cos((lat0 * Math.PI) / 180);
  return {
    ox, oy, k,
    toWorld: (mx, my) => [(mx - ox) * k, -(my - oy) * k],   // → [X, Z]
    toMerc:  (wx, wz) => [wx / k + ox, -wz / k + oy],       // → [mx, my]
    spanWorld: (z) => tileSpanMerc(z) * k,
  };
}
