// ── Props: instanced scenery scattered by land-cover class ──────────────────
import * as THREE from 'three';
import { TILE_PX, ZOOM, MESH_SEG, VERTICAL_EXAGGERATION, CLASS_ORDER, PROPS } from './config.js?v=d646eb69';
import { tileBBoxMerc, tileSpanMerc } from './geo.js?v=d646eb69';

const IDX = Object.fromEntries(CLASS_ORDER.map((k, i) => [k, i]));
const UP = new THREE.Vector3(0, 1, 0);

/** Deterministic per-tile RNG, so a rebuild never reshuffles the scenery. */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Concatenate small geometries into one, so a whole tree is a single instance. */
function mergeGeos(geos) {
  const parts = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  let total = 0;
  for (const g of parts) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    o += g.attributes.position.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}

function conifer() {
  const trunk = new THREE.CylinderGeometry(0.7, 1.0, 5, 5); trunk.translate(0, 2.5, 0);
  const lower = new THREE.ConeGeometry(4.2, 8, 6);          lower.translate(0, 8, 0);
  const upper = new THREE.ConeGeometry(2.9, 7, 6);          upper.translate(0, 13, 0);
  return mergeGeos([trunk, lower, upper]);
}

function broadleaf() {
  const trunk = new THREE.CylinderGeometry(0.8, 1.1, 5, 5); trunk.translate(0, 2.5, 0);
  const crown = new THREE.IcosahedronGeometry(4.6, 0);      crown.translate(0, 9, 0);
  return mergeGeos([trunk, crown]);
}

function buildingGeo() {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0);          // origin at the base, so scale.y reads as height
  return g;
}

function shrubGeo() {
  const g = new THREE.IcosahedronGeometry(2.2, 0);
  g.scale(1, 0.7, 1); g.translate(0, 1.4, 0);
  return g;
}

function rockGeo() {
  const g = new THREE.IcosahedronGeometry(2.6, 0);
  g.scale(1.2, 0.8, 1); g.translate(0, 1.0, 0);
  return g;
}

const lambert = () => new THREE.MeshLambertMaterial({ color: 0xffffff });

/**
 * Build scenery for one tile.
 *
 * Heights are sampled on the *mesh* grid rather than the raw DEM: the terrain
 * mesh is 48 segments across 256 DEM pixels, so sampling the DEM directly would
 * leave trees floating above or buried in the coarser rendered triangles.
 */
export function buildProps(tile, frame, store) {
  const span = tileSpanMerc(ZOOM);
  const [xmin, , , ymax] = tileBBoxMerc(tile.x, tile.y, ZOOM);
  const rand = mulberry32((tile.x * 73856093) ^ (tile.y * 19349663));
  const group = new THREE.Group();

  const meshHeight = (u, v) => {
    const gx = u * MESH_SEG, gy = v * MESH_SEG;
    const i = Math.min(MESH_SEG - 1, Math.floor(gx));
    const j = Math.min(MESH_SEG - 1, Math.floor(gy));
    const fx = gx - i, fy = gy - j;
    const hAt = (a, b) =>
      store.heightAtMerc(xmin + (a / MESH_SEG) * span, ymax - (b / MESH_SEG) * span) ?? 0;
    const h00 = hAt(i, j),     h10 = hAt(i + 1, j);
    const h01 = hAt(i, j + 1), h11 = hAt(i + 1, j + 1);
    return ((h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy)
           * VERTICAL_EXAGGERATION;
  };

  const buckets = { tree: [], leaf: [], build: [], shrub: [], rock: [] };

  const scatter = (stride, chance, pick) => {
    for (let py = 0; py < TILE_PX; py += stride) {
      for (let px = 0; px < TILE_PX; px += stride) {
        if (rand() > chance) continue;
        const kind = pick(tile.cls[py * TILE_PX + px]);
        if (!kind) continue;
        const jx = px + rand() * stride, jy = py + rand() * stride;
        if (jx >= TILE_PX || jy >= TILE_PX) continue;
        // never place scenery on navigable water
        if (tile.cls[Math.floor(jy) * TILE_PX + Math.floor(jx)] === IDX.WATER) continue;
        const u = jx / TILE_PX, v = jy / TILE_PX;
        const [wx, wz] = frame.toWorld(xmin + u * span, ymax - v * span);
        buckets[kind].push({ wx, wz, y: meshHeight(u, v), r: rand(), s: rand() });
      }
    }
  };

  scatter(PROPS.treeStride, PROPS.treeChance,
    (c) => (c === IDX.TREES ? (rand() < 0.72 ? 'tree' : 'leaf') : null));
  scatter(PROPS.buildStride, PROPS.buildChance,
    (c) => (c === IDX.BUILT ? 'build' : null));
  scatter(PROPS.shrubStride, PROPS.shrubChance,
    (c) => ((c === IDX.RANGELAND || c === IDX.CROPS || c === IDX.FLOODED) ? 'shrub' : null));
  scatter(PROPS.rockStride, PROPS.rockChance,
    (c) => ((c === IDX.BARE || c === IDX.SNOW) ? 'rock' : null));

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const col = new THREE.Color();

  const add = (list, geo, shape) => {
    if (!list.length) { geo.dispose(); return; }
    const inst = new THREE.InstancedMesh(geo, lambert(), list.length);
    for (let i = 0; i < list.length; i++) {
      shape(list[i], pos, scl, q, col);
      m.compose(pos, q, scl);
      inst.setMatrixAt(i, m);
      inst.setColorAt(i, col);
    }
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.computeBoundingSphere();
    group.add(inst);
  };

  add(buckets.tree, conifer(), (p, pp, ss, qq, cc) => {
    const s = 0.75 + p.s * 0.8;
    pp.set(p.wx, p.y - 0.4, p.wz);
    ss.set(s, s * (0.85 + p.r * 0.5), s);
    qq.setFromAxisAngle(UP, p.r * 6.283);
    cc.setHSL(0.29 + p.r * 0.06, 0.30 + p.s * 0.22, 0.17 + p.r * 0.13);
  });

  add(buckets.leaf, broadleaf(), (p, pp, ss, qq, cc) => {
    const s = 0.8 + p.s * 0.7;
    pp.set(p.wx, p.y - 0.4, p.wz);
    ss.set(s, s * (0.8 + p.r * 0.4), s);
    qq.setFromAxisAngle(UP, p.r * 6.283);
    cc.setHSL(0.23 + p.s * 0.09, 0.34 + p.r * 0.20, 0.23 + p.s * 0.14);
  });

  add(buckets.build, buildingGeo(), (p, pp, ss, qq, cc) => {
    const w = 9 + p.r * 16, d = 9 + p.s * 14;
    const h = 8 + Math.pow(p.r, 3) * 95;      // mostly low-rise, a few towers
    pp.set(p.wx, p.y - 0.5, p.wz);
    ss.set(w, h, d);
    qq.setFromAxisAngle(UP, Math.round(p.s * 4) * 0.393);
    cc.setHSL(0.07 + p.s * 0.05, 0.09 + p.r * 0.13, 0.38 + p.s * 0.26);
  });

  add(buckets.shrub, shrubGeo(), (p, pp, ss, qq, cc) => {
    const s = 0.7 + p.s * 0.9;
    pp.set(p.wx, p.y - 0.3, p.wz);
    ss.set(s, s, s);
    qq.setFromAxisAngle(UP, p.r * 6.283);
    cc.setHSL(0.13 + p.r * 0.06, 0.26, 0.34 + p.s * 0.12);
  });

  add(buckets.rock, rockGeo(), (p, pp, ss, qq, cc) => {
    const s = 0.8 + p.s * 1.5;
    pp.set(p.wx, p.y - 0.3, p.wz);
    ss.set(s, s * 0.8, s);
    qq.setFromAxisAngle(UP, p.r * 6.283);
    cc.setHSL(0.09, 0.06, 0.45 + p.s * 0.25);
  });

  return group;
}

export function disposeProps(group) {
  if (!group) return;
  group.traverse((o) => {
    if (o.isInstancedMesh) { o.geometry.dispose(); o.material.dispose(); o.dispose(); }
  });
  group.parent?.remove(group);
}
