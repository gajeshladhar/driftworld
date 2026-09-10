// ── Survey run: the game loop ───────────────────────────────────────────────
// You are cataloguing Earth. The hull draws power from water, so range away
// from it is the core constraint: run dry on water and you merely drift until
// you recharge, run dry over land and the survey is over. Beacons score on the *variety*
// of land cover around them, which makes the real classification data the
// thing the player is actually reading — a beacon in a fjord mouth touching
// water, trees, snow and bare rock is worth far more than one in open sea.
import { RUN, CLASS_ORDER, CLASSES, BOAT, FLY, VERTICAL_EXAGGERATION } from './config.js?v=8eaf432e';

const NAME_TO_KEY = Object.fromEntries(CLASS_ORDER.map((k) => [CLASSES[k].name, k]));

export class Run {
  constructor(store, frame) {
    this.store = store;
    this.frame = frame;
    this.reset();
  }

  reset() {
    this.energy = RUN.energyMax;
    this.score = 0;
    this.beacons = 0;
    this.chain = 1;
    this.chainLeft = 0;
    this.elapsed = 0;
    this.distance = 0;
    this.over = false;
    this.powerless = false;
    this.trend = 0;          // net energy per second, +ve while charging
    this.charging = false;
    this.warnedLow = false;
    this.rank = RUN.ranks[0][1];
    this.events = [];
    this.lastSurvey = [];
  }

  toast(text, kind = 'good') { this.events.push({ text, kind }); }

  /**
   * Is the hull drawing power from water? In cruise the movement constraint
   * guarantees it; in flight you have to skim low over water to keep charging.
   */
  waterContact(player) {
    if (player.mode === 'boat') return true;
    if (!this.store.isWaterAtMerc(player.mx, player.my)) return false;
    const ground = (this.store.heightAtMerc(player.mx, player.my) ?? 0) * VERTICAL_EXAGGERATION;
    return player.y - ground < RUN.skimAltitude;
  }

  /** Energy balance, chain decay, and the two failure states. */
  update(dt, player, input) {
    if (this.over) return;
    this.elapsed += dt;
    this.distance += Math.abs(player.speed) * dt;

    // Speed fraction is measured against the *current* mode's top speed. Using
    // the cruise maximum for both meant flight speeds read as v ~ 5, which
    // zeroed the regen term and made skimming pointless.
    const vmax = player.mode === 'fly' ? FLY.maxSpeed : BOAT.maxSpeed;
    const v = Math.abs(player.speed) / vmax;
    const contact = this.waterContact(player);
    this.charging = false;

    const regen = contact
      ? RUN.regenWater * Math.max(0, 1 - RUN.regenSpeedPenalty * v)
      : 0;

    let drain = RUN.drainIdle;
    if (player.mode === 'fly') {
      drain += contact ? RUN.drainFlyLow : RUN.drainFlyHigh;
    } else {
      drain += RUN.drainMove * v;
    }
    if (input.boost && (input.fwd || player.mode === 'fly')) drain += RUN.drainBoost;

    this.trend = regen - drain;
    this.charging = this.trend > 0.05;
    this.energy = Math.max(0, Math.min(RUN.energyMax, this.energy + this.trend * dt));

    if (!this.warnedLow && this.energy < RUN.lowWarn && this.trend < 0) {
      this.warnedLow = true;
      this.toast('ENERGY LOW — FIND WATER', 'warn');
    }
    if (this.energy > RUN.lowWarn * 1.5) this.warnedLow = false;

    // Running dry on water is survivable: you drift, recharge, and continue.
    // Running dry away from water is not — that is the whole point of the rule.
    if (this.energy <= 0) {
      if (contact) {
        if (!this.powerless) {
          this.powerless = true;
          this.toast('POWER LOST — DRIFTING', 'warn');
        }
      } else {
        this.over = true;
        this.toast('STRANDED AWAY FROM WATER', 'bad');
      }
    }
    if (this.powerless && this.energy >= RUN.recoverAt) {
      this.powerless = false;
      this.toast('POWER RESTORED', 'good');
    }

    if (this.chainLeft > 0) {
      this.chainLeft -= dt;
      if (this.chainLeft <= 0 && this.chain > 1) {
        this.chain = 1;
        this.toast('CHAIN LOST', 'warn');
      }
    }
  }

  /** Sample land cover on a spiral around a point; return the distinct classes. */
  survey(mx, my) {
    const found = new Set();
    const R = RUN.surveyRadius / this.frame.k;      // metres -> mercator units
    for (let i = 0; i < RUN.surveySamples; i++) {
      const t = (i + 0.5) / RUN.surveySamples;
      const a = t * Math.PI * 2 * 3.7;              // golden-ish spiral
      const r = R * Math.sqrt(t);
      const name = this.store.classAtMerc(mx + Math.cos(a) * r, my + Math.sin(a) * r);
      if (name && name !== 'No data') found.add(name);
    }
    let value = 0;
    for (const name of found) {
      const key = NAME_TO_KEY[name];
      if (key) value += RUN.classValue[key] ?? 0;
    }
    return { classes: [...found], value };
  }

  reachBeacon(beacon) {
    if (this.over) return 0;
    const { classes, value } = this.survey(beacon.mx, beacon.my);
    const points = Math.round((RUN.beaconBase + value * 10) * this.chain);

    this.score += points;
    this.beacons++;
    this.energy = Math.min(RUN.energyMax, this.energy + RUN.beaconEnergy);
    this.lastSurvey = classes;

    if (this.chainLeft > 0) this.chain = Math.min(RUN.chainMax, this.chain + RUN.chainStep);
    this.chainLeft = RUN.chainWindow;

    const before = this.rank;
    this.rank = this.rankFor(this.score);

    const mult = this.chain > 1 ? `  x${this.chain.toFixed(1)}` : '';
    this.toast(`+${points}   ${classes.length} CLASSES${mult}`, 'good');
    if (this.rank !== before) this.toast(`RANK UP — ${this.rank}`, 'rank');
    return points;
  }

  rankFor(score) {
    let r = RUN.ranks[0][1];
    for (const [threshold, name] of RUN.ranks) if (score >= threshold) r = name;
    return r;
  }

  /** Progress toward the next rank, for the HUD bar. */
  progress() {
    const rs = RUN.ranks;
    for (let i = 0; i < rs.length; i++) {
      if (this.score < rs[i][0]) {
        const lo = i > 0 ? rs[i - 1][0] : 0;
        return { next: rs[i][1], frac: (this.score - lo) / (rs[i][0] - lo) };
      }
    }
    return { next: null, frac: 1 };
  }
}
