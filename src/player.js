// ── Player: speedboat constrained to the Water class, plus a free-fly mode ───
import { BOAT, FLY, VERTICAL_EXAGGERATION, WEATHER } from './config.js?v=de65e7b7';

const HALF_BEAM = 5;   // metres either side of the keel used for hull clearance

export class Player {
  constructor(store, frame, mx, my) {
    this.store = store;
    this.frame = frame;
    this.mx = mx; this.my = my;
    this.heading = 0;          // radians, 0 = north (-Z); +heading turns east/right
    this.speed = 0;
    this.steer = 0;            // smoothed steering input, -1..1
    this.yawRate = 0;
    this.mode = 'boat';
    this.altitude = 0;
    this.y = 0;
    this.bob = 0;
    this.blocked = false;
    this.roll = 0;
    this.pitch = 0;      // +ve = nose up (rotation about X in a YXZ frame)
    this.vy = 0;         // vertical rate, fly mode
    this.grounded = false;
    this.windX = 0; this.windZ = 0;    // world-space drift from live wind
  }

  /**
   * Real wind, in world axes. Meteorological direction is where the wind comes
   * FROM, so the push is 180 degrees off it.
   */
  setWind(speed, fromDeg) {
    const to = ((fromDeg ?? 0) + 180) * (Math.PI / 180);
    const v = (speed ?? 0) * WEATHER.windDrift;
    this.windX = Math.sin(to) * v;
    this.windZ = -Math.cos(to) * v;
  }

  get worldPos() { return this.frame.toWorld(this.mx, this.my); }
  get forward()  { return [Math.sin(this.heading), -Math.cos(this.heading)]; }
  get right()    { return [Math.cos(this.heading),  Math.sin(this.heading)]; }

  /** Water surface / ground height in world units at the current position. */
  groundY() {
    const h = this.store.heightAtMerc(this.mx, this.my);
    return (h ?? 0) * VERTICAL_EXAGGERATION;
  }

  toggleMode() {
    if (this.mode === 'boat') {
      this.mode = 'fly';
      this.altitude = Math.max(this.y + 160, this.groundY() + 160);
    } else {
      this.mode = 'boat';
      this.speed = Math.min(this.speed, BOAT.maxSpeed);
      if (!this.store.isWaterAtMerc(this.mx, this.my)) {
        const w = this.store.findWaterNear(this.mx, this.my, 300);
        if (w) { this.mx = w[0]; this.my = w[1]; }
      }
    }
  }

  _toMercDelta(dx, dz) { return [dx / this.frame.k, -dz / this.frame.k]; }

  /** Is the world-space offset (dx,dz) from the current position over water? */
  _waterAt(dx, dz) {
    const [mdx, mdy] = this._toMercDelta(dx, dz);
    return this.store.isWaterAtMerc(this.mx + mdx, this.my + mdy);
  }

  /**
   * Hull clearance test: the new centre, the bow ahead of it, and both
   * shoulders. Testing a single point lets the hull clip corners and makes
   * narrow channels feel like they are snagging.
   */
  _clear(dx, dz, probe) {
    const [fx, fz] = this.forward;
    const [rx, rz] = this.right;
    const s = Math.sign(this.speed) || 1;
    const bx = dx + fx * probe * s, bz = dz + fz * probe * s;
    return this._waterAt(dx, dz)
        && this._waterAt(bx, bz)
        && this._waterAt(bx + rx * HALF_BEAM, bz + rz * HALF_BEAM)
        && this._waterAt(bx - rx * HALF_BEAM, bz - rz * HALF_BEAM);
  }

  /** Unit vector pointing away from nearby land, for wall-sliding. */
  _shoreNormal(dx, dz, r) {
    let nx = 0, nz = 0, hits = 0;
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      const ox = Math.cos(a) * r, oz = Math.sin(a) * r;
      if (!this._waterAt(dx + ox, dz + oz)) { nx -= Math.cos(a); nz -= Math.sin(a); hits++; }
    }
    if (!hits) return null;
    const L = Math.hypot(nx, nz);
    return L < 1e-6 ? null : { x: nx / L, z: nz / L };
  }

  _apply(dx, dz) {
    const [mdx, mdy] = this._toMercDelta(dx, dz);
    this.mx += mdx; this.my += mdy;
  }

  update(dt, input) {
    const cfg = this.mode === 'boat' ? BOAT : FLY;

    // ── steering input: ramped, not instant. D = right, A = left. ──
    const want = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    this.steer += (want - this.steer) * Math.min(1, dt * cfg.steerLerp);

    // ── throttle: nothing moves the boat unless a key is held ──
    if (this.mode === 'boat') {
      const boosting = !!input.boost && this.speed >= 0;
      const top = boosting ? BOAT.boostMax : BOAT.maxSpeed;
      if (input.fwd) {
        this.speed += (boosting ? BOAT.boostAccel : BOAT.accel) * dt;
      } else if (input.back) {
        // brake first, then reverse — like a car, not a throttle slider
        this.speed -= (this.speed > 0.5 ? BOAT.brakeAccel : BOAT.accel * 0.55) * dt;
      } else {
        this.speed -= this.speed * BOAT.coastDrag * dt;
        if (Math.abs(this.speed) < 0.15) this.speed = 0;
      }
      this.speed = Math.max(-BOAT.reverseMax, Math.min(top, this.speed));
    } else {
      if (input.fwd)       this.speed += FLY.accel * dt;
      else if (input.back) this.speed -= FLY.accel * 1.2 * dt;
      else                 this.speed -= this.speed * FLY.drag * dt;
      this.speed = Math.max(-FLY.maxSpeed * 0.3, Math.min(FLY.maxSpeed, this.speed));
    }

    // ── speed-gated yaw: no rotation at a standstill, wider circle at speed ──
    const v = Math.abs(this.speed);
    const authority = Math.min(1, v / cfg.turnFullAt);
    const widen = 1 / (1 + (v / cfg.maxSpeed) * cfg.turnFalloff);
    const dir = Math.sign(this.speed);           // reversing steers inverted
    this.yawRate = this.steer * cfg.turnRate * authority * widen * dir;
    this.heading += this.yawRate * dt;

    const targetRoll = -this.steer * authority * 0.42;
    this.roll += (targetRoll - this.roll) * Math.min(1, dt * 5);

    const [fx, fz] = this.forward;
    const step = this.speed * dt;
    // the hull is pushed by the actual wind at this place, right now
    let dx = fx * step + this.windX * dt, dz = fz * step + this.windZ * dt;

    if (this.mode === 'fly') {
      this._apply(dx, dz);

      // Vertical rate is eased rather than applied directly, so climbing has
      // weight. There is no ceiling — hold climb and you keep going up.
      const climb = (input.up ? 1 : 0) - (input.down ? 1 : 0);
      const rate = FLY.climbRate * (input.boost ? FLY.boostClimb : 1);
      this.vy += (climb * rate - this.vy) * Math.min(1, dt * 2.6);
      this.altitude += this.vy * dt;
      this.altitude = Math.max(this.groundY() + 25, this.altitude);

      this.y += (this.altitude - this.y) * Math.min(1, dt * 6);
      this.pitch = Math.max(-1, Math.min(1, this.vy / FLY.climbRate)) * 0.42;
      this.blocked = false;
      this.grounded = false;
      return;
    }
    this.vy = 0;

    // ── boat: only the Water class is navigable ──
    const probe = 14 + v * 0.12;
    this.blocked = false;

    if (step !== 0 && !this._clear(dx, dz, probe)) {
      // slide along the shoreline rather than dead-stopping on it
      const n = this._shoreNormal(dx, dz, probe);
      let slid = false;
      if (n) {
        const dot = dx * n.x + dz * n.z;
        const tx = dx - n.x * dot, tz = dz - n.z * dot;
        if ((tx !== 0 || tz !== 0) && this._clear(tx, tz, probe)) {
          this._apply(tx, tz);
          this.speed *= 0.985;        // barely scrub speed while grazing a shore
          slid = true;
        }
      }
      if (!slid) {
        this.speed *= 0.35;
        this.blocked = true;
      }
    } else if (step !== 0) {
      this._apply(dx, dz);
    }

    this.grounded = !this.store.isWaterAtMerc(this.mx, this.my);

    // sit on the water surface, with bow lift and chop
    this.bob += dt * (2.4 + v * 0.05);
    const planing = Math.min(v / BOAT.maxSpeed, 1);
    this.pitch = planing * 0.07;            // nose lifts as it comes onto plane
    const lift = planing * BOAT.hullLift;
    const target = this.groundY() + 1.2 + lift + Math.sin(this.bob) * 0.5;
    this.y += (target - this.y) * Math.min(1, dt * 8);
    this.altitude = this.y;
  }
}
