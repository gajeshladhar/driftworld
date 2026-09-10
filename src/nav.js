// ── Navigation: waypoint buoys with visible light columns ───────────────────
import * as THREE from 'three';
import { NAV, VERTICAL_EXAGGERATION } from './config.js?v=de65e7b7';

const COL_A = 0xff7a3d;   // buoy
const COL_B = 0xffd24a;   // current target

function makeBeacon() {
  const g = new THREE.Group();

  const pole = new THREE.Mesh(
    new THREE.BoxGeometry(2.4, 16, 2.4),
    new THREE.MeshBasicMaterial({ color: 0xf2f2f2 }),
  );
  pole.position.y = 8;
  g.add(pole);

  const drum = new THREE.Mesh(
    new THREE.CylinderGeometry(5.5, 6.5, 7, 8),
    new THREE.MeshBasicMaterial({ color: COL_A }),
  );
  drum.position.y = 3.5;
  g.add(drum);

  const lamp = new THREE.Mesh(
    new THREE.BoxGeometry(4.5, 4.5, 4.5),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  lamp.position.y = 18;
  g.add(lamp);

  // vertical light column — the thing that makes a buoy findable at 3 km
  const beamMat = new THREE.MeshBasicMaterial({
    color: COL_A, transparent: true, opacity: 0.22,
    depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(3.2, 4.6, NAV.beaconHeight, 6, 1, true),
    beamMat,
  );
  beam.position.y = NAV.beaconHeight / 2;
  g.add(beam);

  g.userData = { drum, lamp, beam, beamMat };
  return g;
}

export class Nav {
  constructor(scene, store, frame, onReach = null) {
    this.onReach = onReach;
    this.scene = scene;
    this.store = store;
    this.frame = frame;
    this.buoys = [];
    this.reached = 0;
    this.nextId = 1;
    this.t = 0;
  }

  _place(player) {
    for (let attempt = 0; attempt < 24; attempt++) {
      const a = Math.random() * Math.PI * 2;
      const d = NAV.minRange + Math.random() * (NAV.maxRange - NAV.minRange);
      const mdx = (Math.sin(a) * d) / this.frame.k;
      const mdy = (Math.cos(a) * d) / this.frame.k;
      const w = this.store.findWaterNear(player.mx + mdx, player.my + mdy, 90);
      if (!w) continue;

      const [wx, wz] = this.frame.toWorld(w[0], w[1]);
      const [px, pz] = player.worldPos;
      if (Math.hypot(wx - px, wz - pz) < NAV.minRange * 0.6) continue;
      // don't stack buoys on top of each other
      if (this.buoys.some((b) => Math.hypot(b.wx - wx, b.wz - wz) < 350)) continue;

      const h = this.store.heightAtMerc(w[0], w[1]);
      const mesh = makeBeacon();
      const y = (h ?? 0) * VERTICAL_EXAGGERATION;
      mesh.position.set(wx, y, wz);
      this.scene.add(mesh);
      this.buoys.push({ id: this.nextId++, mx: w[0], my: w[1], wx, wz, y, mesh });
      return true;
    }
    return false;
  }

  ensure(player) {
    let guard = 3;
    while (this.buoys.length < NAV.buoyCount && guard-- > 0) {
      if (!this._place(player)) break;
    }
  }

  /** Nearest buoy to the player, or null. */
  target(player) {
    const [px, pz] = player.worldPos;
    let best = null, bd = Infinity;
    for (const b of this.buoys) {
      const d = Math.hypot(b.wx - px, b.wz - pz);
      if (d < bd) { bd = d; best = b; }
    }
    if (best) best.dist = bd;
    return best;
  }

  update(player, dt) {
    this.t += dt;
    const [px, pz] = player.worldPos;
    const tgt = this.target(player);

    for (let i = this.buoys.length - 1; i >= 0; i--) {
      const b = this.buoys[i];
      const isTarget = tgt && b.id === tgt.id;
      const u = b.mesh.userData;
      const col = isTarget ? COL_B : COL_A;
      u.drum.material.color.setHex(col);
      u.beamMat.color.setHex(col);
      u.beamMat.opacity = isTarget ? 0.3 : 0.18;
      u.lamp.rotation.y = this.t * 2.2;
      u.lamp.position.y = 18 + Math.sin(this.t * 3 + b.id) * 0.8;
      u.lamp.material.color.setHex(
        Math.sin(this.t * 4 + b.id) > 0 ? 0xffffff : col,
      );

      const d = Math.hypot(b.wx - px, b.wz - pz);
      if (d < NAV.reachRadius) {
        this.onReach?.(b);
        this._remove(i);
        this.reached++;
      } else if (d > NAV.maxRange * 2.2) {
        // outrun — retire it so a fresh one can appear ahead of the player
        this._remove(i);
      }
    }
    this.ensure(player);
    return this.target(player);   // recomputed: the old target may have just been retired
  }

  _remove(i) {
    const b = this.buoys[i];
    this.scene.remove(b.mesh);
    b.mesh.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    this.buoys.splice(i, 1);
  }
}
