// ── Terrain: DEM-displaced tile meshes textured with land cover ──────────────
import * as THREE from 'three';
import { ZOOM, MESH_SEG, LOAD_RADIUS, UNLOAD_RADIUS, VERTICAL_EXAGGERATION, CLASSES } from './config.js?v=d8439539';
import { tileBBoxMerc, tileSpanMerc, mercToTile } from './geo.js?v=d8439539';
import { buildProps, disposeProps } from './props.js?v=d8439539';

const ORDER = ['WATER','TREES','FLOODED','CROPS','BUILT','BARE','SNOW','CLOUDS','RANGELAND'];
const SRC = ORDER.map(k => CLASSES[k].rgb.map(v => v / 255));
const ART = ORDER.map(k => CLASSES[k].art.map(v => v / 255));

const VERT = /* glsl */`
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vWorld;
  varying float vHeight;
  void main() {
    vUv = uv;
    vNormalW = normalize(mat3(modelMatrix) * normal);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    vHeight = position.y;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  uniform sampler2D uLulc;
  uniform vec3  uSrc[9];
  uniform vec3  uArt[9];
  uniform vec3  uSunDir;
  uniform vec3  uFogColor;
  uniform vec3  uSkyTop;
  uniform float uFogNear, uFogFar, uTime;
  uniform vec2  uSea;      // x = wave amplitude, y = time scale
  varying vec2 vUv;
  varying vec3 vNormalW;
  varying vec3 vWorld;
  varying float vHeight;

  // Four travelling waves at different scales and headings. This is pure
  // arithmetic: no texture reads, so it costs almost nothing next to the
  // single class lookup this shader already does.
  // Three swells travelling on non-aligned bearings at incommensurate
  // wavelengths. Axis-aligned sines share a common period and tile into a
  // visible grid; oblique ones do not repeat at any scale you can see.
  float waveH(vec2 p, float t) {
    vec2 a = vec2( 0.863,  0.505);
    vec2 b = vec2(-0.407,  0.913);
    vec2 c = vec2( 0.291, -0.957);
    float ts = t * uSea.y;
    return (sin(dot(p, a) * 0.0083 + ts * 0.62) * 0.60
          + sin(dot(p, b) * 0.0047 - ts * 0.44) * 0.48
          + sin(dot(p, c) * 0.0026 + ts * 0.29) * 0.36) * uSea.x;
  }

  void main() {
    vec3 src = texture2D(uLulc, vUv).rgb;

    int   idx  = 0;
    float best = 1e9;
    for (int i = 0; i < 9; i++) {
      float d = distance(src, uSrc[i]);
      if (d < best) { best = d; idx = i; }
    }
    vec3 albedo = uArt[0];
    for (int i = 0; i < 9; i++) if (i == idx) albedo = uArt[i];
    float isWater = (idx == 0) ? 1.0 : 0.0;

    vec3 n = normalize(vNormalW);
    vec3 view = normalize(cameraPosition - vWorld);
    vec3 sun = normalize(uSunDir);
    vec3 col;

    if (isWater > 0.5) {
      float wd = 1.0 - smoothstep(400.0, 3400.0, distance(cameraPosition, vWorld));
      vec2 p = vWorld.xz;
      float h  = waveH(p, uTime) * wd;
      float hx = waveH(p + vec2(2.6, 0.0), uTime) * wd;
      float hz = waveH(p + vec2(0.0, 2.6), uTime) * wd;
      n = normalize(vec3((h - hx) * 0.5, 2.4, (h - hz) * 0.5));

      col = mix(albedo * 0.90, albedo * 1.14 + vec3(0.01, 0.03, 0.04),
                smoothstep(-1.1, 1.3, h));

      // the smooth part of the look: sky reflection at grazing angles
      float fres = pow(1.0 - max(dot(n, view), 0.0), 3.0);
      col = mix(col, mix(uFogColor, uSkyTop, 0.40), fres * 0.66);

      // one broad sheen only. A tight exponent picks out every crest and
      // turns a periodic surface into a grid of dots.
      vec3 hv = normalize(sun + view);
      col += vec3(1.00, 0.95, 0.84) * pow(max(dot(n, hv), 0.0), 48.0) * 0.30 * wd;

      col = floor(col * 64.0) / 64.0;
    } else {
      float lam = max(dot(n, sun), 0.0);
      float lit = 0.42 + 0.58 * floor(lam * 4.0 + 0.5) / 4.0;
      col = albedo * lit;
      col = mix(col * vec3(0.82, 0.87, 1.06), col * vec3(1.06, 1.01, 0.92), lam);
      col += vec3(0.06) * smoothstep(900.0, 2100.0, vHeight);
    }

    float f = smoothstep(uFogNear, uFogFar, distance(cameraPosition, vWorld));
    gl_FragColor = vec4(mix(col, uFogColor, f), 1.0);
  }
`;

export class Terrain {
  constructor(scene, store, frame) {
    this.scene = scene;
    this.store = store;
    this.frame = frame;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.materials = [];
    this.dirty = new Set();
    this.built = new Set();

    this.base = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uLulc:     { value: null },
        uSrc:      { value: SRC.map(c => new THREE.Vector3(...c)) },
        uArt:      { value: ART.map(c => new THREE.Vector3(...c)) },
        uSunDir:   { value: new THREE.Vector3(0.45, 0.72, 0.28).normalize() },
        uFogColor: { value: new THREE.Color(0x9fc4dd) },
        uSkyTop:   { value: new THREE.Color(0x1D4A7D) },
        uFogNear:  { value: 3200 },
        uFogFar:   { value: 11000 },
        uTime:     { value: 0 },
        uSea:      { value: new THREE.Vector2(0.9, 1.0) },
      },
    });
  }

  setTime(t) { for (const m of this.materials) m.uniforms.uTime.value = t; }

  /** Sea state from live marine data: amplitude and wave speed. */
  setSea(amp, speed) {
    this.base.uniforms.uSea.value.set(amp, speed);
    for (const m of this.materials) m.uniforms.uSea.value.set(amp, speed);
  }

  /** Swap the lighting/atmosphere on every live tile material. */
  setAtmosphere(sunDir, fogColor, skyTop) {
    this.base.uniforms.uSunDir.value.copy(sunDir);
    this.base.uniforms.uFogColor.value.copy(fogColor);
    this.base.uniforms.uSkyTop.value.copy(skyTop);
    for (const m of this.materials) {
      m.uniforms.uSunDir.value.copy(sunDir);
      m.uniforms.uFogColor.value.copy(fogColor);
      m.uniforms.uSkyTop.value.copy(skyTop);
    }
  }

  /** Fog opens up with altitude so the world doesn't vanish into haze up high. */
  setFog(near, far) {
    for (const m of this.materials) {
      m.uniforms.uFogNear.value = near;
      m.uniforms.uFogFar.value = far;
    }
  }

  buildMesh(tile) {
    const { x, y } = tile;
    const seg  = MESH_SEG;
    const span = tileSpanMerc(ZOOM);
    const [xmin, , , ymax] = tileBBoxMerc(x, y, ZOOM);

    const n = seg + 1;
    const pos = new Float32Array(n * n * 3);
    const uvs = new Float32Array(n * n * 2);

    for (let j = 0; j < n; j++) {
      const v = j / seg;
      const my = ymax - v * span;
      for (let i = 0; i < n; i++) {
        const u = i / seg;
        const mx = xmin + u * span;
        const [wx, wz] = this.frame.toWorld(mx, my);
        const h = this.store.heightAtMerc(mx, my);
        const o = (j * n + i) * 3;
        pos[o]     = wx;
        pos[o + 1] = (h ?? 0) * VERTICAL_EXAGGERATION;
        pos[o + 2] = wz;
        const t = (j * n + i) * 2;
        uvs[t] = u;
        uvs[t + 1] = 1 - v;   // texture row 0 is north; three flips Y on upload
      }
    }

    const idx = [];
    for (let j = 0; j < seg; j++) {
      for (let i = 0; i < seg; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    const mat = this.base.clone();
    mat.uniforms.uLulc.value = tile.texture;
    this.materials.push(mat);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = true;
    this.group.add(mesh);
    return mesh;
  }

  _attachProps(tile) {
    disposeProps(tile.props);
    tile.props = buildProps(tile, this.frame, this.store);
    this.group.add(tile.props);
  }

  rebuild(tile) {
    if (tile.mesh) {
      tile.mesh.geometry.dispose();
      const i = this.materials.indexOf(tile.mesh.material);
      if (i >= 0) this.materials.splice(i, 1);
      tile.mesh.material.dispose();
      this.group.remove(tile.mesh);
    }
    tile.mesh = this.buildMesh(tile);
    if (!tile.props) this._attachProps(tile);
  }

  /** Stream tiles around a mercator position. */
  update(mx, my) {
    const [cx, cy] = mercToTile(mx, my, ZOOM);

    for (let dy = -LOAD_RADIUS; dy <= LOAD_RADIUS; dy++) {
      for (let dx = -LOAD_RADIUS; dx <= LOAD_RADIUS; dx++) {
        const tx = cx + dx, ty = cy + dy;
        const k = `${ZOOM}/${tx}/${ty}`;
        const have = this.store.get(tx, ty);
        if (!have) {
          this.store.request(tx, ty).then((t) => {
            if (!t) return;
            // neighbours sample across this tile's edges — mark them stale
            for (let a = -1; a <= 1; a++)
              for (let b = -1; b <= 1; b++)
                this.dirty.add(`${ZOOM}/${t.x + a}/${t.y + b}`);
          });
        } else if (!have.mesh) {
          have.mesh = this.buildMesh(have);
          this._attachProps(have);
          this.built.add(k);
        } else if (this.dirty.has(k)) {
          this.dirty.delete(k);
          this.rebuild(have);
        }
      }
    }

    // dispose distant tiles
    for (const k of [...this.store.tiles.keys()]) {
      const [, sx, sy] = k.split('/').map(Number);
      if (Math.abs(sx - cx) > UNLOAD_RADIUS || Math.abs(sy - cy) > UNLOAD_RADIUS) {
        const t = this.store.tiles.get(k);
        if (t) disposeProps(t.props);
        if (t?.mesh) {
          const i = this.materials.indexOf(t.mesh.material);
          if (i >= 0) this.materials.splice(i, 1);
        }
        this.store.dispose(k);
        this.built.delete(k);
      }
    }
  }
}
