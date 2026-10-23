import * as THREE from 'three';
import type { GeoFrame } from '../geo/region';
import { cellLngLat, type Heightmap } from '../terrain/heightmap';
import type { Hydrology } from '../terrain/hydrology';
import type { Focus } from './valley';

/** Vertical scale of the water rise relative to the terrain exaggeration (1 = true to the model). */
export const LEVEL_EXAG = 1;
const STEP = 1; // full grid: rivers are one cell wide

const vertexShader = /* glsl */ `
attribute float aElev;
attribute float aFill;
attribute float aDrain;
attribute float aScale;
attribute float aSea;
uniform float uStage;
uniform float uExag;
uniform float uLevelExag;
varying float vDepth;
varying float vSea;
varying vec3 vWorld;
varying float vViewDist;

void main() {
  float rise = uStage * aScale;
  vDepth = aDrain + rise - aFill;
  vSea = aSea;
  float shownM = aSea > 0.5 ? 0.0 : (vDepth > 0.0 ? aDrain + rise * uLevelExag + 0.5 : aElev - 8.0);
  vec4 world = modelMatrix * vec4(position.x, shownM * uExag * 0.001, position.z, 1.0);
  vWorld = world.xyz;
  vec4 mv = viewMatrix * world;
  vViewDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uSunDir;
uniform float uTime;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uSeaCol;
uniform vec3 uFogCol;
uniform float uFogDensity;
uniform vec3 uFocus;
uniform float uFocusR;
uniform float uFocusOn;
varying float vDepth;
varying float vSea;
varying vec3 vWorld;
varying float vViewDist;

void main() {
  if (vDepth <= 0.0 && vSea < 0.5) discard;
  vec2 q = vWorld.xz * 3.0;
  vec3 n = normalize(vec3(
    sin(q.x * 1.7 + uTime * 1.3) * 0.05 + sin(q.y * 2.9 - uTime * 0.8) * 0.03,
    1.0,
    cos(q.y * 1.9 + uTime * 1.1) * 0.05 + cos(q.x * 2.3 + uTime * 0.7) * 0.03));
  vec3 viewDir = normalize(cameraPosition - vWorld);
  float spec = pow(max(dot(reflect(-uSunDir, n), viewDir), 0.0), 120.0);
  float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0);
  vec3 col;
  float alpha;
  if (vSea > 0.5) {
    col = uSeaCol + spec * 0.2;
    alpha = 0.92;
  } else {
    float t = 1.0 - exp(-vDepth / 3.0);
    col = mix(uShallow * 0.8, uDeep, 0.35 + 0.65 * t);
    col += fres * 0.18 * uShallow + spec * 0.8;
    alpha = 0.55 + 0.35 * smoothstep(0.0, 1.5, vDepth);
  }
  float inFocus = 1.0 - smoothstep(uFocusR, uFocusR * 2.2, length(vWorld.xz - uFocus.xz));
  col *= mix(1.0, mix(0.4, 1.0, inFocus), uFocusOn);
  float fog = 1.0 - exp(-pow(uFogDensity * vViewDist, 2.0));
  gl_FragColor = vec4(mix(col, uFogCol, fog), alpha);
}
`;

/** Flood element: a separate transparent water sheet that rises and spreads with the river stage. */
export function createFlood(hm: Heightmap, hy: Hydrology, frame: GeoFrame, fogColor: THREE.Color) {
  const cols = Math.floor((hm.cols - 1) / STEP) + 1;
  const rows = Math.floor((hm.rows - 1) / STEP) + 1;
  const n = cols * rows;
  const pos = new Float32Array(n * 3);
  const fields = { aElev: hm.elevM, aFill: hy.filledM, aDrain: hy.drainElevM, aScale: hy.stageScale, aSea: hy.seaMask };
  const attrs = Object.fromEntries(Object.keys(fields).map((k) => [k, new Float32Array(n)])) as Record<keyof typeof fields, Float32Array>;
  const v = new THREE.Vector3();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const j = r * cols + c;
      const i = r * STEP * hm.cols + c * STEP;
      frame.lngLatToWorld(cellLngLat(hm, c * STEP, r * STEP), 0, v);
      pos[j * 3] = v.x;
      pos[j * 3 + 2] = v.z;
      for (const k of Object.keys(fields) as (keyof typeof fields)[]) attrs[k][j] = fields[k][i];
    }
  }
  const index = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let k = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      index.set([a, a + cols, a + 1, a + 1, a + cols, a + cols + 1], k);
      k += 6;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  for (const [name, arr] of Object.entries(attrs)) geometry.setAttribute(name, new THREE.BufferAttribute(arr, 1));

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    uniforms: {
      uStage: { value: 0 },
      uExag: { value: frame.exag },
      uLevelExag: { value: LEVEL_EXAG },
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(-0.55, 0.75, -0.4).normalize() },
      uShallow: { value: new THREE.Color(0x6ff3ff) },
      uDeep: { value: new THREE.Color(0x0a47c9) },
      uSeaCol: { value: new THREE.Color(0x0b1622) },
      uFogCol: { value: fogColor },
      uFogDensity: { value: 0.0065 },
      uFocus: { value: new THREE.Vector3() },
      uFocusR: { value: 6 },
      uFocusOn: { value: 0 },
    },
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;

  return {
    mesh,
    update(stageM: number, timeS: number, focus: Focus) {
      const u = material.uniforms;
      u.uStage.value = stageM;
      u.uTime.value = timeS;
      u.uFocus.value.copy(focus.centre);
      u.uFocusR.value = focus.radiusKm;
      u.uFocusOn.value = focus.amount;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
