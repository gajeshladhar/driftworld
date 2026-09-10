// ── Life cells: scattered pickups that restore a life ───────────────────────
// These float in open air rather than sitting on the ground, because the craft
// can no longer land — a pickup you cannot reach without crashing is a trap.
import * as THREE from 'three';
import { CELLS, VERTICAL_EXAGGERATION } from './config.js?v=969ac6ad';

const COL = 0x3dffa8;
const COL_NEXT = 0xffd24a;

const glow = (hex, opacity = 1) => new THREE.MeshBasicMaterial({
  color: hex, transparent: opacity < 1, opacity,
  blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
});

function makeCell() {
  const g = new THREE.Group();

  const core = new THREE.Mesh(
    new THREE.OctahedronGeometry(11, 0),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  g.add(core);

  const shell = new THREE.Mesh(new THREE.OctahedronGeometry(17, 0), glow(COL, 0.35));
  g.add(shell);

  const ring = new THREE.Mesh(new THREE.TorusGeometry(24, 1.6, 8, 28), glow(COL, 0.8));
  ring.rotation.x = Math.PI / 2;
  g.add(ring);

  // a column so it can be spotted from below and from a distance
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(4.5, 7, CELLS.beaconHeight, 6, 1, true),
    glow(COL, 0.16),
  );
  g.add(beam);

  g.userData = { core, shell, ring, beam };
  return g;
}

export class Nav {
  constructor(scene, store, frame, onCollect = null) {
    this.scene = scene;
    this.store = store;
    this.frame = frame;
    this.onCollect = onCollect;
    this.cells = [];
    this.buoys = this.cells;      // the chart and capture code read .buoys
    this.reached = 0;
    this.nextId = 1;
    this.t = 0;
  }

  _place(player) {
    for (let attempt = 0; attempt < 18; attempt++) {
      const a = Math.random() * Math.PI * 2;
      const d = CELLS.minRange + Math.random() * (CELLS.maxRange - CELLS.minRange);
      const mx = player.mx + (Math.sin(a) * d) / this.frame.k;
      const my = player.my + (Math.cos(a) * d) / this.frame.k;

      const [wx, wz] = this.frame.toWorld(mx, my);
      if (this.cells.some((c) => Math.hypot(c.wx - wx, c.wz - wz) < 600)) continue;

      const h = this.store.heightAtMerc(mx, my);
      if (h === null) continue;
      const y = h * VERTICAL_EXAGGERATION + CELLS.aboveGround;

      const mesh = makeCell();
      mesh.position.set(wx, y, wz);
      this.scene.add(mesh);
      this.cells.push({ id: this.nextId++, mx, my, wx, wz, y, mesh });
      return true;
    }
    return false;
  }

  ensure(player) {
    let guard = 3;
    while (this.cells.length < CELLS.active && guard-- > 0) {
      if (!this._place(player)) break;
    }
  }

  /** Nearest cell, with its 3D distance attached. */
  target(player) {
    const [px, pz] = player.worldPos;
    let best = null, bd = Infinity;
    for (const c of this.cells) {
      const d = Math.hypot(c.wx - px, c.wz - pz, c.y - player.y);
      if (d < bd) { bd = d; best = c; }
    }
    if (best) best.dist = bd;
    return best;
  }

  _remove(i) {
    const c = this.cells[i];
    this.scene.remove(c.mesh);
    c.mesh.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    this.cells.splice(i, 1);
  }

  update(player, dt) {
    this.t += dt;
    const [px, pz] = player.worldPos;
    const tgt = this.target(player);

    for (let i = this.cells.length - 1; i >= 0; i--) {
      const c = this.cells[i];
      const u = c.mesh.userData;
      const isNext = tgt && c.id === tgt.id;
      const col = isNext ? COL_NEXT : COL;
      u.shell.material.color.setHex(col);
      u.ring.material.color.setHex(col);
      u.beam.material.color.setHex(col);
      u.shell.rotation.y = this.t * 0.9;
      u.shell.rotation.x = this.t * 0.5;
      u.ring.rotation.z = this.t * 1.4;
      const pulse = 1 + Math.sin(this.t * 3 + c.id) * 0.08;
      u.core.scale.setScalar(pulse);
      c.mesh.position.y = c.y + Math.sin(this.t * 1.4 + c.id) * 9;

      const d = Math.hypot(c.wx - px, c.wz - pz, c.mesh.position.y - player.y);
      if (d < CELLS.reachRadius) {
        this.onCollect?.(c);
        this._remove(i);
        this.reached++;
      } else if (Math.hypot(c.wx - px, c.wz - pz) > CELLS.maxRange * 2.4) {
        this._remove(i);          // outrun; a fresh one will appear ahead
      }
    }
    this.ensure(player);
    return this.target(player);
  }
}
