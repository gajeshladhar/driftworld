// ── Tile store: streams LULC + DEM, decodes to samplable global grids ────────
import * as THREE from 'three';
import { LULC_SERVICE, DEM_URL, TILE_PX, ZOOM, MAX_INFLIGHT, CLASSES, CLASS_ORDER, MINIMAP } from './config.js';
import { tileBBoxMerc, tileSpanMerc, MERC_R } from './geo.js';

const key = (x, y, z) => `${z}/${x}/${y}`;

// Exact RGB → class index. The ImageServer returns unblended palette colours
// under nearest-neighbour resampling, so a hash lookup is exact — see README.
const PACK = (r, g, b) => (r << 16) | (g << 8) | b;
const CLASS_LUT = new Map(
  CLASS_ORDER.map((k, i) => [PACK(...CLASSES[k].rgb), i]),
);
const WATER_IDX = CLASS_ORDER.indexOf('WATER');
const ART = CLASS_ORDER.map((k) => CLASSES[k].art);

/**
 * Downsample a class grid to a minimap thumbnail. Water wins any block it
 * appears in — block-max rather than nearest — so narrow channels survive the
 * reduction. On a navigation aid, a river you can actually drive matters more
 * than which class covers the most area.
 */
function makeThumb(cls) {
  const T = MINIMAP.thumbPx, f = TILE_PX / T;
  const c = document.createElement('canvas');
  c.width = c.height = T;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(T, T);
  for (let ty = 0; ty < T; ty++) {
    for (let tx = 0; tx < T; tx++) {
      let pick = 255, water = false;
      for (let j = 0; j < f && !water; j++) {
        for (let i = 0; i < f; i++) {
          const cv = cls[(ty * f + j) * TILE_PX + (tx * f + i)];
          if (cv === WATER_IDX) { water = true; break; }
          if (pick === 255) pick = cv;
        }
      }
      const idx = water ? WATER_IDX : pick;
      const col = idx === 255 ? [22, 32, 42] : ART[idx];
      const o = (ty * T + tx) * 4;
      img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';           // required to read pixels back
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('tile fetch failed: ' + url));
    img.src = url;
  });
}

function readPixels(img) {
  const c = document.createElement('canvas');
  c.width = c.height = TILE_PX;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, TILE_PX, TILE_PX);
  return ctx.getImageData(0, 0, TILE_PX, TILE_PX).data;
}

function lulcURL(x, y, z) {
  const bb = tileBBoxMerc(x, y, z).join(',');
  return `${LULC_SERVICE}?bbox=${bb}&bboxSR=3857&imageSR=3857` +
         `&size=${TILE_PX},${TILE_PX}&format=png&interpolation=RSP_NearestNeighbor&f=image`;
}

export class TileStore {
  constructor() {
    this.tiles    = new Map();   // key → tile record
    this.pending  = new Map();   // key → promise
    this.queue    = [];
    this.inflight = 0;
    this.stats    = { loaded: 0, failed: 0, queued: 0 };
  }

  get(x, y, z = ZOOM) { return this.tiles.get(key(x, y, z)) || null; }

  /** Queue a tile for loading; resolves with the tile record (or null). */
  request(x, y, z = ZOOM) {
    const k = key(x, y, z);
    if (this.tiles.has(k))   return Promise.resolve(this.tiles.get(k));
    if (this.pending.has(k)) return this.pending.get(k);

    const p = new Promise((resolve) => {
      this.queue.push({ x, y, z, k, resolve });
      this.stats.queued = this.queue.length;
      this._pump();
    });
    this.pending.set(k, p);
    return p;
  }

  _pump() {
    while (this.inflight < MAX_INFLIGHT && this.queue.length) {
      const job = this.queue.shift();
      this.stats.queued = this.queue.length;
      this.inflight++;
      this._fetch(job.x, job.y, job.z)
        .then((tile) => {
          this.tiles.set(job.k, tile);
          this.stats.loaded++;
          job.resolve(tile);
        })
        .catch(() => { this.stats.failed++; job.resolve(null); })
        .finally(() => {
          this.inflight--;
          this.pending.delete(job.k);
          this._pump();
        });
    }
  }

  async _fetch(x, y, z = ZOOM) {
    const [lulcImg, demImg] = await Promise.all([
      loadImage(lulcURL(x, y, z)),
      loadImage(DEM_URL(z, x, y)),
    ]);

    // ── land cover → texture + exact-match water mask ──
    const lp   = readPixels(lulcImg);
    const cls  = new Uint8Array(TILE_PX * TILE_PX);
    const mask = new Uint8Array(TILE_PX * TILE_PX);
    for (let i = 0, p = 0; i < cls.length; i++, p += 4) {
      const c = CLASS_LUT.get(PACK(lp[p], lp[p + 1], lp[p + 2]));
      cls[i] = c === undefined ? 255 : c;      // 255 = outside coverage / no data
      if (cls[i] === WATER_IDX) mask[i] = 1;
    }

    const texture = new THREE.Texture(lulcImg);
    texture.magFilter = THREE.NearestFilter;   // keep class edges hard
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;

    // ── DEM: terrarium encoding h = (R*256 + G + B/256) - 32768 ──
    const dp  = readPixels(demImg);
    const dem = new Float32Array(TILE_PX * TILE_PX);
    for (let i = 0, p = 0; i < dem.length; i++, p += 4) {
      dem[i] = dp[p] * 256 + dp[p + 1] + dp[p + 2] / 256 - 32768;
    }

    // thumbnails feed the minimap, which only ever draws the detail layer
    const thumb = z === ZOOM ? makeThumb(cls) : null;
    return { x, y, z, texture, mask, cls, dem, thumb, mesh: null };
  }

  dispose(k) {
    const t = this.tiles.get(k);
    if (!t) return;
    t.texture?.dispose();
    if (t.mesh) {
      t.mesh.geometry.dispose();
      t.mesh.material.dispose();
      t.mesh.parent?.remove(t.mesh);
    }
    this.tiles.delete(k);
  }

  // ── Global samplers (tile-boundary safe: every lookup goes through global
  //    pixel coordinates, so neighbouring meshes agree exactly on shared edges)

  _globalPx(mx, my) {
    const span = tileSpanMerc(ZOOM);
    return [((mx + MERC_R) / span) * TILE_PX, ((MERC_R - my) / span) * TILE_PX];
  }

  _demAt(gx, gy) {
    const tx = Math.floor(gx / TILE_PX), ty = Math.floor(gy / TILE_PX);
    const t = this.tiles.get(key(tx, ty, ZOOM));
    if (!t) return null;
    const px = Math.min(TILE_PX - 1, Math.max(0, Math.floor(gx - tx * TILE_PX)));
    const py = Math.min(TILE_PX - 1, Math.max(0, Math.floor(gy - ty * TILE_PX)));
    return t.dem[py * TILE_PX + px];
  }

  /** Bilinear elevation in metres at a mercator position; null if unloaded. */
  heightAtMerc(mx, my) {
    const [gx, gy] = this._globalPx(mx, my);
    const x0 = Math.floor(gx - 0.5), y0 = Math.floor(gy - 0.5);
    const fx = gx - 0.5 - x0,        fy = gy - 0.5 - y0;
    const h00 = this._demAt(x0, y0),     h10 = this._demAt(x0 + 1, y0);
    const h01 = this._demAt(x0, y0 + 1), h11 = this._demAt(x0 + 1, y0 + 1);
    if (h00 === null || h10 === null || h01 === null || h11 === null) {
      return h00 ?? h10 ?? h01 ?? h11;
    }
    return (h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy;
  }

  /** True where the LULC class is Water. Nearest-sampled — no interpolation. */
  isWaterAtMerc(mx, my) {
    const [gx, gy] = this._globalPx(mx, my);
    const tx = Math.floor(gx / TILE_PX), ty = Math.floor(gy / TILE_PX);
    const t = this.tiles.get(key(tx, ty, ZOOM));
    if (!t) return false;
    const px = Math.min(TILE_PX - 1, Math.max(0, Math.floor(gx - tx * TILE_PX)));
    const py = Math.min(TILE_PX - 1, Math.max(0, Math.floor(gy - ty * TILE_PX)));
    return t.mask[py * TILE_PX + px] === 1;
  }

  /** Land-cover class name at a mercator position, or null if unloaded. */
  classAtMerc(mx, my) {
    const [gx, gy] = this._globalPx(mx, my);
    const tx = Math.floor(gx / TILE_PX), ty = Math.floor(gy / TILE_PX);
    const t = this.tiles.get(key(tx, ty, ZOOM));
    if (!t) return null;
    const px = Math.min(TILE_PX - 1, Math.max(0, Math.floor(gx - tx * TILE_PX)));
    const py = Math.min(TILE_PX - 1, Math.max(0, Math.floor(gy - ty * TILE_PX)));
    const c = t.cls[py * TILE_PX + px];
    return c === 255 ? 'No data' : CLASSES[CLASS_ORDER[c]].name;
  }

  /** Nearest water pixel to a mercator point, searched outward. For spawning. */
  findWaterNear(mx, my, maxRingPx = 400) {
    const [gx, gy] = this._globalPx(mx, my);
    const span = tileSpanMerc(ZOOM), mPerPx = span / TILE_PX;
    const cx = Math.floor(gx), cy = Math.floor(gy);
    for (let r = 0; r <= maxRingPx; r += 2) {
      for (let dy = -r; dy <= r; dy += 2) {
        for (let dx = -r; dx <= r; dx += 2) {
          if (r > 0 && Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
          const tx = Math.floor((cx + dx) / TILE_PX), ty = Math.floor((cy + dy) / TILE_PX);
          const t = this.tiles.get(key(tx, ty, ZOOM));
          if (!t) continue;
          const px = (cx + dx) - tx * TILE_PX, py = (cy + dy) - ty * TILE_PX;
          if (px < 0 || py < 0 || px >= TILE_PX || py >= TILE_PX) continue;
          if (t.mask[py * TILE_PX + px] === 1) {
            return [ -MERC_R + (cx + dx + 0.5) * mPerPx, MERC_R - (cy + dy + 0.5) * mPerPx ];
          }
        }
      }
    }
    return null;
  }
}
