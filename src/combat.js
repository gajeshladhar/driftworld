// ── Combat: pursuing jets, homing missiles, and a forward gun ───────────────
// Everything here lives in world space rather than mercator, because it only
// ever exists near the player and never needs to survive a relocate.
//
// The chase is built on one asymmetry: a missile is faster than the craft can
// ever fly, so running is pointless, but it turns worse than you do. Breaking
// hard across its nose makes it overshoot. That is the whole fight.
import * as THREE from 'three';
import { ENEMY, MISSILE, GUN } from './config.js?v=cc9cefc5';

const V = () => new THREE.Vector3();

const glow = (hex, opacity = 1) => new THREE.MeshBasicMaterial({
  color: hex, transparent: opacity < 1, opacity,
  blending: THREE.AdditiveBlending, depthWrite: false,
});

function jetMesh() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.ConeGeometry(6, 34, 5),
    new THREE.MeshLambertMaterial({ color: 0x2a2f3a }),
  );
  body.rotation.x = -Math.PI / 2;          // nose along -Z
  g.add(body);

  const wing = new THREE.Mesh(
    new THREE.BoxGeometry(38, 1.6, 9),
    new THREE.MeshLambertMaterial({ color: 0x353b48 }),
  );
  wing.position.z = 5;
  g.add(wing);

  const tail = new THREE.Mesh(
    new THREE.BoxGeometry(1.6, 10, 8),
    new THREE.MeshLambertMaterial({ color: 0x353b48 }),
  );
  tail.position.set(0, 5, 14);
  g.add(tail);

  const burn = new THREE.Mesh(new THREE.ConeGeometry(4.2, 16, 8, 1, true), glow(0xff6a3d, 0.75));
  burn.rotation.x = Math.PI / 2;
  burn.position.z = 24;
  g.add(burn);

  const eye = new THREE.Mesh(new THREE.SphereGeometry(2.6, 8, 6), glow(0xff2d4a));
  eye.position.z = -14;
  g.add(eye);
  return g;
}

function missileMesh() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(1.5, 1.5, 12, 6),
    new THREE.MeshBasicMaterial({ color: 0xd8dde6 }),
  );
  body.rotation.x = Math.PI / 2;
  g.add(body);
  const flame = new THREE.Mesh(new THREE.ConeGeometry(3.2, 22, 7, 1, true), glow(0xffb03a, 0.85));
  flame.rotation.x = -Math.PI / 2;
  flame.position.z = 16;
  g.add(flame);
  const halo = new THREE.Mesh(new THREE.SphereGeometry(5.5, 8, 6), glow(0xff7a3d, 0.35));
  g.add(halo);
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
    this.nextSpawn = ENEMY.firstWave;
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
    // come in from behind or the flank, never straight into your guns
    const a = player.heading + Math.PI + (Math.random() - 0.5) * 2.2;
    const d = ENEMY.spawnRange * (0.75 + Math.random() * 0.5);
    const mesh = jetMesh();
    const pos = V().set(p.x + Math.sin(a) * d, p.y + (Math.random() - 0.4) * 320,
                        p.z - Math.cos(a) * d);
    mesh.position.copy(pos);
    this.group.add(mesh);
    this.jets.push({ mesh, pos, vel: V(), hp: ENEMY.health, fire: ENEMY.fireEvery * Math.random() });
  }

  _fireMissile(jet, target) {
    const mesh = missileMesh();
    const dir = V().subVectors(target, jet.pos).normalize();
    const pos = jet.pos.clone().addScaledVector(dir, 26);
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
