// ── Backdrop: coarse distant terrain, streamed only when you climb ─────────
// The detail grid stays at ZOOM because collision and scenery need 10 m land
// cover, and up high 7x7 of those tiles cannot reach the horizon. This draws a
// much wider, much cheaper shell underneath it: five z9 tiles span more ground
// than two hundred z13 tiles and arrive in a fraction of the time.
import * as THREE from 'three';
import { BACKDROP, VERTICAL_EXAGGERATION, TILE_PX } from './config.js';
import { tileBBoxMerc, tileSpanMerc, mercToTile } from './geo.js';

export class Backdrop {
  constructor(scene, store, frame, baseMaterial) {
    this.scene = scene;
    this.store = store;
    this.frame = frame;
    this.base = baseMaterial;
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    this.materials = [];
    this.meshes = new Map();
    this.zoom = 0;
  }

  setTime(t) { for (const m of this.materials) m.uniforms.uTime.value = t; }

  setFog(near, far) {
    for (const m of this.materials) {
      m.uniforms.uFogNear.value = near;
      m.uniforms.uFogFar.value = far;
    }
  }

  _zoomFor(alt) {
    const steps = Math.floor(Math.log2(Math.max(1, alt / BACKDROP.minAltitude)));
    return Math.max(BACKDROP.minZoom, Math.min(BACKDROP.maxZoom, BACKDROP.maxZoom - steps));
  }

  _build(tile) {
    const z = tile.z, seg = BACKDROP.seg, span = tileSpanMerc(z);
    const [xmin, , , ymax] = tileBBoxMerc(tile.x, tile.y, z);
    const n = seg + 1;
    const pos = new Float32Array(n * n * 3);
    const uvs = new Float32Array(n * n * 2);

    for (let j = 0; j < n; j++) {
      const v = j / seg;
      const py = Math.min(TILE_PX - 1, Math.floor(v * TILE_PX));
      for (let i = 0; i < n; i++) {
        const u = i / seg;
        const px = Math.min(TILE_PX - 1, Math.floor(u * TILE_PX));
        const [wx, wz] = this.frame.toWorld(xmin + u * span, ymax - v * span);
        const o = (j * n + i) * 3;
        pos[o] = wx;
        pos[o + 1] = tile.dem[py * TILE_PX + px] * VERTICAL_EXAGGERATION;
        pos[o + 2] = wz;
        const t = (j * n + i) * 2;
        uvs[t] = u; uvs[t + 1] = 1 - v;
      }
    }

    const idx = [];
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const mat = this.base.clone();
    mat.uniforms.uLulc.value = tile.texture;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = 4;
    mat.polygonOffsetUnits = 8;
    this.materials.push(mat);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = -25;      // sit behind the detail grid where they overlap
    mesh.renderOrder = -1;
    this.group.add(mesh);
    return mesh;
  }

  _drop(k) {
    const mesh = this.meshes.get(k);
    if (!mesh) return;
    const i = this.materials.indexOf(mesh.material);
    if (i >= 0) this.materials.splice(i, 1);
    mesh.geometry.dispose();
    mesh.material.dispose();
    this.group.remove(mesh);
    this.meshes.delete(k);
    this.store.dispose(k);
  }

  clear() { for (const k of [...this.meshes.keys()]) this._drop(k); }

  update(mx, my, alt) {
    if (alt < BACKDROP.minAltitude) {
      if (this.group.visible) { this.group.visible = false; this.clear(); }
      return;
    }
    this.group.visible = true;

    const z = this._zoomFor(alt);
    if (z !== this.zoom) { this.clear(); this.zoom = z; }

    const r = Math.floor(BACKDROP.grid / 2);
    const [cx, cy] = mercToTile(mx, my, z);
    const wanted = new Set();
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const tx = cx + dx, ty = cy + dy;
        const k = `${z}/${tx}/${ty}`;
        wanted.add(k);
        if (this.meshes.has(k)) continue;
        const have = this.store.get(tx, ty, z);
        if (have) this.meshes.set(k, this._build(have));
        else this.store.request(tx, ty, z);
      }
    }
    for (const k of [...this.meshes.keys()]) if (!wanted.has(k)) this._drop(k);
  }
}
