// ── Cloud deck ──────────────────────────────────────────────────────────────
// A few large horizontal sheets of procedural noise, not volumetrics: the cost
// is pure arithmetic, which this renderer has plenty of headroom for, whereas
// raymarching would not survive alongside the terrain.
//
// The whole point is being able to fly through it, so two things matter more
// than the shape of the cloud. The deck follows the camera in XZ, so it never
// runs out. And each layer fades out as the camera approaches its altitude,
// because a flat sheet seen edge-on is a razor line across the screen — that
// fade is what turns "a plane at 2600 m" into "passing through cloud".
import * as THREE from 'three';
import { CLOUDS } from './config.js?v=d8439539';

const VERT = /* glsl */`
  varying vec3 vWorld;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */`
  precision highp float;
  uniform float uCover;      // 0..1 from the live cloud_cover reading
  uniform float uHeight;     // this layer's altitude, world units
  uniform float uScale;
  uniform float uFar;
  uniform vec2  uDrift;      // advected by real wind
  uniform vec3  uSun;
  uniform vec3  uTint;       // horizon colour, so the deck sits in the sky
  uniform float uSeed;
  varying vec3 vWorld;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }

  float fbm(vec2 p) {
    float v = 0.0, a = 0.55;
    for (int i = 0; i < 4; i++) { v += a * vnoise(p); p *= 2.07; a *= 0.5; }
    return v;
  }

  void main() {
    vec2 p = vWorld.xz * uScale + uDrift + uSeed;
    float n = fbm(p);

    // more coverage lowers the threshold, so cloud grows rather than brightens
    float t = mix(0.80, 0.34, clamp(uCover, 0.0, 1.0));
    float a = smoothstep(t, t + 0.22, n);
    if (a <= 0.001) discard;

    // never let the sheet reach its own edge
    float d = distance(cameraPosition.xz, vWorld.xz);
    a *= 1.0 - smoothstep(uFar * 0.30, uFar * 0.95, d);

    // Thin it at grazing angles, where the slant path through a flat sheet is
    // effectively infinite. Only a gentle rolloff: cloud genuinely does reach
    // the horizon, it just must not go opaque there.
    vec3 toCam = normalize(cameraPosition - vWorld);
    a *= smoothstep(0.010, 0.070, abs(toCam.y));

    // dissolve as the camera nears this altitude: this is the fly-through
    float gap = abs(cameraPosition.y - uHeight);
    a *= smoothstep(0.0, CLOUD_FADE, gap);

    // lit from above, shadowed underneath, so the deck reads as solid from below
    float above = smoothstep(-40.0, 40.0, cameraPosition.y - uHeight);
    vec3 top  = vec3(1.00, 0.98, 0.95);
    vec3 base = vec3(0.40, 0.46, 0.58);
    vec3 col = mix(base, top, above);

    float sun = max(dot(normalize(uSun), vec3(0.0, 1.0, 0.0)), 0.0);
    col = mix(col, col * vec3(1.05, 0.96, 0.86), 0.5);
    col *= 0.72 + 0.42 * sun;

    // blend into the horizon haze at distance so it never looks pasted on
    col = mix(col, uTint, smoothstep(uFar * 0.12, uFar * 0.5, d) * 0.35);

    // three sheets compound, so each must stay thin
    gl_FragColor = vec4(col, a * 0.58);
  }
`;

export class Clouds {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);
    this.layers = [];

    const geo = new THREE.PlaneGeometry(CLOUDS.span, CLOUDS.span, 1, 1);
    geo.rotateX(-Math.PI / 2);

    for (let i = 0; i < CLOUDS.layers; i++) {
      const height = CLOUDS.base + i * CLOUDS.spacing;
      const mat = new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG.replace('CLOUD_FADE', CLOUDS.fade.toFixed(1)),
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        uniforms: {
          uCover:  { value: 0.35 },
          uHeight: { value: height },
          uScale:  { value: CLOUDS.scale * (1 + i * 0.22) },
          uFar:    { value: CLOUDS.span * 0.5 },
          uDrift:  { value: new THREE.Vector2() },
          uSun:    { value: new THREE.Vector3(0.5, 0.5, 0.5) },
          uTint:   { value: new THREE.Color(0xdcb894) },
          uSeed:   { value: i * 37.4 },
        },
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = height;
      mesh.renderOrder = 5;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.layers.push({ mesh, mat, height });
    }
  }

  /** Coverage from the live reading; wind advects the deck. */
  setWeather(coverPct, windSpeed, windFromDeg) {
    const cover = Math.max(0, Math.min(1, (coverPct ?? 0) / 100));
    this.group.visible = cover > 0.04;
    for (const l of this.layers) l.mat.uniforms.uCover.value = cover;
    const to = ((windFromDeg ?? 0) + 180) * (Math.PI / 180);
    this.windX = Math.sin(to) * (windSpeed ?? 0);
    this.windZ = -Math.cos(to) * (windSpeed ?? 0);
  }

  setAtmosphere(sunDir, tint) {
    for (const l of this.layers) {
      l.mat.uniforms.uSun.value.copy(sunDir);
      l.mat.uniforms.uTint.value.copy(tint);
    }
  }

  update(dt, camera) {
    if (!this.group.visible) return;
    for (let i = 0; i < this.layers.length; i++) {
      const l = this.layers[i];
      // keep the deck centred on the camera; it is a sky, not a place
      l.mesh.position.set(camera.position.x, l.height, camera.position.z);
      const d = l.mat.uniforms.uDrift.value;
      const s = l.mat.uniforms.uScale.value * CLOUDS.driftScale * (1 - i * 0.18);
      d.x -= (this.windX ?? 0) * dt * s;
      d.y -= (this.windZ ?? 0) * dt * s;
    }
  }
}
