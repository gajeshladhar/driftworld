// ── Cinematic capture: autopilot + scripted camera + canvas recording ──────
// Drives the game hands-free and records the canvas to a shareable clip.
// Only the WebGL canvas is captured, so the DOM HUD is hidden for the take and
// the world's own place labels (which are sprites) still appear.
import * as THREE from 'three';
import { VERTICAL_EXAGGERATION, REEL } from './config.js?v=3adea2fa';
import { drawHudOverlay } from './hudcanvas.js?v=3adea2fa';

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
  constructor(game, seconds = 30, withHud = false, reel = false) {
    this.game = game;
    this.seconds = seconds;   // per segment when running a reel
    this.withHud = withHud;
    this.reel = reel;         // run every REEL location in one continuous take
    this.segIdx = 0;
    // On a reel each segment is short, and the low passes over water are the
    // strongest shots, so spend most of the time there and only lift at the end.
    this.phaseA = reel ? 0.60 : 0.37;
    this.phaseB = reel ? 0.82 : 0.66;
    this.fade = 0;            // 0 clear, 1 black
    this.titleT = 0;
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
    // When the tab itself is being recorded, this overlay would end up burned
    // into the video. Keep it to the console in that mode.
    if (this.withHud) { console.log('[cinema] ' + text); return; }
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
  /**
   * Steer toward open air: sample a fan of bearings and take the one whose
   * terrain profile sits lowest, so the take flies valleys rather than walls.
   */
  _autoHeading() {
    const { player, frame } = this.game;
    let best = player.heading, bestScore = Infinity;
    for (let i = -7; i <= 7; i++) {
      const h = player.heading + i * 0.16;
      let peak = 0;
      for (let d = 200; d <= 2600; d += 300) {
        const mx = player.mx + (Math.sin(h) * d) / frame.k;
        const my = player.my - (-Math.cos(h) * d) / frame.k;
        peak = Math.max(peak, player.obstacleTop(mx, my));
      }
      const score = peak + Math.abs(i) * 26;
      if (score < bestScore) { bestScore = score; best = h; }
    }
    return best;
  }

  /** Highest obstacle top within a couple of kilometres, in world units. */
  _terrainCeiling() {
    const p = this.game.player, frame = this.game.frame;
    let m = 0;
    for (const r of [0, 1300, 2600]) {
      const n = r ? 8 : 1;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const top = p.obstacleTop(p.mx + (Math.cos(a) * r) / frame.k,
                                  p.my + (Math.sin(a) * r) / frame.k);
        if (top > m) m = top;
      }
    }
    return m;
  }

  _drive(dt) {
    const g = this.game;
    const p = g.player;
    const inp = this.input;
    inp.fwd = 1; inp.back = 0; inp.boost = 0; inp.up = 0; inp.down = 0;
    g.run.energy = 100;            // the take must never strand

    // Follow the water corridor in both modes. In flight this keeps the craft
    // over the fjord instead of straight into the wall beside it, and it is
    // gentle correction rather than a held turn.
    //
    // The forward ray fan can only find water that is already ahead; once the
    // craft has drifted over land every ray reads zero and it holds course out
    // over the hillside. So when off the water, steer back to the nearest of it.
    const target = this._autoHeading();
    const d = angDiff(target, p.heading);
    const dead = 0.09;
    inp.left = d < -dead ? 1 : 0;
    inp.right = d > dead ? 1 : 0;

    {
      // Cap the speed for the take. At the full 700 m/s the craft crosses a
      // 1 km fjord faster than it can turn, so it always ends up out over the
      // hillside no matter how it steers.
      inp.fwd = Math.abs(p.speed) < 265 ? 1 : 0;

      // Climb clear of the surrounding peaks rather than a fixed height above
      // whatever happens to be directly underneath — over a fjord that is sea
      // level, which leaves the craft down between the walls.
      const want = this._terrainCeiling()
                 + (this.reel ? 150 : (this.t < this.seconds * this.phaseB ? 420 : 950));
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
    const A = this.seconds * this.phaseA;   // leaves the water
    const B = this.seconds * this.phaseB;   // tops out

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
    // Look below the craft, not level with it: the subject of the shot is the
    // landscape, and a level lens fills most of the frame with empty sky.
    const aim = T < A ? p.y + 4 : p.y - high * 0.42;
    g.camera.lookAt(new THREE.Vector3(wx + fx * lead, aim, wz + fz * lead));
  }

  async _startRecording() {
    const mime = pickMime();
    if (!mime) { this._report('MediaRecorder unavailable'); this.state = 'done'; return; }
    this.mime = mime;
    this.ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';

    // Composite the HUD onto a copy of the WebGL frame and record that.
    // Tab capture does see the DOM directly, but in headless Chrome it yields a
    // container whose declared duration is wrong, so players stop after a few
    // seconds. Canvas capture has always produced correct files.
    const gl = this.game.renderer.domElement;
    let stream;
    if (this.withHud) {
      this.out = document.createElement('canvas');
      this.out.width = gl.width;
      this.out.height = gl.height;
      this.outCtx = this.out.getContext('2d');
      stream = this.out.captureStream(30);
    }
    this.source = this.out ? 'hud' : 'clean';
    if (!stream) stream = gl.captureStream(30);
    // Flat-shaded terrain and a static HUD compress well, so a tab capture
    // does not need the headroom a detailed scene would.
    const bitrate = this.withHud ? 6_200_000 : 12_000_000;
    this.rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.onstop = () => this._upload();
    // Pull stills from the capture track itself, so the review frames show
    // exactly what the recording sees rather than just the canvas.
    this.rec.start(500);
    this.shotAt = [0.12, 0.34, 0.55, 0.78, 0.95].map((f) => f * this.seconds);
    this.state = 'recording';
    this._report(`recording ${this.seconds}s as ${mime}`);
  }

  async _upload() {
    const blob = new Blob(this.chunks, { type: this.mime });
    const name = `driftworld-${this.source || 'canvas'}.${this.ext}`;

    // The dev server accepts POST /upload. On a static host it does not exist,
    // so hand the clip to the browser as a download instead.
    let saved = false;
    try {
      const r = await fetch('/upload?name=' + encodeURIComponent(name),
                            { method: 'POST', body: blob });
      saved = r.ok;
    } catch { /* no dev server here */ }

    if (!saved) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 15000);
    }
    this._report(`${saved ? 'SAVED' : 'DOWNLOADED'} ${name} `
               + `${(blob.size / 1e6).toFixed(1)}MB frames=${this.frames}`);
    this.state = 'done';
    document.title = 'CAPTURE_DONE';
  }

  /**
   * Stills, grabbed straight after a render so the drawing buffer is still
   * intact. Lets the take be reviewed without decoding the video.
   */
  postRender() {
    if (this.out && (this.state === 'recording' || this.state === 'cutting')) {
      const W = this.out.width, H = this.out.height;
      this.outCtx.drawImage(this.game.renderer.domElement, 0, 0);
      if (this.withHud) drawHudOverlay(this.outCtx, W, H);
      this._drawTitle(this.outCtx, W, H);
      if (this.fade > 0) {
        this.outCtx.fillStyle = `rgba(4,9,15,${this.fade})`;
        this.outCtx.fillRect(0, 0, W, H);
      }
    }
    if (this.state !== 'recording' || !this.shotAt) return;
    if (this.shotAt.length && this.t >= this.shotAt[0]) {
      const at = this.shotAt.shift();
      const send = (blob) => {
        if (blob) {
          fetch('/upload?name=' + encodeURIComponent(`shot-${this.segIdx}-${Math.round(at)}s.png`),
                { method: 'POST', body: blob }).catch(() => {});
        }
      };
      (this.out || this.game.renderer.domElement).toBlob(send, 'image/png');
    }
  }

  /** Returns the synthetic input the game should use this frame. */
  update(dt) {
    const g = this.game;

    if (this.state === 'settling') {
      const s = g.store.stats;
      this.settle += dt;
      this._report(`loading ${s.loaded} tiles, ${s.queued} queued`);
      if (s.queued === 0 && s.loaded >= 24 && this.settle > 3) {
        this.state = 'starting';
        this._startRecording();
      }
      return { ...this.input, fwd: 0, left: 0, right: 0 };
    }

    if (this.state === 'cutting') return { ...this.input, fwd: 0, left: 0, right: 0 };

    if (this.state === 'recording') {
      this.frames++;
      this.t += dt;
      this.titleT += dt;
      // lift off the water partway through for the aerial half
      if (this.t >= this.seconds) {
        if (this.reel && this.segIdx < REEL.length - 1) { this._nextSegment(); }
        else { this.state = 'stopping'; this.rec.stop(); }
      }
      return this._drive(dt);
    }

    return { ...this.input, fwd: 0, left: 0, right: 0 };
  }

  /** Cut to the next location behind a fade, without stopping the recorder. */
  async _nextSegment() {
    this.state = 'cutting';
    const ease = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 1; i <= 12; i++) { this.fade = i / 12; await ease(28); }

    this.segIdx++;
    const loc = REEL[this.segIdx];
    await this.game.relocate(loc);
    await ease(700);                       // let the first tiles settle

    this.t = 0;
    this.titleT = 0;
    this.shotAt = [0.42, 0.8].map((f) => f * this.seconds);   // review each location
    this.state = 'recording';
    for (let i = 11; i >= 0; i--) { this.fade = i / 12; await ease(28); }
    this.fade = 0;
  }

  /** Location title, fading in and out over the first seconds of a segment. */
  _drawTitle(ctx, W, H) {
    const loc = this.reel ? REEL[this.segIdx] : null;
    if (!loc) return;
    const t = this.titleT;
    const a = t < 0.5 ? t / 0.5 : t > 4.2 ? Math.max(0, 1 - (t - 4.2) / 0.9) : 1;
    if (a <= 0) return;
    ctx.save();
    ctx.globalAlpha = a;
    const x = Math.round(W * 0.055), y = Math.round(H * 0.74);
    ctx.fillStyle = '#38e8ff';
    ctx.fillRect(x, y - 4, 3, 54);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.shadowColor = 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = 10;
    ctx.fillStyle = '#ffffff';
    ctx.font = `600 ${Math.round(H * 0.038)}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.fillText(loc.name, x + 16, y - 4);
    ctx.fillStyle = 'rgba(200,222,236,0.92)';
    ctx.font = `${Math.round(H * 0.017)}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.fillText(loc.sub, x + 16, y + Math.round(H * 0.042));
    ctx.restore();
  }

  get drivesCamera() { return this.state === 'recording'; }
}
