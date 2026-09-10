// ── Combat: pursuing jets, homing missiles, and a forward gun ───────────────
// Everything here lives in world space rather than mercator, because it only
// ever exists near the player and never needs to survive a relocate.
//
// The chase is built on one asymmetry: a missile is faster than the craft can
// ever fly, so running is pointless, but it turns worse than you do. Breaking
// hard across its nose makes it overshoot. That is the whole fight.
import * as THREE from 'three';
import { ENEMY, MISSILE, GUN } from './config.js?v=d8439539';

const V = () => new THREE.Vector3();

const glow = (hex, opacity = 1) => new THREE.MeshBasicMaterial({
  color: hex, transparent: opacity < 1, opacity,
  blending: THREE.AdditiveBlending, depthWrite: false,
});

function jetMesh() {
  const g = new THREE.Group();
  const hull = new THREE.MeshLambertMaterial({ color: 0x39404e });
  const dark = new THREE.MeshLambertMaterial({ color: 0x22262f });

  // fuselage: a long tapered body, nose along -Z
  const body = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 4.4, 34, 8), hull);
  body.rotation.x = Math.PI / 2;
  g.add(body);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(2.6, 14, 8), hull);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -24;
  g.add(nose);

  // swept delta wings, drawn as a flat extruded planform so the silhouette
  // reads as an aircraft rather than a lump at any distance
  const wing = new THREE.Shape();
  wing.moveTo(0, -8); wing.lineTo(26, 12); wing.lineTo(26, 17);
  wing.lineTo(3, 13); wing.lineTo(0, 16); wing.lineTo(-3, 13);
  wing.lineTo(-26, 17); wing.lineTo(-26, 12); wing.closePath();
  const wingGeo = new THREE.ExtrudeGeometry(wing, { depth: 1.4, bevelEnabled: false });
  wingGeo.rotateX(-Math.PI / 2);
  const wings = new THREE.Mesh(wingGeo, hull);
  wings.position.y = -0.7;
  g.add(wings);

  // canted twin tails
  for (const sx of [-1, 1]) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(1.2, 11, 9), dark);
    fin.position.set(sx * 6, 5, 14);
    fin.rotation.z = sx * 0.32;
    g.add(fin);
  }

  const canopy = new THREE.Mesh(new THREE.SphereGeometry(3.1, 12, 8), 
    new THREE.MeshLambertMaterial({ color: 0x9fd4e8 }));
  canopy.scale.set(0.9, 0.6, 1.9);
  canopy.position.set(0, 2.4, -11);
  g.add(canopy);

  // twin afterburners: the brightest thing on it, so it is trackable head-on
  for (const sx of [-1, 1]) {
    const can = new THREE.Mesh(new THREE.CylinderGeometry(3, 3.4, 9, 8), dark);
    can.rotation.x = Math.PI / 2;
    can.position.set(sx * 3.6, 0, 19);
    g.add(can);
    const burn = new THREE.Mesh(new THREE.ConeGeometry(2.9, 15, 8, 1, true), glow(0xff7a3d, 0.85));
    burn.rotation.x = Math.PI / 2;
    burn.position.set(sx * 3.6, 0, 29);
    g.add(burn);
  }

  const lamp = new THREE.Mesh(new THREE.SphereGeometry(2.2, 8, 6), glow(0xff2d4a));
  lamp.position.z = -30;
  g.add(lamp);

  g.scale.setScalar(ENEMY.scale);
  return g;
}

function missileMesh() {
  const g = new THREE.Group();
  const skin = new THREE.MeshLambertMaterial({ color: 0xe6ebf2 });

  const body = new THREE.Mesh(new THREE.CylinderGeometry(1.9, 1.9, 22, 8), skin);
  body.rotation.x = Math.PI / 2;
  g.add(body);

  const nose = new THREE.Mesh(new THREE.ConeGeometry(1.9, 7, 8), skin);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -14.5;
  g.add(nose);

  const band = new THREE.Mesh(new THREE.CylinderGeometry(2.05, 2.05, 3, 8),
    new THREE.MeshLambertMaterial({ color: 0xd0412f }));
  band.rotation.x = Math.PI / 2;
  band.position.z = -8;
  g.add(band);

  // four tail fins, so it is recognisably a missile and not a bright dot
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.6, 6, 6), skin);
    fin.position.z = 9;
    fin.rotation.z = (i * Math.PI) / 2;
    fin.position.x = Math.cos((i * Math.PI) / 2) * 3.2;
    fin.position.y = Math.sin((i * Math.PI) / 2) * 3.2;
    g.add(fin);
  }

  const plume = new THREE.Mesh(new THREE.ConeGeometry(2.6, 26, 8, 1, true), glow(0xffc24a, 0.9));
  plume.rotation.x = Math.PI / 2;
  plume.position.z = 24;
  g.add(plume);

  const halo = new THREE.Mesh(new THREE.SphereGeometry(7, 10, 8), glow(0xff9a3d, 0.30));
  halo.position.z = 14;
  g.add(halo);

  g.scale.setScalar(MISSILE.scale);
  return g;
}

export class Combat {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.jets = [];
    this.missiles = [];
    this.bullets = [];
    this.bulletGeo = new THREE.BoxGeometry(1.8, 1.8, 16);
    this.bulletMat = glow(0x8ff5ff);
    this.reset();
  }

  reset() {
    for (const list of [this.jets, this.missiles, this.bullets]) {
      for (const o of list) this._dispose(o.mesh);
      list.length = 0;
    }
    this.t = 0;
    // ?wave=<seconds> brings the first contact forward, for checking the models
    const w = parseFloat(new URLSearchParams(location.search).get('wave'));
    this.nextSpawn = isFinite(w) ? w : ENEMY.firstWave;
    this.cooldown = 0;
    this.kills = 0;
    this.incoming = 0;
    this.nearest = Infinity;
  }

  _dispose(mesh) {
    if (!mesh) return;
    mesh.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    this.group.remove(mesh);
  }

  _playerPos(player, out) {
    const [x, z] = player.worldPos;
    return out.set(x, player.y, z);
  }

  _spawnJet(player) {
    const p = this._playerPos(player, V());
    // Head-on. Being jumped from behind by something you never saw is not a
    // fight, it is a tax; coming in from the front gives you the merge.
    const a = player.heading + (Math.random() - 0.5) * 2 * ENEMY.spawnSpread;
    const d = ENEMY.spawnRange * (0.85 + Math.random() * 0.3);
    const mesh = jetMesh();
    const pos = V().set(p.x + Math.sin(a) * d, p.y + (Math.random() - 0.4) * 260,
                        p.z - Math.cos(a) * d);
    mesh.position.copy(pos);
    this.group.add(mesh);
    this.jets.push({ mesh, pos, vel: V(), hp: ENEMY.health, fire: ENEMY.fireEvery * Math.random() });
  }

  _fireMissile(jet, target) {
    const mesh = missileMesh();
    const dir = V().subVectors(target, jet.pos).normalize();
    const pos = jet.pos.clone().addScaledVector(dir, 40);
    mesh.position.copy(pos);
    this.group.add(mesh);
    this.missiles.push({ mesh, pos, dir, age: 0 });
  }

  fireGun(player) {
    if (this.cooldown > 0) return;
    this.cooldown = GUN.cooldown;
    const p = this._playerPos(player, V());
    const dir = V().set(Math.sin(player.heading), 0, -Math.cos(player.heading)).normalize();
    const mesh = new THREE.Mesh(this.bulletGeo, this.bulletMat);
    mesh.position.copy(p).addScaledVector(dir, 30);
    mesh.lookAt(mesh.position.clone().add(dir));
    this.group.add(mesh);
    this.bullets.push({ mesh, pos: mesh.position.clone(), dir, age: 0 });
  }

  /** @returns {boolean} true on the frame the player is hit */
  update(dt, player, input) {
    this.t += dt;
    this.cooldown -= dt;
    const p = this._playerPos(player, V());
    let hit = false;

    if (input.fire) this.fireGun(player);

    // ── spawning ──
    if (this.t > this.nextSpawn && this.jets.length < ENEMY.maxActive) {
      this.nextSpawn = this.t + ENEMY.spawnEvery;
      this._spawnJet(player);
    }

    // ── jets ──
    for (let i = this.jets.length - 1; i >= 0; i--) {
      const j = this.jets[i];
      const to = V().subVectors(p, j.pos);
      const dist = to.length();
      if (dist > ENEMY.despawn || j.hp <= 0) {
        this._dispose(j.mesh);
        this.jets.splice(i, 1);
        continue;
      }
      to.normalize();

      // hold station rather than colliding: close if far, ease off if too near
      const want = dist > ENEMY.standoff ? to : to.clone().negate();
      j.vel.lerp(want.multiplyScalar(ENEMY.speed), Math.min(1, dt * ENEMY.turnRate));
      j.pos.addScaledVector(j.vel, dt);
      j.mesh.position.copy(j.pos);
      j.mesh.lookAt(j.pos.clone().add(j.vel));

      j.fire -= dt;
      if (j.fire <= 0 && dist < ENEMY.fireRange) {
        j.fire = ENEMY.fireEvery;
        this._fireMissile(j, p);
      }
    }

    // ── missiles ──
    this.incoming = this.missiles.length;
    this.nearest = Infinity;
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      m.age += dt;

      // A true rate limit, not a lerp. Lerping toward the target turns fastest
      // when the error is largest, which let the missile whip round and beat any
      // break. Capping the turn at turnRate rad/s fixes its radius at
      // speed/turnRate, and that radius is deliberately wider than the craft's.
      const to = V().subVectors(p, m.pos).normalize();
      const ang = m.dir.angleTo(to);
      if (ang > 1e-4) {
        const axis = V().crossVectors(m.dir, to);
        if (axis.lengthSq() > 1e-9) {
          axis.normalize();
          m.dir.applyAxisAngle(axis, Math.min(ang, MISSILE.turnRate * dt)).normalize();
        }
      }
      m.pos.addScaledVector(m.dir, MISSILE.speed * dt);
      m.mesh.position.copy(m.pos);
      m.mesh.lookAt(m.pos.clone().add(m.dir));

      const d = m.pos.distanceTo(p);
      this.nearest = Math.min(this.nearest, d);

      if (m.age > MISSILE.armAfter && d < MISSILE.hitRadius) {
        hit = true;
        this._dispose(m.mesh);
        this.missiles.splice(i, 1);
      } else if (m.age > MISSILE.life) {
        this._dispose(m.mesh);
        this.missiles.splice(i, 1);
      }
    }

    // ── player gunfire ──
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      b.age += dt;
      b.pos.addScaledVector(b.dir, GUN.speed * dt);
      b.mesh.position.copy(b.pos);

      let spent = b.age > GUN.life;
      if (!spent) {
        for (const j of this.jets) {
          if (b.pos.distanceTo(j.pos) < GUN.hitRadius) {
            j.hp -= 1;
            if (j.hp <= 0) this.kills++;
            spent = true;
            break;
          }
        }
      }
      if (spent) {
        this.group.remove(b.mesh);       // geometry and material are shared
        this.bullets.splice(i, 1);
      }
    }

    return hit;
  }
}
