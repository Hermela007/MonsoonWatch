import * as THREE from 'three';
import { FOG } from '../theme';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { GeoFrame } from '../geo/region';
import { cellLngLat, gridCoords, sampleField, type Heightmap } from '../terrain/heightmap';
import type { SlideSource } from '../terrain/landslide';
import { REPLAY_HOURS, rainAccumulated } from '../data/replay2014';

const SURGE_SECONDS = 4.5; // real time for the debris to run out once a slope fails (the replay moves fast)
const WARN_FROM = 0.6; // cracks from this share of the slope's rain threshold
const ACROSS = 11;
// Strip widths are a map symbol, not to scale: drawn wider when the camera is far so they stay legible.
const SCALES = [1, 2, 4, 8];

const NOISE = /* glsl */ `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
`;

const vertexShader = /* glsl */ `
attribute vec2 aSlide;   // x = along (0 crown → 1 toe), y = across (-1..1)
uniform float uFront;
uniform float uFail;
uniform float uLift;
varying vec2 vSlide;
varying vec3 vWorld;
varying float vViewDist;
${NOISE}
void main() {
  vSlide = aSlide;
  vec4 w = modelMatrix * vec4(position, 1.0);
  // The deposit stands proud of the slope: a lumpy lobe at the toe once the debris has arrived.
  float across = 1.0 - aSlide.y * aSlide.y;
  float lobe = smoothstep(0.7, 0.95, aSlide.x) * smoothstep(0.75, 1.0, uFront) * uFail;
  float lumps = 0.6 + 0.8 * fbm(w.xz * 9.0);
  w.y += uLift * (1.0 + 1.6 * lobe * across * lumps);
  vWorld = w.xyz;
  vec4 mv = viewMatrix * w;
  vViewDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const fragmentShader = /* glsl */ `
uniform float uFront;
uniform float uFail;
uniform float uWarn;
uniform float uMoving;
uniform float uTime;
uniform float uHatch;
uniform vec3 uRisk;
uniform vec3 uFogCol;
uniform float uFogDensity;
varying vec2 vSlide;
varying vec3 vWorld;
varying float vViewDist;
${NOISE}
void main() {
  float u = vSlide.x;
  float a = abs(vSlide.y);
  float aa = fwidth(vSlide.y) * 1.5;
  float border = smoothstep(1.0 - 2.5 * aa, 1.0 - aa, a);
  float fog = 1.0 - exp(-pow(uFogDensity * vViewDist, 2.0));
  vec3 col;
  float alpha;
  if (uFail < 0.5 || u > uFront) {
    // Not (yet) failed here: the zone that could fail, as map hatching with a crisp outline.
    float hatch = step(0.72, fract((vWorld.x + vWorld.z) / uHatch));
    alpha = max(max(border, hatch * 0.5), 0.1) * mix(0.75, 1.0, uWarn);
    col = uRisk;
    // Tension cracks at the crown, spreading downslope as the rain approaches the threshold.
    if (uFail < 0.5 && uWarn > 0.0) {
      float zone = 1.0 - smoothstep(0.04, 0.06 + 0.22 * uWarn, u);
      float jag = u * 70.0 + fbm(vec2(vSlide.y * 3.0, u * 12.0)) * 4.0;
      float crack = smoothstep(0.8, 0.96, abs(sin(jag))) * zone * step(a, 0.9);
      col = mix(col, vec3(0.16, 0.07, 0.04), crack);
      alpha = max(alpha, crack);
    }
    if (alpha < 0.02) discard;
  } else {
    // Failed: soil exposed. Scar at the crown (dark, bowl-shaded), scoured track, lumpy deposit at the toe.
    vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    float light = 0.55 + 0.5 * clamp(dot(n, normalize(vec3(-0.5, 0.85, 0.3))), 0.0, 1.0);
    float grain = fbm(vWorld.xz * 14.0);
    float scar = 1.0 - smoothstep(0.12, 0.3, u);
    float lobe = smoothstep(0.72, 0.9, u);
    // Streaks along the flow, running while the debris moves.
    float streak = fbm(vec2(vSlide.y * 5.0, u * 30.0 - uTime * 3.0 * uMoving));
    // Display colours (this material isn't colour-managed): wet dark soil in the scar, paler scoured
    // earth on the track, warm mixed debris on the deposit.
    vec3 track = mix(vec3(0.62, 0.50, 0.40), vec3(0.74, 0.63, 0.52), streak);
    vec3 scarCol = mix(vec3(0.22, 0.14, 0.09), vec3(0.42, 0.29, 0.20), a * a + 0.35 * grain);
    vec3 lobeCol = mix(vec3(0.45, 0.32, 0.22), vec3(0.62, 0.47, 0.34), grain);
    col = mix(track, scarCol, scar);
    col = mix(col, lobeCol, lobe);
    col *= light;
    // The torn crown: a dark rim around the scar's upper edge.
    float rim = scar * smoothstep(0.82, 0.95, a) + (1.0 - smoothstep(0.0, 0.03, u));
    col = mix(col, vec3(0.12, 0.07, 0.04), clamp(rim, 0.0, 1.0) * 0.8);
    // The moving front: a brighter, lumpy band with a ragged edge.
    float frontBand = uMoving * smoothstep(uFront - 0.08, uFront, u);
    col = mix(col, vec3(0.66, 0.52, 0.38) * light, frontBand * (0.5 + 0.5 * grain));
    // Risk colour only as a thin outline, so it still reads as a hazard on the map.
    col = mix(col, uRisk, border * 0.6);
    alpha = 1.0;
  }
  gl_FragColor = vec4(mix(col, uFogCol, fog), alpha);
}
`;

/**
 * Landslides on the valley map, played from the real Dec 2014 rain: the zone that could fail (hatched),
 * tension cracks as the rain approaches the slope's threshold, then the failure — a dark scar at the
 * crown, earth streaming down a scoured track and a lumpy deposit at the toe. Draped on the terrain.
 */
export function createLandslides(
  sources: SlideSource[],
  hm: Heightmap,
  frame: GeoFrame,
  fogColor: THREE.Color,
  opts: { tubeRadiusKm?: number; labelled?: number; labelText?: string; labelSpacingKm?: number } = {},
) {
  const group = new THREE.Group();
  const owned: { dispose(): void }[] = [];
  const labelEls: HTMLElement[] = [];
  const widthK = (opts.tubeRadiusKm ?? 0.07) / 0.07;
  const risk = new THREE.Color(0xd4542b);

  const groundY = (x: number, z: number) => {
    const ll = frame.worldToLngLat(new THREE.Vector3(x, 0, z));
    const { gx, gy } = gridCoords(hm, ll);
    const e = sampleField(hm, hm.elevM, gx, gy);
    return frame.lngLatToWorld(ll, Number.isFinite(e) ? Math.max(e, 0) : 0).y;
  };

  const triggerHour = (acc: number) => {
    for (let h = 0; h <= REPLAY_HOURS; h += 0.25) if (rainAccumulated(h) >= acc) return h;
    return Infinity;
  };

  /** A strip draped on the terrain: wide spoon at the crown, narrower track, rounded tongue at the toe. */
  const buildStrip = (curve: THREE.CatmullRomCurve3, lengthKm: number, scale: number) => {
    const along = Math.round(THREE.MathUtils.clamp(lengthKm / 0.04, 40, 220));
    const pos = new Float32Array(along * ACROSS * 3);
    const uv = new Float32Array(along * ACROSS * 2);
    const p = new THREE.Vector3();
    const t = new THREE.Vector3();
    for (let i = 0; i < along; i++) {
      const u = i / (along - 1);
      curve.getPointAt(u, p);
      curve.getTangentAt(u, t).setY(0).normalize();
      const head = Math.sqrt(THREE.MathUtils.clamp(u / 0.05, 0, 1)); // rounded crown
      const toe = u > 0.88 ? Math.sqrt(Math.max(0, 1 - ((u - 0.88) / 0.12) ** 2)) : 1; // rounded tongue
      // Widest at the crown, tapering down the track, a modest fan where the debris spreads out.
      const spoon = THREE.MathUtils.lerp(0.13, 0.055, THREE.MathUtils.smoothstep(u, 0.06, 0.35));
      const fan = 0.035 * THREE.MathUtils.smoothstep(u, 0.72, 0.92);
      const hw = Math.max(0.004, (spoon + fan) * head * toe) * widthK * scale;
      for (let j = 0; j < ACROSS; j++) {
        const a = (j / (ACROSS - 1)) * 2 - 1;
        const x = p.x - t.z * a * hw;
        const z = p.z + t.x * a * hw;
        const k = i * ACROSS + j;
        pos.set([x, groundY(x, z), z], k * 3);
        uv.set([u, a], k * 2);
      }
    }
    const index: number[] = [];
    for (let i = 0; i < along - 1; i++) {
      for (let j = 0; j < ACROSS - 1; j++) {
        const a = i * ACROSS + j;
        index.push(a, a + 1, a + ACROSS, a + 1, a + ACROSS + 1, a + ACROSS);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSlide', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(index);
    owned.push(geo);
    return geo;
  };

  // Dust where a slope fails: a soft soil-coloured cloud that billows up and fades.
  const plumeTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    grad.addColorStop(0, 'rgba(150,120,95,0.5)');
    grad.addColorStop(0.6, 'rgba(150,120,95,0.16)');
    grad.addColorStop(1, 'rgba(150,120,95,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  })();
  owned.push(plumeTex);

  const labelledAt: THREE.Vector3[] = [];
  const labelObjs: CSS2DObject[] = [];
  const slides = sources.map((s) => {
    const pts = s.path.map((cell) => {
      const r = Math.floor(cell / hm.cols);
      return frame.lngLatToWorld(cellLngLat(hm, cell - r * hm.cols, r), Math.max(hm.elevM[cell], 0));
    });
    if (pts.length === 1) pts.push(pts[0].clone().add(new THREE.Vector3(0.05, 0, 0.05)));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const lengthKm = Math.max(0.2, curve.getLength());
    const geos = SCALES.map((sc) => buildStrip(curve, lengthKm, sc));
    const mat = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      // The strip samples the heightmap smoothly while the terrain is flat triangles ~0.4 km apart:
      // lift it and pull it forward in depth so it never sinks into a convex hillside.
      polygonOffsetFactor: -8,
      polygonOffsetUnits: -60,
      uniforms: {
        uFront: { value: 0 },
        uFail: { value: 0 },
        uWarn: { value: 0 },
        uMoving: { value: 0 },
        uTime: { value: 0 },
        uLift: { value: 0.02 },
        uHatch: { value: 0.06 },
        uRisk: { value: risk },
        uFogCol: { value: fogColor },
        uFogDensity: FOG,
      },
    });
    owned.push(mat);
    const mesh = new THREE.Mesh(geos[0], mat);
    mesh.renderOrder = 2;
    group.add(mesh);

    const crown = pts[0].clone();
    const anchor = new THREE.Object3D();
    anchor.position.copy(crown);
    group.add(anchor);
    const spaced = labelledAt.every((p) => p.distanceTo(crown) > (opts.labelSpacingKm ?? 0));
    if (labelledAt.length < (opts.labelled ?? 0) && spaced) {
      labelledAt.push(crown);
      const el = document.createElement('div');
      el.className = 'slide-label';
      el.textContent = opts.labelText ?? 'Landslide risk';
      labelEls.push(el);
      const label = new CSS2DObject(el);
      label.center.set(0.5, 1.3);
      label.position.y = 0.3;
      anchor.add(label);
      labelObjs.push(label);
    }
    const plumeMat = new THREE.SpriteMaterial({ map: plumeTex, transparent: true, depthWrite: false, opacity: 0 });
    owned.push(plumeMat);
    const plume = new THREE.Sprite(plumeMat);
    plume.visible = false;
    group.add(plume);
    return { source: s, curve, mesh, mat, geos, crown, plume, plumeMat, start: triggerHour(s.triggerRainAcc), failedAt: -1 };
  });

  const tmp = new THREE.Vector3();
  return {
    group,
    sources,
    update(hour: number, cameraDistance: number, timeS: number) {
      // Wider strips and coarser hatching from far away, so slopes stay readable at state scale.
      const want = THREE.MathUtils.clamp(cameraDistance / 18, 1, 8);
      const si = SCALES.reduce((best, s, i) => (Math.abs(Math.log2(s / want)) < Math.abs(Math.log2(SCALES[best] / want)) ? i : best), 0);
      let active = 0;
      for (const sl of slides) {
        const failed = hour >= sl.start;
        if (!failed) sl.failedAt = -1;
        else if (sl.failedAt < 0) sl.failedAt = timeS;
        if (failed) active++;
        const t = failed ? THREE.MathUtils.clamp((timeS - sl.failedAt) / SURGE_SECONDS, 0, 1) : 0;
        const front = failed ? 1 - Math.pow(1 - t, 2.4) : 0;
        const ratio = rainAccumulated(hour) / Math.max(1e-6, sl.source.triggerRainAcc);
        const u = sl.mat.uniforms;
        u.uFail.value = failed ? 1 : 0;
        u.uFront.value = front;
        u.uMoving.value = failed && t < 1 ? 1 : 0;
        u.uWarn.value = THREE.MathUtils.clamp((ratio - WARN_FROM) / (1 - WARN_FROM), 0, 1);
        u.uTime.value = timeS;
        u.uLift.value = 0.05 * SCALES[si];
        u.uHatch.value = 0.06 * SCALES[si];
        if (sl.mesh.geometry !== sl.geos[si]) sl.mesh.geometry = sl.geos[si];
        // Dust at the moving front.
        sl.plume.visible = failed && t < 1.4;
        if (sl.plume.visible) {
          const k = Math.min(1, t);
          sl.curve.getPointAt(Math.min(1, front), tmp);
          sl.plume.position.set(tmp.x, tmp.y + 0.15 * SCALES[si], tmp.z);
          sl.plume.scale.setScalar(0.5 * SCALES[si] * (1 + 1.5 * k));
          sl.plumeMat.opacity = 0.75 * (1 - Math.max(0, t - 0.4) / 1.0);
        }
      }
      for (const el of labelEls) el.classList.toggle('active', active > 0);
      return { active, total: slides.length };
    },
    setLabelsVisible(v: boolean) {
      for (const l of labelObjs) l.visible = v;
    },
    setVisible(v: boolean) {
      group.visible = v;
    },
    dispose() {
      owned.forEach((o) => o.dispose());
      labelEls.forEach((el) => el.remove());
    },
  };
}
