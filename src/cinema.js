// ── Cinematic capture: autopilot + scripted camera + canvas recording ──────
// Drives the game hands-free and records the canvas to a shareable clip.
// Only the WebGL canvas is captured, so the DOM HUD is hidden for the take and
// the world's own place labels (which are sprites) still appear.
import * as THREE from 'three';
import { VERTICAL_EXAGGERATION } from './config.js';

const angDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));

/** Pick the best container Chrome will actually give us, MP4 first. */
function pickMime() {
  const wanted = [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const m of wanted) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
  }
  return '';
}

export class Cinema {
  constructor(game, seconds = 30) {
    this.game = game;
    this.seconds = seconds;
    this.t = 0;
    this.state = 'settling';    // settling -> recording -> done
    this.settle = 0;
    this.chunks = [];
    this.status = 'waiting for terrain';
    this.input = { fwd: 0, back: 0, left: 0, right: 0, up: 0, down: 0, boost: 0 };
    this.frames = 0;
  }

  _report(text) {
    this.status = text;
    let el = document.getElementById('cinema-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cinema-status';
      el.style.cssText = 'position:fixed;top:6px;left:6px;z-index:80;color:#9fe;'
        + 'font:11px ui-monospace,monospace;background:rgba(0,0,0,.6);padding:4px 8px';
      document.body.appendChild(el);
    }
    el.textContent = text;
  }

  /**
   * Steer toward the longest clear stretch of water. Casting a fan of rays and
   * taking the longest run keeps the boat in the channel without any authored
   * path, which matters because the route is different at every location.
   */
  _autoHeading() {
    const { player, store, frame } = this.game;
    let best = player.heading, bestScore = -1e9;
    for (let i = -7; i <= 7; i++) {
      const h = player.heading + i * 0.16;
      let run = 0;
      for (let d = 40; d <= 900; d += 40) {
        const mdx = (Math.sin(h) * d) / frame.k;
        const mdy = (Math.cos(h) * d) / frame.k;
        if (!store.isWaterAtMerc(player.mx + mdx, player.my + mdy)) break;
        run = d;
      }
      const score = run - Math.abs(i) * 26;   // mild bias to holding course
      if (score > bestScore) { bestScore = score; best = h; }
    }
    return best;
  }

  /** Highest terrain within a couple of kilometres, in world units. */
  _terrainCeiling() {
    const { player: p, store, frame } = this.game;
    let m = 0;
    for (const r of [0, 1300, 2600]) {
      const n = r ? 8 : 1;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const h = store.heightAtMerc(p.mx + (Math.cos(a) * r) / frame.k,
                                     p.my + (Math.sin(a) * r) / frame.k);
        if (h !== null && h > m) m = h;
      }
    }
    return m * VERTICAL_EXAGGERATION;
  }

  _drive(dt) {
    const g = this.game;
    const p = g.player;
    const inp = this.input;
    inp.fwd = 1; inp.back = 0; inp.boost = 0; inp.up = 0; inp.down = 0;
    g.run.energy = 100;            // the take must never strand
    if (p.mode === 'boat') inp.boost = 1;

    // Follow the water corridor in both modes. In flight this keeps the craft
    // over the fjord instead of straight into the wall beside it, and it is
    // gentle correction rather than a held turn.
    //
    // The forward ray fan can only find water that is already ahead; once the
    // craft has drifted over land every ray reads zero and it holds course out
    // over the hillside. So when off the water, steer back to the nearest of it.
    let target = this._autoHeading();
    if (p.mode === 'fly' && !g.store.isWaterAtMerc(p.mx, p.my)) {
      const w = g.store.findWaterNear(p.mx, p.my, 220);
      if (w) {
        const [tx, tz] = g.frame.toWorld(w[0], w[1]);
        const [px, pz] = p.worldPos;
        target = Math.atan2(tx - px, -(tz - pz));
      }
    }
    const d = angDiff(target, p.heading);
    const dead = p.mode === 'boat' ? 0.04 : 0.09;
    inp.left = d < -dead ? 1 : 0;
    inp.right = d > dead ? 1 : 0;

    if (p.mode === 'fly') {
      // Cap the speed for the take. At the full 700 m/s the craft crosses a
      // 1 km fjord faster than it can turn, so it always ends up out over the
      // hillside no matter how it steers.
      inp.fwd = Math.abs(p.speed) < 265 ? 1 : 0;

      // Climb clear of the surrounding peaks rather than a fixed height above
      // whatever happens to be directly underneath — over a fjord that is sea
      // level, which leaves the craft down between the walls.
      const want = this._terrainCeiling()
                 + (this.t < this.seconds * 0.66 ? 420 : 950);
      inp.up = p.y < want ? 1 : 0;
      inp.boost = p.y < want - 300 ? 1 : 0;    // get up there quickly
      inp.down = p.y > want * 1.22 ? 1 : 0;

    }
    return inp;
  }

  /**
   * The camera stays directly behind the craft the whole way, only changing
   * distance and height. Any camera angle that sweeps around the subject reads
   * as the subject rotating, which is exactly what it must not do.
   */
  _camera(dt) {
    const g = this.game;
    const p = g.player;
    const [wx, wz] = p.worldPos;
    const T = this.t;
    const A = this.seconds * 0.37;      // leaves the water
    const B = this.seconds * 0.66;      // tops out

    let back, high, lead;
    if (T < A) {
      const k = T / A;
      back = 50 + k * 10; high = 13 + k * 7;   lead = 46;
    } else if (T < B) {
      const k = (T - A) / (B - A);
      back = 54 + k * 110; high = 18 + k * 74; lead = 40 + k * 90;
    } else {
      const k = (T - B) / (this.seconds - B);
      back = 164 + k * 46; high = 92 + k * 34; lead = 210 + k * 120;
    }

    // straight behind, along the craft's own heading — no orbit term at all
    const fx = Math.sin(p.heading), fz = -Math.cos(p.heading);
    const pos = new THREE.Vector3(wx - fx * back, p.y + high, wz - fz * back);

    const [cmx, cmy] = g.frame.toMerc(pos.x, pos.z);
    const gh = g.store.heightAtMerc(cmx, cmy);
    if (gh !== null) pos.y = Math.max(pos.y, gh * 1.8 + 26);

    g.camera.position.lerp(pos, 1 - Math.exp(-dt * 3.2));
    g.camera.lookAt(new THREE.Vector3(wx + fx * lead, p.y + high * 0.18, wz + fz * lead));
  }

  _startRecording() {
    const mime = pickMime();
    if (!mime) { this._report('MediaRecorder unavailable'); this.state = 'done'; return; }
    this.mime = mime;
    this.ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';

    const stream = this.game.renderer.domElement.captureStream(30);
    this.rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 14_000_000 });
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.onstop = () => this._upload();
    this.rec.start(500);
    this.shotAt = [0.12, 0.34, 0.55, 0.78, 0.95].map((f) => f * this.seconds);
    this.state = 'recording';
    this._report(`recording ${this.seconds}s as ${mime}`);
  }

  async _upload() {
    const blob = new Blob(this.chunks, { type: this.mime });
    const name = `driftworld.${this.ext}`;
    try {
      await fetch('/upload?name=' + encodeURIComponent(name), { method: 'POST', body: blob });
      this._report(`SAVED ${name} ${(blob.size / 1e6).toFixed(1)}MB frames=${this.frames}`);
    } catch (err) {
      this._report('upload failed: ' + err);
    }
    this.state = 'done';
    document.title = 'CAPTURE_DONE';
  }

  /**
   * Stills, grabbed straight after a render so the drawing buffer is still
   * intact. Lets the take be reviewed without decoding the video.
   */
  postRender() {
    if (this.state !== 'recording' || !this.shotAt) return;
    if (this.shotAt.length && this.t >= this.shotAt[0]) {
      const at = this.shotAt.shift();
      this.game.renderer.domElement.toBlob((blob) => {
        if (blob) {
          fetch('/upload?name=' + encodeURIComponent(`shot-${Math.round(at)}s.png`),
                { method: 'POST', body: blob });
        }
      }, 'image/png');
    }
  }

  /** Returns the synthetic input the game should use this frame. */
  update(dt) {
    const g = this.game;

    if (this.state === 'settling') {
      const s = g.store.stats;
      this.settle += dt;
      this._report(`loading ${s.loaded} tiles, ${s.queued} queued`);
      if (s.queued === 0 && s.loaded >= 24 && this.settle > 3) this._startRecording();
      return { ...this.input, fwd: 0, left: 0, right: 0 };
    }

    if (this.state === 'recording') {
      this.frames++;
      this.t += dt;
      // lift off the water partway through for the aerial half
      if (g.player.mode === 'boat' && this.t > this.seconds * 0.37) g.player.toggleMode();
      if (this.t >= this.seconds) { this.state = 'stopping'; this.rec.stop(); }
      return this._drive(dt);
    }

    return { ...this.input, fwd: 0, left: 0, right: 0 };
  }

  get drivesCamera() { return this.state === 'recording'; }
}
