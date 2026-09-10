// ── HUD painted into a canvas, for recording ────────────────────────────────
// getDisplayMedia tab capture sees the DOM overlay but produces a malformed
// fragmented-MP4 container in headless Chrome (per-sample timings are right,
// the declared duration is not, and players stop early). Canvas capture has
// always produced correct files, so the HUD is redrawn here instead and
// composited over the WebGL frame.
//
// Values are read from the live DOM rather than recomputed, so what is
// recorded always matches what the player sees.
import { CLASS_ORDER, CLASSES } from './config.js?v=d8439539';

const MONO = 'ui-monospace, Menlo, Consolas, monospace';
const INK = '#e8f1f7', DIM = '#8ea6b8', FAINT = '#5f7688', ACCENT = '#38e8ff', GOLD = '#ffd24a';

const $ = (id) => document.getElementById(id);
const txt = (id) => ($(id)?.textContent ?? '').trim();

function panel(ctx, x, y, w, h) {
  ctx.fillStyle = 'rgba(8,17,26,0.74)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = 'rgba(120,190,225,0.20)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  // corner brackets, matching the CSS
  ctx.strokeStyle = 'rgba(56,232,255,0.55)';
  ctx.beginPath();
  ctx.moveTo(x, y + 9); ctx.lineTo(x, y); ctx.lineTo(x + 9, y);
  ctx.moveTo(x + w, y + h - 9); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - 9, y + h);
  ctx.stroke();
}

function meter(ctx, x, y, w, h, frac, colA, colB) {
  ctx.fillStyle = 'rgba(255,255,255,0.07)';
  ctx.fillRect(x, y, w, h);
  const g = ctx.createLinearGradient(x, y, x + w, y);
  g.addColorStop(0, colA); g.addColorStop(1, colB);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, Math.max(0, Math.min(1, frac)) * w, h);
}

const pct = (id) => (parseFloat(($(id)?.style.width || '0').replace('%', '')) || 0) / 100;

export function drawHudOverlay(ctx, W, H) {
  ctx.save();
  ctx.textBaseline = 'top';

  // ── readout, top left ──
  const dts = [...document.querySelectorAll('#readout dt')];
  const dds = [...document.querySelectorAll('#readout dd')];
  const rw = 300, rh = 18 + dts.length * 20 + 10;
  panel(ctx, 14, 14, rw, rh);
  dts.forEach((dt, i) => {
    const y = 14 + 14 + i * 20;
    ctx.font = `10px ${MONO}`;
    ctx.fillStyle = FAINT;
    ctx.textAlign = 'left';
    ctx.fillText(dt.textContent, 14 + 13, y + 3);
    ctx.font = `12px ${MONO}`;
    const id = dds[i]?.id;
    ctx.fillStyle = id === 'r-wp' ? GOLD
                  : id === 'r-region' ? ACCENT
                  : id === 'r-cls' ? (dds[i].textContent.trim() === 'Water' ? ACCENT : '#ffd27f')
                  : INK;
    ctx.textAlign = 'right';
    ctx.fillText(dds[i].textContent, 14 + rw - 13, y);
  });

  // ── compass, top centre ──
  const comp = $('compass');
  if (comp) {
    const cw = comp.width, ch = comp.height;
    panel(ctx, W / 2 - cw / 2 - 9, 14, cw + 18, ch + 8);
    ctx.drawImage(comp, W / 2 - cw / 2, 18);
  }

  // ── chart, top right ──
  const map = $('map');
  if (map && !$('mapwrap').classList.contains('hidden')) {
    const s = map.width;
    const px = W - 14 - s - 18, py = 14;
    panel(ctx, px, py, s + 18, s + 32);
    ctx.save();
    ctx.beginPath();
    ctx.arc(px + 9 + s / 2, py + 9 + s / 2, s / 2, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(map, px + 9, py + 9);
    ctx.restore();
    ctx.font = `9px ${MONO}`;
    ctx.fillStyle = FAINT;
    ctx.textAlign = 'center';
    ctx.fillText('C H A R T', px + 9 + s / 2, py + s + 15);
  }

  // ── legend, bottom left ──
  const lh = 14 + CLASS_ORDER.length * 17 + 8;
  panel(ctx, 14, H - 14 - lh, 150, lh);
  CLASS_ORDER.forEach((k, i) => {
    const y = H - 14 - lh + 12 + i * 17;
    const c = CLASSES[k];
    ctx.fillStyle = `rgb(${c.art[0]},${c.art[1]},${c.art[2]})`;
    ctx.fillRect(14 + 13, y + 2, 8, 8);
    ctx.font = `10px ${MONO}`;
    ctx.fillStyle = DIM;
    ctx.textAlign = 'left';
    ctx.fillText(c.name, 14 + 27, y + 1);
  });

  // ── mission bar, bottom centre ──
  const mw = Math.min(520, W * 0.64), mx = W / 2 - mw / 2, mh = 92, my = H - 14 - mh;
  panel(ctx, mx, my, mw, mh);
  ctx.font = `700 23px ${MONO}`;
  ctx.fillStyle = INK;
  ctx.textAlign = 'left';
  ctx.fillText(txt('m-score'), mx + 15, my + 12);
  ctx.font = `11px ${MONO}`;
  ctx.fillStyle = ACCENT;
  ctx.textAlign = 'right';
  ctx.fillText(txt('m-rank'), mx + mw - 15, my + 16);
  const chain = txt('m-chain');
  if (chain) {
    ctx.fillStyle = $('m-chain').classList.contains('hot') ? '#ff5bc8' : GOLD;
    ctx.textAlign = 'center';
    ctx.fillText(chain, mx + mw / 2, my + 16);
  }

  ctx.font = `9px ${MONO}`;
  ctx.fillStyle = FAINT;
  ctx.textAlign = 'left';
  ctx.fillText('L I V E S', mx + 15, my + 44);
  ctx.textAlign = 'right';
  ctx.fillText(txt('m-lives'), mx + mw - 15, my + 44);
  const pips = [...document.querySelectorAll('#lives i')];
  const gap = 4, pw = (mw - 30 - gap * (pips.length - 1)) / Math.max(1, pips.length);
  pips.forEach((el, i) => {
    const on = el.classList.contains('on');
    const low = el.classList.contains('low');
    ctx.fillStyle = on ? (low ? '#ff7a6a' : '#3dffa8') : 'rgba(255,255,255,0.10)';
    ctx.fillRect(mx + 15 + i * (pw + gap), my + 56, pw, 7);
  });

  ctx.fillStyle = FAINT;
  ctx.textAlign = 'left';
  ctx.fillText(txt('m-nextlabel'), mx + 15, my + 70);
  ctx.textAlign = 'right';
  ctx.fillText(txt('m-beacons'), mx + mw - 15, my + 70);
  meter(ctx, mx + 15, my + 82, mw - 30, 5, pct('rankFill'), '#6a5ac0', GOLD);

  // ── controls, bottom right ──
  const lines = [
    ['W/↑', 'thrust', 'S', 'brake'],
    ['A/D', 'steer', 'Shift', 'boost'],
    ['Space', 'climb', 'Ctrl', 'dive'],
    ['T', 'sky', 'G', 'pull up'],
  ];
  const cwid = 176, chgt = 14 + lines.length * 17 + 6;
  const cx0 = W - 14 - cwid, cy0 = H - 14 - chgt;
  panel(ctx, cx0, cy0, cwid, chgt);
  ctx.font = `10px ${MONO}`;
  lines.forEach((ln, i) => {
    const y = cy0 + 12 + i * 17;
    let x = cx0 + cwid - 13;
    ctx.textAlign = 'right';
    for (let k = ln.length - 1; k >= 0; k--) {
      ctx.fillStyle = k % 2 === 0 ? DIM : FAINT;
      ctx.fillText(ln[k], x, y);
      x -= ctx.measureText(ln[k]).width + 6;
    }
  });

  ctx.restore();
}
