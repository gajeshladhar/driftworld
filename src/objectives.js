// ── The run: fly as far as you can ──────────────────────────────────────────
// Distance is the whole score. Terrain, buildings and forest are the only
// things that can end it, and you have nine lives plus whatever you collect.
import { RUN } from './config.js?v=969ac6ad';

export class Run {
  constructor(store, frame) {
    this.store = store;
    this.frame = frame;
    this.best = 0;
    this.reset();
  }

  reset() {
    this.lives = RUN.lives;
    this.distance = 0;        // metres
    this.cells = 0;
    this.crashes = 0;
    this.elapsed = 0;
    this.over = false;
    this.rank = RUN.ranks[0][1];
    this.events = [];
  }

  toast(text, kind = 'good') { this.events.push({ text, kind }); }

  get km() { return this.distance / 1000; }

  update(dt, player) {
    if (this.over) return;
    this.elapsed += dt;
    this.distance += Math.abs(player.speed) * dt;
    if (this.distance > this.best) this.best = this.distance;

    const before = this.rank;
    this.rank = this.rankFor(this.km);
    if (this.rank !== before) this.toast('RANK UP — ' + this.rank, 'rank');
  }

  /** One life per impact. */
  crash(surface) {
    if (this.over) return;
    this.lives -= 1;
    this.crashes += 1;
    const where = surface && surface !== 'No data' ? surface.toUpperCase() : 'TERRAIN';
    if (this.lives <= 0) {
      this.lives = 0;
      this.over = true;
      this.toast('DOWN — RUN ENDED', 'bad');
    } else {
      this.toast('IMPACT — ' + where + '   ' + this.lives + ' LEFT',
                 this.lives <= 2 ? 'bad' : 'warn');
    }
  }

  collect() {
    if (this.over) return false;
    if (this.lives >= RUN.lives) {
      this.toast('LIFE CELL — ALREADY FULL', 'warn');
      return false;
    }
    this.lives += 1;
    this.cells += 1;
    this.toast('LIFE CELL — ' + this.lives + ' LIVES', 'good');
    return true;
  }

  rankFor(km) {
    let r = RUN.ranks[0][1];
    for (const [threshold, name] of RUN.ranks) if (km >= threshold) r = name;
    return r;
  }

  /** Progress toward the next rank, for the HUD bar. */
  progress() {
    const rs = RUN.ranks, km = this.km;
    for (let i = 0; i < rs.length; i++) {
      if (km < rs[i][0]) {
        const lo = i > 0 ? rs[i - 1][0] : 0;
        return { next: rs[i][1], frac: (km - lo) / (rs[i][0] - lo) };
      }
    }
    return { next: null, frac: 1 };
  }
}
