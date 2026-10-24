import * as THREE from 'three';
import { FOG, THEME } from '../theme';
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
attribute vec2 aMaskUv;  // position in the state-boundary mask (same mapping as the terrain)
varying vec2 vMaskUv;
uniform float uFront;
uniform float uFail;
uniform float uLift;
uniform float uPit;      // 1 for the visible surface (sunk into a hollow), 0 for the stencil lid
uniform float uDepth;    // scar depth (world km)
varying vec2 vSlide;
varying float vPit;
varying vec3 vWorld;
varying float vViewDist;
${NOISE}
void main() {
  vSlide = aSlide;
  vMaskUv = aMaskUv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  // The deposit stands proud of the slope: a lumpy lobe at the toe once the debris has arrived.
  float across = 1.0 - aSlide.y * aSlide.y;
  float lobe = smoothstep(0.7, 0.95, aSlide.x) * smoothstep(0.75, 1.0, uFront) * uFail;
  float lumps = 0.6 + 0.8 * fbm(w.xz * 9.0);
  w.y += uLift * (1.0 + 1.6 * lobe * across * lumps);
  // Concave: a deep spoon-shaped hollow at the crown and a shallow channel down the track, opening as the
  // material leaves. Drawn through a hole in the terrain (stencil), so the rim and nearer ground hide it.
  float passed = 1.0 - smoothstep(uFront - 0.05, uFront + 0.01, aSlide.x);
  float scar = smoothstep(0.0, 0.035, aSlide.x) * (1.0 - smoothstep(0.16, 0.34, aSlide.x)) * pow(across, 0.7);
  float channel = 0.28 * smoothstep(0.18, 0.32, aSlide.x) * (1.0 - smoothstep(0.7, 0.86, aSlide.x)) * pow(across, 0.9);
  // Always a hollow (slides start in concave hollows on hillsides); it deepens where the slope has failed.
  vPit = max(scar, channel) * mix(0.6, 1.0, passed * uFail);
  w.y -= uPit * uDepth * vPit;
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
uniform vec3 uRisk;
uniform vec3 uPaper;
uniform vec3 uLine;
uniform vec3 uLineStrong;
uniform vec3 uSunDir;
uniform float uElevScale; // world units per metre of elevation
uniform vec3 uFogCol;
uniform float uFogDensity;
uniform sampler2D uMask;
varying vec2 vMaskUv;
varying vec2 vSlide;
varying vec3 vWorld;
varying float vViewDist;
varying float vPit;
${NOISE}
// Same hairline grid as the terrain, so it carries on into the hollow and bends down with it.
float gridLine(vec2 p, float period, float w) {
  vec2 c = p / period;
  vec2 g = abs(fract(c - 0.5) - 0.5) / max(fwidth(c), vec2(1e-4));
  return 1.0 - min(min(g.x, g.y) / w, 1.0);
}
void main() {
  // The model is Kelantan only: no ground is drawn beyond the border, so nothing to slide on there.
  if (texture2D(uMask, vMaskUv).r < 0.5) discard;
  float u = vSlide.x;
  float a = abs(vSlide.y);
  float fog = 1.0 - exp(-pow(uFogDensity * vViewDist, 2.0));
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  n *= sign(n.y + 1e-5); // the screen-derivative normal can point down; the ground always faces up
  float diff = clamp(dot(n, uSunDir), 0.0, 1.0);
  float failed = uFail * step(u, uFront);
  vec3 ground = uPaper * (0.6 + 0.48 * diff); // the terrain's own shading
  // Dirt: churned soil, not paint. Earth-coloured ombre down the slide (wet dark red-brown at the
  // crown, terracotta down the track, dry ochre where the debris stops), with grain at several scales,
  // clods and stones, and scour marks running downhill. (Linear colours: the output pass converts to sRGB.)
  vec3 earth = mix(vec3(0.17, 0.055, 0.025), vec3(0.34, 0.12, 0.045), smoothstep(0.05, 0.5, u));
  earth = mix(earth, vec3(0.46, 0.27, 0.09), smoothstep(0.55, 0.98, u));
  vec2 p = vWorld.xz;
  float grainA = fbm(p * 45.0);                 // patches of wetter / drier soil (~20 m)
  float grainB = noise(p * 220.0);              // fine crumb
  float clods = smoothstep(0.66, 0.8, noise(p * 120.0 + 7.3));   // lumps of earth
  float stones = smoothstep(0.78, 0.86, noise(p * 300.0 + 2.1)); // scattered rock
  float scour = fbm(vec2(vSlide.y * 7.0, u * 55.0 - uTime * 2.5 * uMoving)); // downhill streaks
  vec3 dirt = earth * (0.62 + 0.62 * grainA) * (0.85 + 0.3 * grainB);
  dirt *= 0.78 + 0.32 * scour;
  dirt = mix(dirt, dirt * 0.55, clods * 0.7);                     // shadowed clods
  dirt = mix(dirt, vec3(0.33, 0.31, 0.28), stones * 0.75);        // grey stones
  dirt *= 0.42 + 0.78 * diff;                                     // lit like the hillside
  // Ragged edges: soil frays into the hillside instead of ending in a clean ribbon outline.
  float ragged = smoothstep(1.0, 0.62, a + (grainA - 0.5) * 0.55 + (grainB - 0.5) * 0.15)
    * smoothstep(0.0, 0.03, u) * smoothstep(1.0, 0.88, u + (grainA - 0.5) * 0.08);
  vec3 col;
  if (failed < 0.5) {
    // At risk: the slope is already scarred and wet; the soil shows more as the rain builds.
    col = mix(ground, dirt, ragged * (0.9 + 0.1 * uWarn));
    // Tension cracks at the crown, spreading downslope as the rain nears the threshold.
    if (uFail < 0.5 && uWarn > 0.0) {
      float zone = 1.0 - smoothstep(0.03, 0.05 + 0.2 * uWarn, u);
      float jag = u * 90.0 + fbm(vec2(vSlide.y * 3.0, u * 12.0)) * 5.0;
      float crack = smoothstep(0.9, 0.98, abs(sin(jag))) * zone * step(a, 0.85);
      col = mix(col, vec3(0.05, 0.025, 0.015), crack * 0.9);
    }
  } else {
    // Failed: freshly exposed, darker and wetter in the scar; a lumpy front while the debris moves.
    float scar = 1.0 - smoothstep(0.1, 0.3, u);
    vec3 fresh = mix(dirt, dirt * 0.62, scar);
    float frontBand = uMoving * smoothstep(uFront - 0.06, uFront, u);
    fresh = mix(fresh, fresh * 1.25 + vec3(0.02, 0.012, 0.006), frontBand * (0.4 + 0.6 * clods));
    col = mix(ground, fresh, ragged);
  }
  // Ambient occlusion: less sky reaches the floor of the hollow.
  col *= 1.0 - 0.28 * smoothstep(0.15, 1.0, vPit);
  // The crown: one fine line where the ground would tear (or has torn) away.
  float crownLine = (1.0 - smoothstep(0.0, fwidth(u) * 1.5, abs(u - 0.012))) * step(a, 0.95);
  col = mix(col, uLineStrong * 0.7, crownLine * mix(0.55, 0.9, max(uWarn, failed)));
  // Grid and 50 m contours continue into the hollow: they bend down with it, which is what reads as concave.
  float fadeG = 1.0 - smoothstep(60.0, 260.0, vViewDist);
  float onSoil = 1.0 - 0.6 * smoothstep(0.2, 0.8, ragged);
  col = mix(col, uLine, gridLine(vWorld.xz, 0.1, 0.6) * 0.16 * onSoil * (1.0 - smoothstep(3.0, 14.0, vViewDist)));
  col = mix(col, uLine, gridLine(vWorld.xz, 0.25, 0.7) * 0.26 * onSoil * (1.0 - smoothstep(8.0, 45.0, vViewDist)));
  col = mix(col, uLine, gridLine(vWorld.xz, 1.0, 0.8) * 0.45 * onSoil * fadeG);
  float ce = vWorld.y / (uElevScale * 50.0);
  float cl = abs(fract(ce - 0.5) - 0.5) / max(fwidth(ce), 1e-4);
  col = mix(col, uLineStrong * 0.5, (1.0 - min(cl / 0.7, 1.0)) * 0.3 * ragged * (1.0 - smoothstep(10.0, 60.0, vViewDist)));
  gl_FragColor = vec4(mix(col, uFogCol, fog), 1.0);
}
`;

/** Smooth 1D value noise in [0, 1] (deterministic), for natural outlines. */
function valueNoise(x: number) {
  const i = Math.floor(x);
  const f = x - i;
  const h = (n: number) => {
    const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return v - Math.floor(v);
  };
  const w = f * f * (3 - 2 * f);
  return h(i) * (1 - w) + h(i + 1) * w;
}

/**
 * The modelled runout steps cell to cell (~0.4 km), which reads as a wiggly line. Keep every other point
 * and round the corners (Chaikin) so the slide follows the slope as one smooth sweep.
 */
function smoothPath(pts: THREE.Vector3[]) {
  let p = pts.filter((_, i) => i % 2 === 0 || i === pts.length - 1);
  if (p.length < 3) return pts;
  for (let it = 0; it < 3; it++) {
    const out = [p[0]];
    for (let i = 0; i < p.length - 1; i++) {
      out.push(p[i].clone().lerp(p[i + 1], 0.25), p[i].clone().lerp(p[i + 1], 0.75));
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}

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
  opts: { mask: THREE.Texture; tubeRadiusKm?: number; labelled?: number; labelText?: string; labelSpacingKm?: number },
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
  const buildStrip = (curve: THREE.CatmullRomCurve3, lengthKm: number, scale: number, seed: number) => {
    const along = Math.round(THREE.MathUtils.clamp(lengthKm / 0.04, 40, 220));
    const pos = new Float32Array(along * ACROSS * 3);
    const uv = new Float32Array(along * ACROSS * 2);
    const maskUv = new Float32Array(along * ACROSS * 2);
    const [minLon, minLat, maxLon, maxLat] = hm.bbox;
    const p = new THREE.Vector3();
    const t = new THREE.Vector3();
    for (let i = 0; i < along; i++) {
      const u = i / (along - 1);
      curve.getPointAt(u, p);
      curve.getTangentAt(u, t).setY(0).normalize();
      // Natural outline: a blunt, angular crown that opens at once, sides that wander, a track that
      // narrows unevenly and runs out to nothing — no rounded ends.
      const head = THREE.MathUtils.smoothstep(u, 0, 0.012);
      const taper = 1 - 0.9 * THREE.MathUtils.smoothstep(u, 0.55, 1);
      const body = THREE.MathUtils.lerp(0.16, 0.08, THREE.MathUtils.smoothstep(u, 0.05, 0.4));
      const wobble = 0.78 + 0.44 * valueNoise(u * lengthKm * 2.2 + seed);
      const lean = (valueNoise(u * lengthKm * 1.3 + seed * 1.7) - 0.5) * 0.5; // the hollow sits a little off-centre
      const hw = Math.max(0.004, body * head * taper * wobble) * widthK * scale;
      for (let j = 0; j < ACROSS; j++) {
        const a = (j / (ACROSS - 1)) * 2 - 1;
        // Each side wanders on its own.
        const side = a < 0 ? 0.85 + 0.3 * valueNoise(u * lengthKm * 3.1 + seed * 2.3) : 0.85 + 0.3 * valueNoise(u * lengthKm * 2.7 + seed * 3.1);
        const off = (a * side + lean * (1 - a * a)) * hw;
        const x = p.x - t.z * off;
        const z = p.z + t.x * off;
        const k = i * ACROSS + j;
        pos.set([x, groundY(x, z), z], k * 3);
        uv.set([u, a], k * 2);
        const [lon, lat] = frame.worldToLngLat({ x, z });
        maskUv.set([(lon - minLon) / (maxLon - minLon), (lat - minLat) / (maxLat - minLat)], k * 2);
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
    geo.setAttribute('aMaskUv', new THREE.BufferAttribute(maskUv, 2));
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
  const slides = sources.map((s, si) => {
    const raw = s.path.map((cell) => {
      const r = Math.floor(cell / hm.cols);
      return frame.lngLatToWorld(cellLngLat(hm, cell - r * hm.cols, r), Math.max(hm.elevM[cell], 0));
    });
    if (raw.length === 1) raw.push(raw[0].clone().add(new THREE.Vector3(0.05, 0, 0.05)));
    const pts = smoothPath(raw);
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const lengthKm = Math.max(0.2, curve.getLength());
    const geos = SCALES.map((sc) => buildStrip(curve, lengthKm, sc, s.cell % 997));
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
        uPit: { value: 1 },
        uDepth: { value: 0.07 },
        uRisk: { value: risk },
        uPaper: { value: THEME.paper },
        uLine: { value: THEME.line },
        uLineStrong: { value: THEME.lineStrong },
        uSunDir: { value: new THREE.Vector3(-0.55, 0.75, -0.4).normalize() },
        uElevScale: { value: frame.elevToY(1) },
        uFogCol: { value: fogColor },
        uFogDensity: FOG,
        uMask: { value: opts.mask },
      },
    });
    owned.push(mat);
    mat.depthTest = false;
    mat.stencilWrite = true;
    mat.stencilFunc = THREE.EqualStencilFunc;
    mat.stencilZPass = THREE.KeepStencilOp;
    const mesh = new THREE.Mesh(geos[0], mat);
    mesh.renderOrder = 4;
    group.add(mesh);
    // The lid: the slide's footprint at the surface, invisible, marking (stencil) where its ground is
    // visible. Once the slope fails the sunken surface is drawn only there, without a depth test, so it
    // reads as a hollow cut into the hillside.
    const stencilRef = (si % 254) + 1;
    mat.stencilRef = stencilRef;
    const lidMat = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: 'uniform sampler2D uMask; varying vec2 vMaskUv; void main() { if (texture2D(uMask, vMaskUv).r < 0.5) discard; gl_FragColor = vec4(0.0); }',
      transparent: true,
      colorWrite: false,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -8,
      polygonOffsetUnits: -60,
      stencilWrite: true,
      stencilRef,
      stencilFunc: THREE.AlwaysStencilFunc,
      stencilZPass: THREE.ReplaceStencilOp,
      uniforms: { uFront: mat.uniforms.uFront, uFail: mat.uniforms.uFail, uLift: mat.uniforms.uLift, uPit: { value: 0 }, uDepth: mat.uniforms.uDepth, uMask: mat.uniforms.uMask },
    });
    owned.push(lidMat);
    const lid = new THREE.Mesh(geos[0], lidMat);
    lid.renderOrder = 3;
    lid.visible = false;
    group.add(lid);

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
    return { source: s, curve, mesh, mat, lid, stencilRef, geos, crown, plume, plumeMat, start: triggerHour(s.triggerRainAcc), failedAt: -1 };
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
        u.uDepth.value = 0.16 * widthK * SCALES[si];
        if (sl.mesh.geometry !== sl.geos[si]) sl.mesh.geometry = sl.lid.geometry = sl.geos[si];
        // Before failure: draped on the slope like any overlay. After: a hollow seen through its lid.
        // The hollow is drawn through its lid (stencil) at all times.
        sl.lid.visible = true;
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
