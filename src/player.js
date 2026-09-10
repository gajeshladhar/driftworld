// ── Player: a craft that only ever flies ────────────────────────────────────
// There is no surface mode and no water constraint any more. Water is just
// another land-cover class you pass over; the only thing that stops you is
// hitting something.
import { FLY, RUN, VERTICAL_EXAGGERATION, WEATHER } from './config.js?v=cc9cefc5';

export class Player {
  constructor(store, frame, mx, my) {
    this.store = store;
    this.frame = frame;
    this.mx = mx; this.my = my;
    this.heading = 0;          // radians, 0 = north (-Z); +heading turns right
    this.speed = 0;
    this.steer = 0;
    this.yawRate = 0;
    this.mode = 'fly';         // kept so the HUD and capture code read cleanly
    this.y = 0;
    this.vy = 0;
    this.pitch = 0;
    this.roll = 0;
    this.windX = 0; this.windZ = 0;

    this.crashed = false;      // set for one frame on impact
    this.invuln = 0;
    this.clearanceNow = RUN.clearance;
    this.agl = 0;              // height above the obstacle top beneath us

    const h = this.store.heightAtMerc(mx, my);
    this.y = (h ?? 0) * VERTICAL_EXAGGERATION + 600;
  }

  get worldPos() { return this.frame.toWorld(this.mx, this.my); }
  get forward()  { return [Math.sin(this.heading), -Math.cos(this.heading)]; }

  /** Bare terrain height in world units. */
  groundY(mx = this.mx, my = this.my) {
    const h = this.store.heightAtMerc(mx, my);
    return (h ?? 0) * VERTICAL_EXAGGERATION;
  }

  /**
   * Terrain plus whatever stands on it. Instanced scenery is far too numerous
   * to test individually, so the land-cover class stands in for its height:
   * over Built the ground is effectively 96 units higher.
   */
  obstacleTop(mx = this.mx, my = this.my) {
    const ground = this.groundY(mx, my);
    const name = this.store.classAtMerc(mx, my);
    let add = 0;
    if (name === 'Built area') add = RUN.obstacle.BUILT;
    else if (name === 'Trees') add = RUN.obstacle.TREES;
    else if (name === 'Flooded veg.') add = RUN.obstacle.FLOODED;
    else if (name === 'Snow / ice') add = RUN.obstacle.SNOW;
    return ground + add;
  }

  setWind(speed, fromDeg) {
    const to = ((fromDeg ?? 0) + 180) * (Math.PI / 180);
    const v = (speed ?? 0) * WEATHER.windDrift;
    this.windX = Math.sin(to) * v;
    this.windZ = -Math.cos(to) * v;
  }

  _toMercDelta(dx, dz) { return [dx / this.frame.k, -dz / this.frame.k]; }

  /** Lift clear after a hit, so one ridge does not cost every life at once. */
  recover() {
    this.y = this.obstacleTop() + RUN.crashBounce;
    this.vy = Math.max(this.vy, 0);
    this.speed *= 0.45;
    this.invuln = RUN.crashInvuln;
  }

  update(dt, input) {
    this.crashed = false;
    if (this.invuln > 0) this.invuln -= dt;

    // ── steering ──
    const want = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    this.steer += (want - this.steer) * Math.min(1, dt * FLY.steerLerp);

    // ── throttle ──
    if (input.fwd)       this.speed += FLY.accel * (input.boost ? 1.6 : 1) * dt;
    else if (input.back) this.speed -= FLY.accel * 1.2 * dt;
    else                 this.speed -= this.speed * FLY.drag * dt;
    const top = FLY.maxSpeed * (input.boost ? 1.35 : 1);
    this.speed = Math.max(-FLY.maxSpeed * 0.25, Math.min(top, this.speed));

    const v = Math.abs(this.speed);
    const authority = Math.min(1, v / FLY.turnFullAt);
    const widen = 1 / (1 + (v / FLY.maxSpeed) * FLY.turnFalloff);
    this.yawRate = this.steer * FLY.turnRate * authority * widen * Math.sign(this.speed);
    this.heading += this.yawRate * dt;
    this.roll += (-this.steer * authority * 0.5 - this.roll) * Math.min(1, dt * 5);

    // ── move ──
    const [fx, fz] = this.forward;
    const step = this.speed * dt;
    const [mdx, mdy] = this._toMercDelta(fx * step + this.windX * dt,
                                         fz * step + this.windZ * dt);
    this.mx += mdx; this.my += mdy;
    this.travelled = (this.travelled ?? 0) + Math.abs(step);

    // ── climb and dive ──
    const climb = (input.up ? 1 : 0) - (input.down ? 1 : 0);
    const rate = FLY.climbRate * (input.boost ? FLY.boostClimb : 1);
    this.vy += (climb * rate - this.vy) * Math.min(1, dt * 2.6);
    this.y += this.vy * dt;
    this.pitch = Math.max(-1, Math.min(1, this.vy / FLY.climbRate)) * 0.42;

    // ── collision ──
    // Sample under the nose as well as under the hull: at 200 m/s the craft
    // covers its own length between frames, and testing only the centre lets
    // it clip straight through a ridge line.
    const probe = 40 + v * 0.35;
    const [pdx, pdy] = this._toMercDelta(fx * probe, fz * probe);
    const top1 = this.obstacleTop();
    const top2 = this.obstacleTop(this.mx + pdx, this.my + pdy);
    const ceiling = Math.max(top1, top2) + RUN.clearance;
    this.clearanceNow = ceiling;
    this.agl = this.y - ceiling;

    if (this.y < ceiling) {
      if (this.invuln <= 0) {
        this.crashed = true;
        this.recover();
      } else {
        // during grace, skim rather than sink through the hillside
        this.y = ceiling;
        this.vy = Math.max(this.vy, 0);
      }
    }
  }
}
