// ── Ship: a hovering alien craft, rendered full-resolution ──────────────────
// Forward is -Z. Orientation is carried by three redundant cues: an asymmetric
// delta silhouette, cyan running lights forward vs magenta thrust aft, and a
// forward-pointing chevron on the hover pad below.
import * as THREE from 'three';
import { SHIP } from './config.js?v=969ac6ad';

const glow = (hex, opacity = 1) => new THREE.MeshBasicMaterial({
  color: hex, transparent: opacity < 1, opacity,
  blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
});

/** Delta planform, nose at +Y; extrusion rotates +Y to -Z (forward). */
function hullShape() {
  const s = new THREE.Shape();
  s.moveTo(0, 26);           // nose
  s.lineTo(4.6, 15);
  s.lineTo(7.6, 1);
  s.lineTo(17.5, -12);       // wingtip
  s.lineTo(12.5, -17.5);
  s.lineTo(4.6, -13);
  s.lineTo(0, -15.5);        // rear notch
  s.lineTo(-4.6, -13);
  s.lineTo(-12.5, -17.5);
  s.lineTo(-17.5, -12);
  s.lineTo(-7.6, 1);
  s.lineTo(-4.6, 15);
  s.closePath();
  return s;
}

export function makeShip() {
  const g = new THREE.Group();

  // ── hull ──
  const hullGeo = new THREE.ExtrudeGeometry(hullShape(), {
    depth: 3.4, bevelEnabled: true, bevelSize: 1.9, bevelThickness: 1.5,
    bevelSegments: 4, curveSegments: 16,
  });
  hullGeo.rotateX(-Math.PI / 2);      // lay flat: shape +Y becomes -Z (forward)
  hullGeo.computeVertexNormals();

  const hull = new THREE.Mesh(hullGeo, new THREE.MeshStandardMaterial({
    color: SHIP.hull, metalness: 0.30, roughness: 0.42,
    emissive: 0x14203a, emissiveIntensity: 0.55, flatShading: false,
  }));
  hull.position.y = 2.2;
  g.add(hull);

  // spine ridge — breaks up the flat deck and points forward
  const spine = new THREE.Mesh(
    new THREE.CylinderGeometry(1.5, 2.6, 30, 6),
    new THREE.MeshStandardMaterial({ color: SHIP.hullTrim, metalness: 0.7, roughness: 0.25 }),
  );
  spine.rotation.x = Math.PI / 2;
  spine.position.set(0, 4.6, -2);
  g.add(spine);

  // ── canopy, well forward ──
  const canopyGeo = new THREE.SphereGeometry(4.4, 24, 16);
  canopyGeo.scale(0.85, 0.62, 1.75);
  const canopy = new THREE.Mesh(canopyGeo, new THREE.MeshStandardMaterial({
    color: 0x0d1c2e, metalness: 0.2, roughness: 0.08,
    emissive: SHIP.accent, emissiveIntensity: 0.35,
    transparent: true, opacity: 0.9,
  }));
  canopy.position.set(0, 5.0, -9);
  g.add(canopy);

  // ── forward chevron on the deck ──
  const chev = new THREE.Shape();
  chev.moveTo(0, 4); chev.lineTo(3.6, -2.4); chev.lineTo(1.7, -2.4);
  chev.lineTo(0, 0.6); chev.lineTo(-1.7, -2.4); chev.lineTo(-3.6, -2.4);
  chev.closePath();
  const chevMesh = new THREE.Mesh(new THREE.ShapeGeometry(chev), glow(SHIP.accent));
  chevMesh.rotation.x = -Math.PI / 2;
  chevMesh.position.set(0, 4.3, -17);
  g.add(chevMesh);

  // ── leading-edge lights: CYAN = front ──
  const leadMat = glow(SHIP.accent);
  for (const s of [-1, 1]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 21), leadMat);
    bar.position.set(s * 8.5, 3.4, -7);
    bar.rotation.y = s * 0.42;
    g.add(bar);
    const tip = new THREE.Mesh(new THREE.SphereGeometry(1.5, 12, 10), leadMat);
    tip.position.set(s * 17, 3.0, 12);
    g.add(tip);
  }

  // ── engines: MAGENTA = rear ──
  const engMat = new THREE.MeshStandardMaterial({
    color: 0x1b2338, metalness: 0.8, roughness: 0.3,
  });
  const thrustMat = glow(SHIP.thrust, 0.9);
  const plumeMat = glow(SHIP.thrust, 0.32);
  const engines = [];
  const plumes = [];
  for (const s of [-1, 1]) {
    const nac = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 4.1, 13, 16), engMat);
    nac.rotation.x = Math.PI / 2;
    nac.position.set(s * 7.4, 3.4, 10);
    g.add(nac);

    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.5, 0.75, 10, 20), thrustMat);
    ring.position.set(s * 7.4, 3.4, 16.4);
    g.add(ring);
    engines.push(ring);

    const plume = new THREE.Mesh(new THREE.ConeGeometry(2.0, 13, 14, 1, true), plumeMat);
    plume.rotation.x = -Math.PI / 2;
    plume.position.set(s * 7.4, 3.4, 22);
    g.add(plume);
    plumes.push(plume);
  }

  // ── hover pad: forward-pointing chevron cast on the water ──
  const pad = new THREE.Group();
  const disc = new THREE.Mesh(new THREE.CircleGeometry(21, 32), glow(SHIP.accent, 0.10));
  disc.rotation.x = -Math.PI / 2;
  pad.add(disc);
  // No chevron down here: the hull silhouette and the cyan/magenta split
  // already carry orientation, and a second marker just adds clutter.
  pad.position.y = -1.6;
  g.add(pad);

  // ── underglow ──
  const under = new THREE.Mesh(new THREE.CircleGeometry(15, 28), glow(SHIP.thrust, 0.18));
  under.rotation.x = -Math.PI / 2;
  under.position.y = 0.4;
  g.add(under);

  g.userData = { engines, plumes, plumeMat, thrustMat, canopy, pad, spine, t: 0 };
  return g;
}

/** @param {number} throttle 0..1  @param {number} boost 0..1 */
export function updateShip(ship, dt, throttle, boost, moving) {
  const u = ship.userData;
  u.t += dt;

  // engines flare with throttle; plumes stretch backwards
  const heat = 0.35 + throttle * 0.65 + boost * 0.5;
  u.thrustMat.opacity = Math.min(1, heat);
  u.plumeMat.opacity = moving ? Math.min(0.42, 0.04 + throttle * 0.34 + boost * 0.16) : 0.0;
  for (const p of u.plumes) {
    const stretch = 0.4 + throttle * 0.8 + boost * 0.5;
    p.scale.set(0.9, stretch, 0.9);
    p.position.z = 17 + stretch * 6;
  }
  for (const r of u.engines) {
    r.scale.setScalar(1 + Math.sin(u.t * 9) * 0.04 + throttle * 0.12);
  }

  // Idle hover only. Nothing on this craft spins: a rotating element reads as
  // the whole ship turning at quarter resolution, and a rotating hover chevron
  // destroys the very cue it exists to provide.
  ship.children[0].position.y = 2.2 + Math.sin(u.t * 1.7) * 0.35;
  u.canopy.material.emissiveIntensity = 0.3 + Math.sin(u.t * 2.3) * 0.08;
}
