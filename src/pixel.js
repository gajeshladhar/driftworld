// ── Pixel post-process: render small, upscale with nearest neighbour ─────────
import * as THREE from 'three';
import { PIXEL_SCALE } from './config.js?v=3adea2fa';

export class PixelPass {
  constructor(renderer) {
    this.renderer = renderer;
    this.scale = PIXEL_SCALE;
    this.target = new THREE.WebGLRenderTarget(1, 1, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: true,
    });
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: this.target.texture }, uRes: { value: new THREE.Vector2(1, 1) } },
      vertexShader: `
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: `
        precision highp float;
        uniform sampler2D uTex;
        uniform vec2 uRes;
        varying vec2 vUv;
        void main(){
          vec3 c = texture2D(uTex, vUv).rgb;

          // split-tone: cool the shadows, warm the highlights
          float l = dot(c, vec3(0.299, 0.587, 0.114));
          c = mix(c * vec3(0.90, 0.96, 1.12), c * vec3(1.10, 1.02, 0.90), smoothstep(0.18, 0.82, l));

          // gentle S-curve for contrast without crushing the flat class colours
          c = clamp(c, 0.0, 1.0);
          c = c * c * (3.0 - 2.0 * c) * 0.34 + c * 0.66;

          c = pow(c, vec3(0.96));          // slight lift
          vec2 d = vUv - 0.5;
          c *= 1.0 - dot(d, d) * 0.5;      // vignette
          gl_FragColor = vec4(c, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));
  }

  setSize(w, h) {
    // Match the device drawing buffer, not CSS pixels — otherwise on a HiDPI
    // screen the target would be half the canvas and upscale back to blur.
    const dpr = this.renderer.getPixelRatio();
    this.target.setSize(
      Math.max(1, Math.floor((w * dpr) / this.scale)),
      Math.max(1, Math.floor((h * dpr) / this.scale)),
    );
    this.material.uniforms.uRes.value.set(this.target.width, this.target.height);
  }

  render(scene, camera) {
    this.renderer.setRenderTarget(this.target);
    this.renderer.clear();
    this.renderer.render(scene, camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.camera);
  }
}
