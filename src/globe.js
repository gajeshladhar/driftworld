// ── Globe view: the whole Earth, from the same tiles as the local world ─────
// The playable world is a flat local tangent plane, so this is a separate
// scene: low-zoom tiles wrapped onto a sphere.
//
// One thing the local renderer never has to deal with: at global zoom most of
// the frame is open ocean, which the Sentinel-2 product does not classify at
// all — it comes back as #000000 nodata. Snapping that to the nearest palette
// entry would paint the Pacific dark green, so nodata is treated as ocean here.
import * as THREE from 'three';
import { GLOBE, CLASSES, CLASS_ORDER } from './config.js';
import { tileBBoxMerc, mercToLonLat } from './geo.js';

const SRC = CLASS_ORDER.map((k) => CLASSES[k].rgb.map((v) => v / 255));
const ART = CLASS_ORDER.map((k) => CLASSES[k].art.map((v) => v / 255));

const VERT = /* glsl */`
  varying vec2 vUv;
  varying vec3 vN;
  void main() {
    vUv = uv;
    vN = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D uLulc;
  uniform vec3 uSrc[9];
  uniform vec3 uArt[9];
  uniform vec3 uOcean;
  uniform vec3 uSun;
  varying vec2 vUv;
  varying vec3 vN;

  void main() {
    vec3 s = texture2D(uLulc, vUv).rgb;

    // nodata: the classifier simply has no opinion about open ocean
    float sea = 1.0 - step(0.06, max(s.r, max(s.g, s.b)));

    int idx = 0; float best = 1e9;
    for (int i = 0; i < 9; i++) {
      float d = distance(s, uSrc[i]);
      if (d < best) { best = d; idx = i; }
    }
    vec3 col = uArt[0];
    for (int i = 0; i < 9; i++) if (i == idx) col = uArt[i];
    col = mix(col, uOcean, sea);

    vec3 n = normalize(vN);
    float lam = max(dot(n, normalize(uSun)), 0.0);
    float lit = 0.14 + 0.86 * pow(lam, 0.85);          // soft terminator
    col *= lit;
    col += vec3(0.05, 0.12, 0.22) * pow(1.0 - max(dot(n, vec3(0.0, 0.0, 1.0)), 0.0), 3.0) * lam;
    gl_FragColor = vec4(col, 1.0);
  }
`;

/** lon/lat (degrees) to a point on the sphere. */
function toSphere(lon, lat, R) {
  const la = (lat * Math.PI) / 180, lo = (lon * Math.PI) / 180;
  return [R * Math.cos(la) * Math.cos(lo), R * Math.sin(la), -R * Math.cos(la) * Math.sin(lo)];
}

export class Globe {
  constructor(store) {
    this.store = store;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 1, 100000);
    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.spin = 0;
    this.tilt = 0.32;
    this.dist = GLOBE.radius * 3.1;
    this.built = new Set();
    this.materials = [];
    this.ready = false;

    this._addAtmosphere();
  }

  _addAtmosphere() {
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(GLOBE.radius * 1.028, 48, 32),
      new THREE.ShaderMaterial({
        side: THREE.BackSide, transparent: true, depthWrite: false,
        blending: THREE.AdditiveBlending,
        uniforms: { uColor: { value: new THREE.Color(0x5fb8ff) } },
        vertexShader: `varying vec3 vN;
          void main(){ vN = normalize(normalMatrix * normal);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `precision highp float; uniform vec3 uColor; varying vec3 vN;
          void main(){ float r = pow(1.0 - abs(vN.z), 3.2);
            gl_FragColor = vec4(uColor * r, r); }`,
      }),
    );
    this.scene.add(glow);

    const stars = new THREE.BufferGeometry();
    const pts = new Float32Array(1400 * 3);
    for (let i = 0; i < 1400; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(GLOBE.radius * 40);
      pts.set([v.x, v.y, v.z], i * 3);
    }
    stars.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    this.scene.add(new THREE.Points(stars, new THREE.PointsMaterial({
      color: 0xdfe9f5, size: GLOBE.radius * 0.012, sizeAttenuation: true,
      transparent: true, opacity: 0.75,
    })));
  }

  _patch(tile) {
    const z = GLOBE.zoom, seg = GLOBE.patchSeg, R = GLOBE.radius;
    const [xmin, ymin, xmax, ymax] = tileBBoxMerc(tile.x, tile.y, z);
    const n = seg + 1;
    const pos = new Float32Array(n * n * 3);
    const uvs = new Float32Array(n * n * 2);

    for (let j = 0; j < n; j++) {
      const v = j / seg;
      const my = ymax - v * (ymax - ymin);
      for (let i = 0; i < n; i++) {
        const u = i / seg;
        const mx = xmin + u * (xmax - xmin);
        const [lon, lat] = mercToLonLat(mx, my);
        const p = toSphere(lon, lat, R);
        const o = (j * n + i) * 3;
        pos[o] = p[0]; pos[o + 1] = p[1]; pos[o + 2] = p[2];
        const t = (j * n + i) * 2;
        uvs[t] = u; uvs[t + 1] = 1 - v;
      }
    }

    const idx = [];
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d2 = c + 1;
        idx.push(a, c, b, b, c, d2);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uLulc: { value: tile.texture },
        uSrc: { value: SRC.map((c) => new THREE.Vector3(...c)) },
        uArt: { value: ART.map((c) => new THREE.Vector3(...c)) },
        uOcean: { value: new THREE.Color(GLOBE.ocean) },
        uSun: { value: new THREE.Vector3(1, 0.35, 0.6).normalize() },
      },
    });
    this.materials.push(mat);
    this.root.add(new THREE.Mesh(geo, mat));
  }

  /** Stream every tile at the globe zoom; patches appear as they arrive. */
  load() {
    if (this._loading) return;
    this._loading = true;
    const z = GLOBE.zoom, n = Math.pow(2, z);
    this.total = n * n;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        this.store.request(x, y, z).then((t) => {
          if (!t) return;
          const k = `${z}/${x}/${y}`;
          if (this.built.has(k)) return;
          this.built.add(k);
          this._patch(t);
          if (this.built.size >= this.total * 0.85) this.ready = true;
        });
      }
    }
  }

  get progress() { return this.total ? this.built.size / this.total : 0; }

  update(dt, input) {
    // spin with the same keys that steer the craft
    const turn = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    this.spin += (turn * GLOBE.spinRate + GLOBE.drift) * dt;
    if (input.fwd) this.dist -= GLOBE.zoomRate * dt * this.dist;
    if (input.back) this.dist += GLOBE.zoomRate * dt * this.dist;
    const tilt = (input.up ? 1 : 0) - (input.down ? 1 : 0);
    this.tilt = Math.max(-1.35, Math.min(1.35, this.tilt + tilt * 0.6 * dt));
    this.dist = Math.max(GLOBE.radius * 1.25, Math.min(GLOBE.radius * 9, this.dist));

    this.camera.position.set(
      Math.sin(this.spin) * Math.cos(this.tilt) * this.dist,
      Math.sin(this.tilt) * this.dist,
      Math.cos(this.spin) * Math.cos(this.tilt) * this.dist,
    );
    this.camera.lookAt(0, 0, 0);
  }

  setSize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Where on Earth the camera is currently looking, for the return trip. */
  centreLonLat() {
    const lon = -(this.spin * 180) / Math.PI;
    const lat = (this.tilt * 180) / Math.PI;
    return [((lon + 540) % 360) - 180, Math.max(-80, Math.min(80, lat))];
  }
}
