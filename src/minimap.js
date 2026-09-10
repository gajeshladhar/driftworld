// ── Minimap: north-up land-cover map assembled from tile thumbnails ─────────
import { ZOOM, MINIMAP } from './config.js?v=8eaf432e';
import { tileBBoxMerc } from './geo.js?v=8eaf432e';

export class Minimap {
  constructor(canvas, store, frame) {
    this.canvas = canvas;
    this.store = store;
    this.frame = frame;
    const S = MINIMAP.size;
    canvas.width = canvas.height = S;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;
  }

  draw(player, buoys, target) {
    const ctx = this.ctx;
    const S = MINIMAP.size;
    const scale = S / MINIMAP.spanMetres;       // px per metre
    const [px, pz] = player.worldPos;
    const spanWorld = this.frame.spanWorld(ZOOM);

    ctx.save();
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = '#0c1622';
    ctx.fillRect(0, 0, S, S);

    // circular clip so it reads as an instrument, not a window
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S / 2 - 1, 0, Math.PI * 2);
    ctx.clip();

    // land cover
    ctx.imageSmoothingEnabled = false;
    for (const t of this.store.tiles.values()) {
      if (!t.thumb) continue;
      const [xmin, , , ymax] = tileBBoxMerc(t.x, t.y, ZOOM);
      const [wx, wz] = this.frame.toWorld(xmin, ymax);   // NW corner
      const sx = (wx - px) * scale + S / 2;
      const sy = (wz - pz) * scale + S / 2;
      const sw = spanWorld * scale;
      if (sx > S || sy > S || sx + sw < 0 || sy + sw < 0) continue;
      ctx.drawImage(t.thumb, sx, sy, sw + 1, sw + 1);
    }

    // waypoints
    for (const b of buoys) {
      const sx = (b.wx - px) * scale + S / 2;
      const sy = (b.wz - pz) * scale + S / 2;
      const isTarget = target && b.id === target.id;
      ctx.beginPath();
      ctx.arc(sx, sy, isTarget ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fillStyle = isTarget ? '#ffd24a' : '#ff7a3d';
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(0,0,0,.6)';
      ctx.stroke();
    }

    // heading cone
    ctx.save();
    ctx.translate(S / 2, S / 2);
    ctx.rotate(player.heading);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, S * 0.42, -Math.PI / 2 - 0.42, -Math.PI / 2 + 0.42);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,.10)';
    ctx.fill();

    // player arrow
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(5.5, 6);
    ctx.lineTo(0, 3);
    ctx.lineTo(-5.5, 6);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#0c1622';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.restore();
    ctx.restore();

    // bezel + north tick
    ctx.beginPath();
    ctx.arc(S / 2, S / 2, S / 2 - 1, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(150,200,230,.35)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#7fd4ff';
    ctx.font = 'bold 10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.fillText('N', S / 2, 12);
  }
}
