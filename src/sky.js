// ── Banded gradient sky dome ─────────────────────────────────────────────────
// A quantised gradient rather than a photoreal model: smooth atmospheric
// scattering fights the pixel-art read, hard bands reinforce it.
import * as THREE from 'three';
import { SKY } from './config.js?v=969ac6ad';

export const HORIZON = new THREE.Color(SKY.horizon);

export function makeSky(sunDir) {
  const geo = new THREE.SphereGeometry(40000, 32, 20);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTop:     { value: new THREE.Color(SKY.top) },
      uMid:     { value: new THREE.Color(SKY.mid) },
      uHorizon: { value: HORIZON.clone() },
      uSun:     { value: sunDir.clone().normalize() },
      uCloud:   { value: 0.0 },
    },
    vertexShader: `
      varying vec3 vDir;
      void main(){
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      precision highp float;
      uniform vec3 uTop, uMid, uHorizon, uSun;
      uniform float uCloud;
      varying vec3 vDir;
      void main(){
        vec3 d = normalize(vDir);
        float h = clamp(d.y, 0.0, 1.0);
        // quantise the gradient into visible bands
        float b = floor(pow(h, 0.6) * 34.0) / 34.0;
        vec3 col = b < 0.42
          ? mix(uHorizon, uMid, b / 0.42)
          : mix(uMid, uTop, (b - 0.42) / 0.58);

        // overcast flattens the gradient toward a grey and veils the sun
        vec3 grey = vec3(dot(col, vec3(0.31, 0.55, 0.14)));
        col = mix(col, mix(grey, vec3(0.62, 0.64, 0.66), 0.45), uCloud * 0.78);

        float sd = dot(d, normalize(uSun));
        col += vec3(1.0, 0.95, 0.82) * step(0.9975, sd) * 1.2 * (1.0 - uCloud);
        col += vec3(1.0, 0.82, 0.55) * floor(pow(max(sd, 0.0), 9.0) * 5.0) / 5.0 * 0.55 * (1.0 - uCloud * 0.85);

        // haze thickening toward the horizon line
        col = mix(col, uHorizon, smoothstep(0.14, -0.03, d.y));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}
