// ── Place awareness: real names on the real world ──────────────────────────
// Two independent sources, so one failing never blanks the other:
//   · BigDataCloud reverse geocode  -> which locality/region you are in (HUD)
//   · OpenStreetMap Overpass        -> named towns and peaks around you (labels)
// Both are unauthenticated and send permissive CORS. Overpass is a shared
// community service, so queries are debounced hard and failures are silent.
import * as THREE from 'three';
import { VERTICAL_EXAGGERATION, PLACES } from './config.js?v=d8439539';
import { lonLatToMerc, mercToLonLat } from './geo.js?v=d8439539';

const GEOCODE = 'https://api.bigdatacloud.net/data/reverse-geocode-client';
const OVERPASS = 'https://overpass-api.de/api/interpreter';

const KIND_RANK = { city: 0, town: 1, peak: 2, village: 3, hamlet: 4 };

// Each kind gets its own accent and glyph, so the map reads at a glance:
// warm for terrain, cool for settlement, brighter for bigger.
const KIND_STYLE = {
  city:    { accent: '#38e8ff', glyph: '◉', tag: 'CITY' },
  town:    { accent: '#6fd0f0', glyph: '◎', tag: 'TOWN' },
  village: { accent: '#9fbccc', glyph: '○', tag: 'VILLAGE' },
  hamlet:  { accent: '#9fbccc', glyph: '○', tag: 'HAMLET' },
  peak:    { accent: '#ffd24a', glyph: '▲', tag: 'PEAK' },
};

function roundRect(ctx, x, y, w, h, r) {
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * A label is a rounded plaque on a stem with a dot at the anchor point, so it
 * reads as pinned to a location rather than floating near one. The sprite is
 * bottom-anchored (center.y = 0) and positioned at ground level, which puts
 * that dot exactly on the place.
 */
function makeLabelSprite(text, kind) {
  const S = 2;                                   // supersample for crisp text
  const FS = 30 * S, TAG = 14 * S, PAD = 15 * S;
  const STEM = 46 * S, DOT = 5 * S, GAP = 5 * S;
  const style = KIND_STYLE[kind] || KIND_STYLE.village;

  const probe = document.createElement('canvas').getContext('2d');
  const nameFont = `600 ${FS}px ui-monospace, Menlo, Consolas, monospace`;
  const tagFont = `500 ${TAG}px ui-monospace, monospace`;
  probe.font = nameFont;
  const nameW = probe.measureText(text).width;
  probe.font = tagFont;
  const tagLine = `${style.glyph}  ${style.tag}`;
  const tagW = probe.measureText(tagLine).width;

  const pillW = Math.ceil(Math.max(nameW, tagW) + PAD * 2);
  const pillH = Math.ceil(PAD * 2 + TAG + GAP + FS);
  const c = document.createElement('canvas');
  c.width = pillW + 8 * S;                       // margin for the outer glow
  c.height = pillH + STEM + DOT * 2 + 8 * S;
  const ctx = c.getContext('2d');
  const cx = c.width / 2;
  const px = (c.width - pillW) / 2;

  // stem + anchor dot, drawn first so the plaque overlaps it cleanly
  ctx.strokeStyle = style.accent;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1.5 * S;
  ctx.beginPath();
  ctx.moveTo(cx, pillH);
  ctx.lineTo(cx, c.height - DOT * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = style.accent;
  ctx.beginPath();
  ctx.arc(cx, c.height - DOT * 2, DOT, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 0.28;
  ctx.beginPath();
  ctx.arc(cx, c.height - DOT * 2, DOT * 2.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // plaque: soft drop shadow, vertical gradient, hairline border
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 10 * S;
  ctx.shadowOffsetY = 2 * S;
  const grad = ctx.createLinearGradient(0, 0, 0, pillH);
  grad.addColorStop(0, 'rgba(16,30,44,0.90)');
  grad.addColorStop(1, 'rgba(7,14,22,0.78)');
  ctx.fillStyle = grad;
  roundRect(ctx, px, 0, pillW, pillH, 9 * S);
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = 'rgba(190,225,245,0.20)';
  ctx.lineWidth = 1 * S;
  roundRect(ctx, px + 0.5, 0.5, pillW - 1, pillH - 1, 9 * S);
  ctx.stroke();

  // a short accent underline instead of a full-height side bar
  ctx.fillStyle = style.accent;
  ctx.globalAlpha = 0.9;
  ctx.fillRect(cx - pillW * 0.18, pillH - 2.5 * S, pillW * 0.36, 2 * S);
  ctx.globalAlpha = 1;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = tagFont;
  ctx.fillStyle = style.accent;
  ctx.globalAlpha = 0.92;
  ctx.fillText(tagLine, cx, PAD);
  ctx.globalAlpha = 1;

  ctx.font = nameFont;
  ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.shadowBlur = 4 * S;
  ctx.fillStyle = '#f2f8fc';
  ctx.fillText(text, cx, PAD + TAG + GAP);

  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;

  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false, depthWrite: false,
  }));
  sprite.center.set(0.5, 0);        // anchor the dot, not the middle
  sprite.userData.aspect = c.width / c.height;
  sprite.renderOrder = 10;
  sprite.visible = false;
  return sprite;
}

export class Places {
  constructor(scene, frame, store) {
    this.scene = scene;
    this.frame = frame;
    this.store = store;
    this.group = new THREE.Group();
    scene.add(this.group);

    this.labels = [];             // { name, kind, mx, my, wx, wz, sprite }
    this.region = null;           // { locality, region, country, label }
    this.lastGeocode = null;      // world pos of the last reverse geocode
    this.lastQuery = null;        // world pos of the last Overpass query
    this.queryAt = -Infinity;     // timestamp guard; must not gate the first query
    this.busy = false;
    this.onRegion = null;         // callback(label) when the locality changes
  }

  _clear() {
    for (const l of this.labels) {
      l.sprite.material.map.dispose();
      l.sprite.material.dispose();
      this.group.remove(l.sprite);
    }
    this.labels = [];
  }

  async _geocode(lat, lon) {
    try {
      const r = await fetch(`${GEOCODE}?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
      if (!r.ok) return;
      const d = await r.json();
      const locality = d.locality || d.city || d.principalSubdivision || '';
      const region = d.principalSubdivision || '';
      const country = d.countryName || '';
      const label = [locality, country].filter(Boolean).join(' · ') || 'Open water';
      const changed = !this.region || this.region.label !== label;
      this.region = { locality, region, country, label };
      if (changed) this.onRegion?.(label);
    } catch { /* offline or blocked — the HUD just keeps the previous value */ }
  }

  async _overpass(lat, lon) {
    const dLat = PLACES.bboxDeg;
    const dLon = PLACES.bboxDeg / Math.max(0.15, Math.cos((lat * Math.PI) / 180));
    const box = `${lat - dLat},${lon - dLon},${lat + dLat},${lon + dLon}`;
    const q = `[out:json][timeout:25];(`
            + `node["place"~"^(city|town|village|hamlet)$"]["name"](${box});`
            + `node["natural"="peak"]["name"](${box});`
            + `);out body ${PLACES.maxFetch};`;
    try {
      const r = await fetch(OVERPASS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q),
      });
      if (!r.ok) return;
      const d = await r.json();
      this._clear();
      const seen = new Set();
      for (const e of d.elements || []) {
        const name = e.tags?.name;
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const kind = e.tags.place || e.tags.natural || 'place';
        const [mx, my] = lonLatToMerc(e.lon, e.lat);
        const [wx, wz] = this.frame.toWorld(mx, my);
        const sprite = makeLabelSprite(name, kind);
        this.group.add(sprite);
        this.labels.push({ name, kind, rank: KIND_RANK[kind] ?? 5, mx, my, wx, wz, sprite });
      }
      this.labels.sort((a, b) => a.rank - b.rank);
    } catch { /* Overpass is best-effort; the region readout still works */ }
  }

  /** Refresh both sources when the player has travelled far enough. */
  maybeRefresh(player) {
    const [px, pz] = player.worldPos;
    const moved = (last) => !last || Math.hypot(px - last[0], pz - last[1]);

    const dGeo = moved(this.lastGeocode);
    if (dGeo === true || dGeo > PLACES.geocodeEvery) {
      this.lastGeocode = [px, pz];
      const [lon, lat] = mercToLonLat(player.mx, player.my);
      this._geocode(lat, lon);
    }

    const now = performance.now();
    const dQ = moved(this.lastQuery);
    const farEnough = dQ === true || dQ > PLACES.queryEvery;
    if (farEnough && !this.busy && now - this.queryAt > PLACES.minQueryGapMs) {
      this.lastQuery = [px, pz];
      this.queryAt = now;
      this.busy = true;
      const [lon, lat] = mercToLonLat(player.mx, player.my);
      this._overpass(lat, lon).finally(() => { this.busy = false; });
    }
  }

  /**
   * Show only the nearest few labels, sized for constant on-screen height and
   * faded with distance. Anything else is clutter over a terrain this busy.
   */
  update(player) {
    if (!this.labels.length) return;
    const [px, pz] = player.worldPos;

    for (const l of this.labels) {
      l.dist = Math.hypot(l.wx - px, l.wz - pz);
    }
    const near = [...this.labels]
      .filter((l) => l.dist < PLACES.maxDistance)
      .sort((a, b) => (a.dist + a.rank * PLACES.rankBias) - (b.dist + b.rank * PLACES.rankBias))
      .slice(0, PLACES.maxVisible);
    const show = new Set(near);

    for (const l of this.labels) {
      const sprite = l.sprite;
      if (!show.has(l)) { sprite.visible = false; continue; }

      const h = (this.store.heightAtMerc(l.mx, l.my) ?? 0) * VERTICAL_EXAGGERATION;
      const size = Math.min(Math.max(l.dist * 0.075, 40), 900);
      sprite.position.set(l.wx, h + 8, l.wz);   // the anchor dot lands on the ground
      sprite.scale.set(size * sprite.userData.aspect, size, 1);
      sprite.material.opacity = 1 - Math.max(0,
        (l.dist - PLACES.fadeStart) / (PLACES.maxDistance - PLACES.fadeStart));
      sprite.visible = true;
    }
  }
}
