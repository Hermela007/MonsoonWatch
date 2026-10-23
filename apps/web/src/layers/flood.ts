import * as THREE from 'three';
import type { GeoFrame } from '../geo/region';
import { cellLngLat, type Heightmap } from '../terrain/heightmap';
import { NO_DRAIN_M, type Hydrology } from '../terrain/hydrology';
import type { Focus } from './valley';

const vertexShader = /* glsl */ `
uniform sampler2D uField; // r: filled elev (m), g: HAND (m), b: stage scale, a: sea
uniform float uStage;
uniform float uExag;
varying vec2 vUv;
varying vec3 vWorld;
varying float vViewDist;

void main() {
  vUv = uv;
  vec4 f = texture2D(uField, uv);
  float surf = f.r - f.g + uStage * f.b;
  float y = f.a > 0.5 ? 0.0 : max(f.r, surf);
  vec4 world = modelMatrix * vec4(position.x, y * uExag * 0.001, position.z, 1.0);
  vWorld = world.xyz;
  vec4 mv = viewMatrix * world;
  vViewDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D uField;
uniform vec3 uSunDir;
uniform float uTime;
uniform float uStage;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uSeaCol;
uniform vec3 uFogCol;
uniform float uFogDensity;
uniform vec3 uFocus;
uniform float uFocusR;
uniform float uFocusOn;
varying vec2 vUv;
varying vec3 vWorld;
varying float vViewDist;

void main() {
  // Depth per pixel from bilinearly filtered fields → smooth shorelines instead of grid stairs.
  vec4 f = texture2D(uField, vUv);
  float sea = f.a;
  float depth = uStage * f.b - f.g;
  float aa = max(fwidth(depth), 1e-3);
  float cover = sea > 0.5 ? 1.0 : smoothstep(-aa, aa, depth);
  if (cover < 0.01) discard;

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
  if (sea > 0.5) {
    col = uSeaCol + spec * 0.15;
    alpha = 1.0;
  } else {
    float t = 1.0 - exp(-max(depth, 0.0) / 3.0);
    col = mix(uShallow, uDeep, t) + fres * 0.1 + spec * 0.4;
    alpha = (0.72 + 0.23 * smoothstep(0.0, 1.5, depth)) * cover;
  }
  float inFocus = 1.0 - smoothstep(uFocusR, uFocusR * 2.2, length(vWorld.xz - uFocus.xz));
  col = mix(col, uFogCol, (1.0 - inFocus) * uFocusOn * 0.45);
  float fog = 1.0 - exp(-pow(uFogDensity * vViewDist, 2.0));
  gl_FragColor = vec4(mix(col, uFogCol, fog), alpha);
}
`;

/** Separable box blur, `passes` times (≈ Gaussian). Cells where `skip` is set keep their value. */
function blur(src: Float32Array, cols: number, rows: number, radius: number, passes: number, skip?: Uint8Array) {
  let a = Float32Array.from(src);
  let b = new Float32Array(a.length);
  const w = 2 * radius + 1;
  for (let p = 0; p < passes; p++) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += a[r * cols + Math.min(cols - 1, Math.max(0, c + k))];
        b[r * cols + c] = sum / w;
      }
    }
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += b[Math.min(rows - 1, Math.max(0, r + k)) * cols + c];
        a[r * cols + c] = sum / w;
      }
    }
  }
  if (skip) for (let i = 0; i < a.length; i++) if (skip[i]) a[i] = src[i];
  return a;
}

/**
 * Half-float RGBA field texture (filterable in WebGL2). Row 0 of the texture = southern edge.
 * HAND and stage scale are smoothed so flood edges follow organic contours, not 150 m cells.
 */
function fieldTexture(hm: Heightmap, hy: Hydrology) {
  const { cols, rows } = hm;
  const n = cols * rows;
  const handRaw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const drain = hy.drainElevM[i];
    handRaw[i] = hy.seaMask[i] ? 0 : drain === NO_DRAIN_M ? 60 : Math.min(60, Math.max(0, hy.filledM[i] - drain));
  }
  const hand = blur(handRaw, cols, rows, 1, 3);
  const scale = blur(hy.stageScale, cols, rows, 1, 3);
  const data = new Uint16Array(n * 4);
  const h = THREE.DataUtils.toHalfFloat;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const o = ((rows - 1 - r) * cols + c) * 4;
      data[o] = h(Math.max(hy.filledM[i], 0));
      data[o + 1] = h(hy.seaMask[i] ? 0 : hand[i]);
      data[o + 2] = h(scale[i]);
      data[o + 3] = h(hy.seaMask[i]);
    }
  }
  const tex = new THREE.DataTexture(data, cols, rows, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Flood element: a transparent water sheet that rises and spreads with the river stage. */
export function createFlood(hm: Heightmap, hy: Hydrology, frame: GeoFrame, fogColor: THREE.Color) {
  const { cols, rows } = hm;
  const n = cols * rows;
  const pos = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const v = new THREE.Vector3();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const j = r * cols + c;
      frame.lngLatToWorld(cellLngLat(hm, c, r), 0, v);
      pos[j * 3] = v.x;
      pos[j * 3 + 2] = v.z;
      uv.set([(c + 0.5) / cols, (rows - 1 - r + 0.5) / rows], j * 2);
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
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));

  const field = fieldTexture(hm, hy);
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    // Near the shore the sheet lies on the ground; pull it forward to avoid z-fighting.
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
    uniforms: {
      uField: { value: field },
      uStage: { value: 0 },
      uExag: { value: frame.exag },
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(-0.55, 0.75, -0.4).normalize() },
      uShallow: { value: new THREE.Color(0xc9b386) },
      uDeep: { value: new THREE.Color(0x8a6f48) },
      uSeaCol: { value: new THREE.Color(0xa9c6bf) },
      uFogCol: { value: fogColor },
      uFogDensity: { value: 0.0022 },
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
      field.dispose();
    },
  };
}
