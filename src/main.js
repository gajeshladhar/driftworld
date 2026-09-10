// ── Driftworld · main loop ──────────────────────────────────────────────────
import * as THREE from 'three';
import { LOCATIONS, ZOOM, CLASSES, CLASS_ORDER, BOAT, SKY, SHIP, ATMOSPHERES, RUN, WEATHER } from './config.js?v=969ac6ad';
import { makeFrame, lonLatToMerc, mercToLonLat, mercToTile } from './geo.js?v=969ac6ad';
import { TileStore } from './tiles.js?v=969ac6ad';
import { Terrain } from './terrain.js?v=969ac6ad';
import { Player } from './player.js?v=969ac6ad';
import { PixelPass } from './pixel.js?v=969ac6ad';
import { makeSky, HORIZON } from './sky.js?v=969ac6ad';
import { makeShip, updateShip } from './ship.js?v=969ac6ad';
import { Minimap } from './minimap.js?v=969ac6ad';
import { Nav } from './nav.js?v=969ac6ad';
import { Run } from './objectives.js?v=969ac6ad';
import { Places } from './places.js?v=969ac6ad';
import { Weather } from './weather.js?v=969ac6ad';
import { Clouds } from './clouds.js?v=969ac6ad';
import { Cinema } from './cinema.js?v=969ac6ad';
import { disposeProps } from './props.js?v=969ac6ad';

const $ = (id) => document.getElementById(id);

/** Uncaught errors in a rAF loop are invisible: the world just freezes. */
function showFatal(msg) {
  console.error('[driftworld] ' + msg);
  let el = document.getElementById('fatal');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fatal';
    el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99;background:#3b0d0d;'
      + 'color:#ffd9d2;padding:10px 14px;font:11px/1.5 ui-monospace,monospace;'
      + 'white-space:pre-wrap;border-top:2px solid #ff7a6a;pointer-events:none';
    document.body.appendChild(el);
  }
  el.textContent = String(msg);
}
window.addEventListener('error', (e) => showFatal(`${e.message}  @ ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection',
  (e) => showFatal('unhandled promise: ' + (e.reason?.stack || e.reason)));
const SUN = new THREE.Vector3(...SKY.sun).normalize();
const DEG = 180 / Math.PI;
const CARDINALS = ['N','NE','E','SE','S','SW','W','NW'];

const input = { fwd: 0, back: 0, left: 0, right: 0, up: 0, down: 0, boost: 0 };
const KEYS = {
  KeyW: 'fwd',  ArrowUp: 'fwd',    KeyS: 'back',  ArrowDown: 'back',
  KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
  Space: 'up',  KeyR: 'up',        KeyF: 'down',
  ControlLeft: 'down', ControlRight: 'down',
  ShiftLeft: 'boost',  ShiftRight: 'boost',
};

/** Signed shortest angular difference in degrees, in [-180, 180]. */
const angDiff = (a, b) => ((((a - b) % 360) + 540) % 360) - 180;

class Game {
  constructor(loc) {
    this.loc = loc;
    this.frame = makeFrame(loc.lon, loc.lat);
    this.store = new TileStore();
    this.clock = new THREE.Clock();
    this.hudTimer = 0;
    this.mapTimer = 0;
    this.baseFov = 62;
  }

  async start() {
    const canvas = $('gl');
    // antialias + device pixel ratio apply to the full-res ship pass; the
    // world's chunkiness comes from the low-res render target, not from here.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(HORIZON, 1);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(this.baseFov, 1, 3, 140000);
    this.sky = makeSky(SUN);
    this.scene.add(this.sky);

    // Scenery uses Lambert materials, so the world scene needs real lights.
    // The terrain itself is a custom shader and ignores them.
    this.sunLight = new THREE.DirectionalLight(0xffe6c4, 2.0);
    this.sunLight.position.copy(SUN).multiplyScalar(5000);
    this.scene.add(this.sunLight);
    this.hemi = new THREE.HemisphereLight(SKY.horizon, 0x2a3428, 1.15);
    this.scene.add(this.hemi);

    this.clouds = new Clouds(this.scene);

    this.terrain = new Terrain(this.scene, this.store, this.frame);
    this.terrain.base.uniforms.uSunDir.value.copy(SUN);
    this.terrain.base.uniforms.uFogColor.value.copy(HORIZON);

    // The ship lives in its own scene so it can be drawn full-resolution on
    // top of the pixelated world, with its own lighting rig.
    this.shipScene = new THREE.Scene();
    this.shipKey = new THREE.DirectionalLight(0xffe6c4, 2.2);
    this.shipKey.position.copy(SUN).multiplyScalar(100);
    const fill = new THREE.DirectionalLight(0x9fc4ff, 1.35);
    fill.position.set(-60, 45, -80);
    const rim  = new THREE.DirectionalLight(SHIP.accent, 1.25);
    rim.position.set(0, -15, 95);
    this.shipAmb = new THREE.AmbientLight(0x6a7ea8, 2.1);
    this.shipScene.add(this.shipKey, fill, rim, this.shipAmb);

    this.pixel = new PixelPass(this.renderer);
    this.onResize();
    window.addEventListener('resize', () => this.onResize());

    const [mx0, my0] = lonLatToMerc(this.loc.lon, this.loc.lat);
    const [cx, cy] = mercToTile(mx0, my0, ZOOM);
    this.setStatus('Streaming land cover + elevation…');
    const jobs = [];
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) jobs.push(this.store.request(cx + dx, cy + dy));
    await Promise.all(jobs);

    this.player = new Player(this.store, this.frame, mx0, my0);
    if (this.weather?.data) this.player.setWind(this.weather.data.wind, this.weather.data.windDir);
    this.ship = makeShip();
    // Aircraft order: roll in local frame, pitch about the yawed lateral axis,
    // yaw about world up. With the default XYZ, pitch is applied about world X,
    // so heading east turned "pitch" into "roll".
    this.ship.rotation.order = 'YXZ';
    this.shipScene.add(this.ship);

    this.terrain.update(this.player.mx, this.player.my);

    this.minimap = new Minimap($('map'), this.store, this.frame);
    this.run = new Run(this.store, this.frame);
    this.nav = new Nav(this.scene, this.store, this.frame, () => this.run.collect());
    this.nav.ensure(this.player);

    this.places = new Places(this.scene, this.frame, this.store);
    this.places.onRegion = (label) => this.run.toast(label.toUpperCase(), 'rank');

    this.weather = new Weather();
    this.weather.onUpdate = (w) => {
      this.applyWeather(w);
      this.player?.setWind(w.wind, w.windDir);
    };

    this.atmo = 0;
    this.applyAtmosphere(0);
    $('again').addEventListener('click', () => this.restart());

    this.compass = $('compass');
    this.compass.width = 420; this.compass.height = 30;
    this.cctx = this.compass.getContext('2d');

    this.bindKeys();
    this.buildLegend();

    const qp = new URLSearchParams(location.search);
    const cineSecs = parseInt(qp.get('cinema'), 10);
    if (cineSecs) {
      const withHud = qp.get('hud') === '1';
      const reel = qp.get('reel') === '1';
      this.cinema = new Cinema(this, Math.min(120, Math.max(5, cineSecs)), withHud, reel);
      if (!withHud) $('hud').classList.add('cinema-hidden');
      this.renderer.setPixelRatio(1);            // predictable capture size and cost
      this.onResize();
    }

    $('boot').classList.add('hidden');
    $('hud').classList.remove('hidden');
    this.clock.start();
    this.renderer.setAnimationLoop(() => this.tick());
    return true;
  }

  setStatus(text, isError = false) {
    const el = $('status');
    el.textContent = text;
    el.classList.toggle('err', isError);
  }

  bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (KEYS[e.code]) { input[KEYS[e.code]] = 1; e.preventDefault(); }
      if (e.code === 'KeyG') this.player.recover();   // emergency pull-up
      if (e.code === 'KeyM') $('mapwrap').classList.toggle('hidden');
      if (e.code === 'KeyT') this.applyAtmosphere(this.atmo + 1);
    });
    window.addEventListener('keyup', (e) => { if (KEYS[e.code]) input[KEYS[e.code]] = 0; });
    window.addEventListener('blur', () => Object.keys(input).forEach((k) => (input[k] = 0)));
  }

  buildLegend() {
    $('legend').innerHTML = CLASS_ORDER.map((k) => {
      const c = CLASSES[k];
      const hex = '#' + c.art.map((v) => v.toString(16).padStart(2, '0')).join('');
      return `<span class="sw"><i style="background:${hex}"></i>${c.name}</span>`;
    }).join('');
  }

  onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.pixel.setSize(w, h);
  }

  /** Drop a whole world: meshes, textures, instanced scenery, labels, buoys. */
  _wipeWorld() {
    for (const k of [...this.store.tiles.keys()]) {
      const t = this.store.tiles.get(k);
      if (t) disposeProps(t.props);
      this.store.dispose(k);
    }
    for (const g of [this.terrain?.group, this.places?.group]) {
      if (!g) continue;
      g.traverse((o) => {
        o.geometry?.dispose?.();
        if (o.material) {
          for (const m of [].concat(o.material)) { m.map?.dispose?.(); m.dispose?.(); }
        }
      });
      this.scene.remove(g);
    }
    if (this.nav) for (let i = this.nav.buoys.length - 1; i >= 0; i--) this.nav._remove(i);
  }

  /**
   * Move the whole game to new coordinates without tearing down the renderer,
   * so a recording in progress keeps running across the cut.
   */
  async relocate(loc) {
    this._wipeWorld();
    this.loc = loc;
    this.frame = makeFrame(loc.lon, loc.lat);
    this.store = new TileStore();

    this.terrain = new Terrain(this.scene, this.store, this.frame);
    this.applyAtmosphere(this.atmo);

    const [mx0, my0] = lonLatToMerc(loc.lon, loc.lat);
    const [cx, cy] = mercToTile(mx0, my0, ZOOM);
    const jobs = [];
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) jobs.push(this.store.request(cx + dx, cy + dy));
    await Promise.all(jobs);

    this.player = new Player(this.store, this.frame, mx0, my0);
    this.terrain.update(this.player.mx, this.player.my);

    this.minimap = new Minimap($('map'), this.store, this.frame);
    this.nav = new Nav(this.scene, this.store, this.frame, () => this.run.collect());
    this.nav.ensure(this.player);
    this.places = new Places(this.scene, this.frame, this.store);
    this.places.onRegion = (label) => this.run.toast(label.toUpperCase(), 'rank');
    this.run.energy = 100;
  }

  /** Push live conditions into the sea, the sky and the panel. */
  applyWeather(w) {
    const sea = this.weather.seaState();
    this.terrain.setSea(sea.amp, sea.speed);
    if (this.sky) this.sky.material.uniforms.uCloud.value = Math.min(1, w.cloud / 100);
    // ?cloud=0..1 forces coverage, for checking the deck without waiting on weather
    const forced = parseFloat(new URLSearchParams(location.search).get('cloud'));
    this.clouds?.setWeather(isFinite(forced) ? forced * 100 : w.cloud, w.wind, w.windDir);

    const wx = $('wx');
    wx.classList.remove('pending');
    $('wx-temp').innerHTML = `${Math.round(w.temp)}<span>&deg;C</span>`;
    $('wx-label').textContent = w.label.toUpperCase();
    $('wx-time').textContent = `${w.localTime} local`;

    $('wx-wind').textContent = `${w.wind.toFixed(1)} m/s`;
    $('wx-windbar').firstElementChild.style.width = `${Math.min(100, (w.wind / 25) * 100)}%`;

    if (w.wave === null) {
      $('wx-wave').textContent = 'inland';
      $('wx-wavebar').firstElementChild.style.width = '0%';
      $('wx-sea').textContent = w.gust > w.wind * 1.4
        ? `gusting ${w.gust.toFixed(0)} m/s` : ' ';
    } else {
      $('wx-wave').textContent = `${w.wave.toFixed(2)} m`;
      $('wx-wavebar').firstElementChild.style.width =
        `${Math.min(100, (w.wave / 6) * 100)}%`;
      $('wx-sea').textContent =
        `swell ${w.wavePeriod ? w.wavePeriod.toFixed(1) + ' s' : '--'} from ${Math.round(w.waveDir ?? 0)}°`;
    }
    this.wxWindDir = w.windDir;
  }

  applyAtmosphere(i) {
    this.atmo = ((i % ATMOSPHERES.length) + ATMOSPHERES.length) % ATMOSPHERES.length;
    const a = ATMOSPHERES[this.atmo];
    const sun = new THREE.Vector3(...a.sun).normalize();
    const horizon = new THREE.Color(a.horizon);
    const top = new THREE.Color(a.top);

    const u = this.sky.material.uniforms;
    u.uSun.value.copy(sun);
    u.uTop.value.set(a.top);
    u.uMid.value.set(a.mid);
    u.uHorizon.value.set(a.horizon);

    this.terrain.setAtmosphere(sun, horizon, top);
    this.renderer.setClearColor(horizon, 1);

    this.clouds?.setAtmosphere(sun, horizon);
    this.sunLight.color.set(a.light);
    this.sunLight.position.copy(sun).multiplyScalar(5000);
    this.hemi.color.set(a.horizon);
    this.shipKey.color.set(a.light);
    this.shipKey.position.copy(sun).multiplyScalar(100);
    this.shipAmb.color.set(a.amb);
    this.atmoName = a.name;
  }

  restart() {
    this.run.reset();
    for (let i = this.nav.buoys.length - 1; i >= 0; i--) this.nav._remove(i);
    this.nav.reached = 0;
    this.nav.ensure(this.player);
    this.player.speed = 0;
    this.player.recover();
    $('over').classList.add('hidden');
  }

  flushToasts() {
    const box = $('toasts');
    while (this.run.events.length) {
      const e = this.run.events.shift();
      const el = document.createElement('div');
      el.className = 'toast ' + e.kind;
      el.textContent = e.text;
      box.appendChild(el);
      setTimeout(() => el.remove(), 2500);
    }
  }

  updateCamera(dt) {
    const p = this.player;
    const [wx, wz] = p.worldPos;
    const flying = p.mode === 'fly';
    const frac = Math.min(Math.abs(p.speed) / BOAT.maxSpeed, 1.6);

    // pull back and widen with speed — the cheapest, strongest speed cue there is
    const dist = (flying ? 105 : 46) + frac * 13;
    const high = (flying ? 42 : 19) + frac * 4;

    const back = new THREE.Vector3(-Math.sin(p.heading), 0, Math.cos(p.heading));
    const want = new THREE.Vector3(wx, p.y, wz)
      .add(back.clone().multiplyScalar(dist))
      .add(new THREE.Vector3(0, high, 0));

    const [cmx, cmy] = this.frame.toMerc(want.x, want.z);
    const gh = this.store.heightAtMerc(cmx, cmy);
    if (gh !== null) want.y = Math.max(want.y, gh * 1.8 + 14);

    this.camera.position.lerp(want, 1 - Math.exp(-dt * 5.2));

    const fov = this.baseFov + frac * 11;
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 3);
      this.camera.updateProjectionMatrix();
    }

    const ahead = new THREE.Vector3(Math.sin(p.heading), 0, -Math.cos(p.heading));
    this.camera.lookAt(
      new THREE.Vector3(wx, p.y + (flying ? 6 : 3), wz).add(ahead.multiplyScalar(30)),
    );
  }

  /** Heading tape with cardinals and a marker for the active waypoint. */
  drawCompass(headingDeg, targetBearing) {
    const ctx = this.cctx, W = this.compass.width, H = this.compass.height;
    const FOV = 140, pxPerDeg = W / FOV;
    ctx.clearRect(0, 0, W, H);

    for (let d = 0; d < 360; d += 15) {
      const x = W / 2 + angDiff(d, headingDeg) * pxPerDeg;
      if (x < -20 || x > W + 20) continue;
      const major = d % 45 === 0;
      ctx.strokeStyle = major ? 'rgba(232,241,247,.85)' : 'rgba(143,168,184,.45)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, major ? 4 : 9);
      ctx.lineTo(x, major ? 13 : 13);
      ctx.stroke();
      if (major) {
        ctx.fillStyle = d === 0 ? '#7fd4ff' : 'rgba(232,241,247,.9)';
        ctx.font = 'bold 10px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(CARDINALS[d / 45], x, H - 6);
      }
    }

    if (targetBearing !== null) {
      const x = W / 2 + angDiff(targetBearing, headingDeg) * pxPerDeg;
      const cx = Math.max(6, Math.min(W - 6, x));
      ctx.fillStyle = '#ffd24a';
      ctx.beginPath();
      ctx.moveTo(cx, 2); ctx.lineTo(cx + 5, 11); ctx.lineTo(cx - 5, 11);
      ctx.closePath(); ctx.fill();
    }

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, H);
    ctx.stroke();
  }

  /** Edge arrow pointing at the target when it is off-screen or behind. */
  updateTargetArrow(target) {
    const el = $('tarrow');
    if (!target) { el.classList.add('hidden'); return; }

    const v = new THREE.Vector3(target.wx, target.y + 30, target.wz).project(this.camera);
    const behind = v.z > 1;
    let x = v.x, y = v.y;
    if (behind) { x = -x; y = -y; }

    if (!behind && Math.abs(x) < 0.9 && Math.abs(y) < 0.9) { el.classList.add('hidden'); return; }

    const L = Math.max(Math.abs(x), Math.abs(y)) || 1;
    x = (x / L) * 0.88;
    y = (y / L) * 0.88;

    const W = window.innerWidth, H = window.innerHeight;
    el.style.left = `${(x * 0.5 + 0.5) * W}px`;
    el.style.top = `${(-y * 0.5 + 0.5) * H}px`;
    el.style.transform = `translate(-50%,-50%) rotate(${Math.atan2(x, y) * DEG}deg)`;
    el.classList.remove('hidden');
  }

  tick() {
    try { this._tick(); }
    catch (err) {
      this.renderer.setAnimationLoop(null);
      showFatal('tick failed: ' + (err?.stack || err));
    }
  }

  _tick() {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const p = this.player;

    // ?test=crash flies the craft straight down, to exercise impact handling
    if (this.crashTest === undefined) {
      this.crashTest = new URLSearchParams(location.search).get('test') === 'crash';
    }
    const src = this.crashTest ? { ...input, fwd: 1, down: 1 }
              : this.cinema ? this.cinema.update(dt) : input;
    const live = this.run.over
      ? { ...src, fwd: 0, back: 0, boost: 0, up: 0, down: 0 }
      : src;

    p.update(dt, live);
    this.run.update(dt, p);
    if (p.crashed) this.run.crash(this.store.classAtMerc(p.mx, p.my));
    this.terrain.update(p.mx, p.my);
    this.terrain.setTime(this.clock.elapsedTime);

    // altitude opens the view distance; the sky dome rides with the camera so
    // you can never climb out of it
    const alt = Math.max(0, p.y);
    this.terrain.setFog(3200 + alt * 1.4, Math.min(70000, 11000 + alt * 5.5));
    const target = this.run.over ? this.nav.target(p) : this.nav.update(p, dt);

    const [wx, wz] = p.worldPos;
    const frac = Math.min(Math.abs(p.speed) / BOAT.maxSpeed, 1);
    this.ship.position.set(wx, p.y, wz);
    // Yaw is negated: three.js rotates (0,0,-1) to (-sin h, -cos h), while the
    // craft travels along (sin h, -cos h). Those only agree at 0 and 180
    // degrees, so on every other heading the model pointed off to one side.
    // Mirroring in x also flips the sense of roll, hence the sign there.
    this.ship.rotation.set(p.pitch, -p.heading, -p.roll * 0.72);
    updateShip(this.ship, dt, this.run.over ? 0 : frac,
               live.boost ? 1 : 0, Math.abs(p.speed) > 0.5);

    if (this.cinema && this.cinema.drivesCamera) this.cinema._camera(dt);
    else this.updateCamera(dt);
    this.sky.position.copy(this.camera.position);

    // pass 1: the pixelated world · pass 2: the ship, full resolution on top
    this.pixel.render(this.scene, this.camera);
    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.render(this.shipScene, this.camera);
    this.renderer.autoClear = true;

    this.mapTimer += dt;
    if (this.mapTimer > 0.08) {
      this.mapTimer = 0;
      this.minimap.draw(p, this.nav.buoys, target);
      this.updateTargetArrow(target);
      this.places.maybeRefresh(p);   // self-debounced by distance and elapsed time
      this.places.update(p);
      const [wlon, wlat] = mercToLonLat(p.mx, p.my);
      this.weather.maybeFetch(wlat, wlon);
    }

    if (this.cinema) this.cinema.postRender();
    this.flushToasts();
    if (this.run.over) $('over').classList.remove('hidden');

    this.hudTimer += dt;
    if (this.hudTimer > 0.12) { this.hudTimer = 0; this.updateHUD(target); }
  }

  updateHUD(target) {
    const p = this.player;
    const run = this.run;
    const [lon, lat] = mercToLonLat(p.mx, p.my);
    const kmh = Math.abs(p.speed) * 3.6;
    const cls = this.store.classAtMerc(p.mx, p.my) ?? '—';
    const s = this.store.stats;
    const headingDeg = ((p.heading * DEG) % 360 + 360) % 360;

    let bearing = null;
    if (target) {
      const [px, pz] = p.worldPos;
      bearing = ((Math.atan2(target.wx - px, -(target.wz - pz)) * DEG) % 360 + 360) % 360;
      const d = target.dist;
      $('r-wp').textContent = d > 1000 ? `${(d / 1000).toFixed(2)} km` : `${d.toFixed(0)} m`;
    } else {
      $('r-wp').textContent = 'scanning…';
    }
    this.drawCompass(headingDeg, bearing);

    $('r-pos').textContent  = `${lat.toFixed(5)}°, ${lon.toFixed(5)}°`;
    $('r-mode').textContent = input.boost ? 'FLIGHT · BOOST' : 'FLIGHT';
    $('r-spd').textContent  = `${kmh.toFixed(0)} km/h`;
    $('r-alt').textContent  = `${(p.y / 1.8).toFixed(0)} m`;
    $('r-cls').textContent  = cls;
    $('r-cls').style.color  = cls === 'Water' ? '#7fd4ff' : '#ffd27f';
    $('r-tiles').textContent = `${s.loaded} loaded · ${s.queued} queued`
      + `${s.failed ? ` · ${s.failed} failed` : ''} · ${this.places.labels.length} places`;
    $('r-sky').textContent = this.atmoName;
    if (this.wxWindDir !== undefined) {
      // meteorological direction is where wind comes FROM; +180 to point downwind,
      // then subtract heading so the arrow reads relative to the nose
      const rel = this.wxWindDir + 180 - p.heading * DEG;
      $('wx-arrow').style.transform = `rotate(${rel}deg)`;
    }
    $('r-region').textContent = this.places.region?.label ?? 'locating…';
    const warnEl = $('warn');
    if (!run.over && p.agl < 90) {
      warnEl.textContent = 'PULL UP';
      warnEl.classList.remove('hidden');
    } else {
      warnEl.classList.add('hidden');
    }

    // ── mission bar ──
    $('m-score').textContent = `${run.km.toFixed(2)} km`;
    $('m-rank').textContent = run.rank;

    // lives as pips, so nine reads at a glance without counting
    const pips = $('lives');
    if (pips.childElementCount !== RUN.lives) {
      pips.innerHTML = Array.from({ length: RUN.lives }, () => '<i></i>').join('');
    }
    [...pips.children].forEach((el, i) => {
      el.className = i < run.lives ? (run.lives <= 2 ? 'on low' : 'on') : '';
    });
    $('m-lives').textContent = `${run.lives} / ${RUN.lives}`;
    $('m-beacons').textContent = `${run.cells} COLLECTED`;

    const prog = run.progress();
    $('m-nextlabel').textContent = prog.next ? `NEXT · ${prog.next}` : 'MAX RANK';
    $('rankFill').style.width = `${Math.min(100, prog.frac * 100)}%`;

    // altitude margin over whatever is directly below
    const clr = $('m-clear');
    clr.textContent = `${Math.max(0, p.agl).toFixed(0)} m clear`;
    clr.classList.toggle('tight', p.agl < 140);

    if (run.over) {
      const mins = Math.floor(run.elapsed / 60);
      const secs = Math.floor(run.elapsed % 60).toString().padStart(2, '0');
      $('o-score').textContent = `${run.km.toFixed(2)} km`;
      $('o-rank').textContent = run.rank;
      $('o-beacons').textContent = `${run.cells} cells · ${run.crashes} impacts`;
      $('o-dist').textContent = `${(run.best / 1000).toFixed(2)} km`;
      $('o-time').textContent = `${mins}:${secs}`;
    }
  }
}

// -- boot --------------------------------------------------------------------
function setBusy(on) {
  $('locs').style.pointerEvents = on ? 'none' : 'auto';
  $('go').disabled = on;
  $('lat').disabled = on;
  $('lon').disabled = on;
}

function renderLocationList() {
  $('locs').innerHTML = LOCATIONS.map((l, i) =>
    `<button data-i="${i}">${l.name}<small>${l.lat.toFixed(3)}, ${l.lon.toFixed(3)}</small></button>`
  ).join('');
  $('locs').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const loc = LOCATIONS[+b.dataset.i];
    $('locs').querySelectorAll('button').forEach((x) => x.classList.remove('on'));
    b.classList.add('on');
    launch(loc);
  });
}

/** Accepts "62.1005", and tolerates a pasted "62.1005, 7.2050" in either box. */
function parseCoordPair() {
  const raw = `${$('lat').value.trim()} ${$('lon').value.trim()}`.trim();
  const nums = raw.match(/-?\d+(\.\d+)?/g);
  if (!nums || nums.length < 2) return null;
  const lat = parseFloat(nums[0]), lon = parseFloat(nums[1]);
  if (!isFinite(lat) || !isFinite(lon)) return null;
  if (lat < -85 || lat > 85) return { err: 'Latitude must be between -85 and 85 (Web Mercator limit).' };
  if (lon < -180 || lon > 180) return { err: 'Longitude must be between -180 and 180.' };
  return { lat, lon };
}

function launchCustom() {
  const c = parseCoordPair();
  if (!c) {
    $('status').textContent = 'Enter a latitude and a longitude, e.g. 20.9101 / 107.1839';
    $('status').classList.add('err');
    return;
  }
  if (c.err) {
    $('status').textContent = c.err;
    $('status').classList.add('err');
    return;
  }
  $('locs').querySelectorAll('button').forEach((x) => x.classList.remove('on'));
  launch({ name: 'Custom', lat: c.lat, lon: c.lon });
}

async function launch(loc) {
  setBusy(true);
  $('status').classList.remove('err');
  const game = new Game(loc);
  window.__game = game;
  const ok = await game.start();
  if (!ok) setBusy(false);
}

renderLocationList();
$('go').addEventListener('click', launchCustom);

// ?lat=..&lon=..  or  ?auto=1  launches without a click (shareable, and lets
// the page be opened headlessly for diagnostics)
const qs = new URLSearchParams(location.search);
if (qs.has('lat') && qs.has('lon')) {
  launch({ name: 'Custom', lat: parseFloat(qs.get('lat')), lon: parseFloat(qs.get('lon')) });
} else if (qs.has('auto')) {
  launch(LOCATIONS[Math.min(LOCATIONS.length - 1, parseInt(qs.get('auto'), 10) || 0)]);
}
for (const id of ['lat', 'lon']) {
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') launchCustom(); });
}
$('status').textContent = 'Pick a place, or drop in your own coordinates.';
