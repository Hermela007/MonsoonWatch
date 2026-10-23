import * as THREE from 'three';
import type { GeoFrame } from '../geo/region';
import { cellLngLat, type Heightmap } from '../terrain/heightmap';
import type { Hydrology } from '../terrain/hydrology';

export interface ValleyState {
  stageM: number;
  worstStageM: number;
  rainAcc: number;
  timeS: number;
}

const vertexShader = /* glsl */ `
attribute float aElev;
attribute float aFill;
attribute float aDrain;
attribute float aScale;
attribute float aSlope;
attribute float aRiver;
attribute float aRiverFlag;
attribute float aSea;
uniform float uStage;
uniform float uWorst;
uniform float uExag;
varying float vDepth;
varying float vWorst;
varying float vElev;
varying float vSlope;
varying float vRiver;
varying float vRiverFlag;
varying float vSea;
varying vec3 vNormalW;
varying vec3 vWorld;
varying float vViewDist;

void main() {
  vRiverFlag = aRiverFlag;
  float surf = aDrain + uStage * aScale;
  vDepth = surf - aFill;
  vWorst = aDrain + uWorst * aScale - aFill;
  float h = vDepth > 0.0 ? max(aElev, surf) : aElev;
  vec4 world = modelMatrix * vec4(position.x, h * uExag * 0.001, position.z, 1.0);
  vWorld = world.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vElev = aElev;
  vSlope = aSlope;
  vRiver = aRiver;
  vSea = aSea;
  vec4 mv = viewMatrix * world;
  vViewDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uSunDir;
uniform float uTime;
uniform float uRainAcc;
uniform vec3 uLow;
uniform vec3 uHigh;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uSeaCol;
uniform vec3 uRiskCol;
uniform vec3 uRiverCol;
uniform vec3 uFogCol;
uniform float uFogDensity;
varying float vDepth;
varying float vWorst;
varying float vElev;
varying float vSlope;
varying float vRiver;
varying float vRiverFlag;
varying float vSea;
varying vec3 vNormalW;
varying vec3 vWorld;
varying float vViewDist;

void main() {
  vec3 n = normalize(vNormalW);
  float diff = clamp(dot(n, uSunDir), 0.0, 1.0);
  float shade = 0.12 + 1.0 * diff;
  vec3 col = mix(uLow, uHigh, smoothstep(0.0, 900.0, vElev)) * shade;

  // 100 m contours, faded with distance.
  float ce = vElev / 100.0;
  float cl = abs(fract(ce - 0.5) - 0.5) / max(fwidth(ce), 1e-4);
  col += (1.0 - min(cl, 1.0)) * (1.0 - smoothstep(25.0, 120.0, vViewDist)) * step(5.0, vElev) * 0.03;

  float dry = 1.0 - step(0.0, vDepth);

  // Mapped rivers.
  // Interpolated 0/1 flag → keep only the centre of the river cell so it reads as a line.
  float line = smoothstep(0.6, 0.95, vRiverFlag);
  col = mix(col, uRiverCol * (0.6 + 0.4 * shade), line * (0.35 + 0.4 * vRiver) * dry);

  // Landslide screening: slope × accumulated rain (see hydrology.landslideRisk).
  float risk = smoothstep(18.0, 35.0, vSlope) * smoothstep(0.15, 0.9, uRainAcc) * step(40.0, vElev);
  float pulse = 0.82 + 0.18 * sin(uTime * 2.4 - vWorld.z * 0.35);
  col = mix(col, uRiskCol * (0.5 + 0.5 * shade) * pulse, risk * 0.85 * dry);

  // Worst-case extent: faint hatched tint where only the worst case is wet.
  float hatch = step(0.5, fract((vWorld.x - vWorld.z) * 2.0)) * (1.0 - smoothstep(15.0, 70.0, vViewDist));
  col = mix(col, uShallow, step(0.0, vWorst) * dry * (0.1 + 0.08 * hatch));

  if (vDepth > 0.0) {
    vec2 q = vWorld.xz * 3.0;
    vec3 wn = normalize(vec3(
      sin(q.x * 1.7 + uTime * 1.3) * 0.04 + sin(q.y * 2.9 - uTime * 0.8) * 0.02,
      1.0,
      cos(q.y * 1.9 + uTime * 1.1) * 0.04 + cos(q.x * 2.3 + uTime * 0.7) * 0.02));
    vec3 viewDir = normalize(cameraPosition - vWorld);
    float spec = pow(max(dot(reflect(-uSunDir, wn), viewDir), 0.0), 90.0);
    float fres = pow(1.0 - max(dot(wn, viewDir), 0.0), 4.0);
    if (vSea > 0.5) {
      col = mix(col, uSeaCol, 0.85) + spec * 0.15;
    } else {
      float t = 1.0 - exp(-vDepth / 2.5);
      vec3 wc = mix(uShallow * 0.75, uDeep, t);
      col = mix(col, wc, 0.55 + 0.4 * t);
      col += fres * 0.12 * uShallow + spec * 0.6;
      col += (1.0 - smoothstep(0.0, 0.5, vDepth)) * uShallow * 0.35;
    }
  }

  float fog = 1.0 - exp(-pow(uFogDensity * vViewDist, 2.0));
  gl_FragColor = vec4(mix(col, uFogCol, fog), 1.0);
}
`;

const color = (hex: number) => new THREE.Color(hex);

/** Terrain + flood + landslide screening in one mesh (one draw call). */
export function createValley(hm: Heightmap, hy: Hydrology, frame: GeoFrame, fogColor: THREE.Color) {
  const { cols, rows } = hm;
  const n = cols * rows;
  const pos = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  const sea = new Float32Array(n);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      frame.lngLatToWorld(cellLngLat(hm, c, r), Math.max(hm.elevM[i], 0), v);
      pos[i * 3] = v.x;
      pos[i * 3 + 1] = v.y;
      pos[i * 3 + 2] = v.z;
      sea[i] = hy.seaMask[i];
    }
  }
  const index = new Uint32Array((cols - 1) * (rows - 1) * 6);
  let k = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      index[k++] = a;
      index[k++] = d;
      index[k++] = b;
      index[k++] = b;
      index[k++] = d;
      index[k++] = e;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeVertexNormals();
  geometry.setAttribute('aElev', new THREE.BufferAttribute(hm.elevM, 1));
  geometry.setAttribute('aFill', new THREE.BufferAttribute(hy.filledM, 1));
  geometry.setAttribute('aDrain', new THREE.BufferAttribute(hy.drainElevM, 1));
  geometry.setAttribute('aScale', new THREE.BufferAttribute(hy.stageScale, 1));
  geometry.setAttribute('aSlope', new THREE.BufferAttribute(hy.slopeDeg, 1));
  geometry.setAttribute('aRiver', new THREE.BufferAttribute(hy.riverStrength, 1));
  geometry.setAttribute('aRiverFlag', new THREE.BufferAttribute(Float32Array.from(hy.riverMask), 1));
  geometry.setAttribute('aSea', new THREE.BufferAttribute(sea, 1));

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uStage: { value: 0 },
      uWorst: { value: 0 },
      uExag: { value: frame.exag },
      uRainAcc: { value: 0 },
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(-0.55, 0.75, -0.4).normalize() },
      uLow: { value: color(0x28343f) },
      uHigh: { value: color(0x4c5866) },
      uShallow: { value: color(0x6ff3ff) },
      uDeep: { value: color(0x0a47c9) },
      uSeaCol: { value: color(0x0b1622) },
      uRiskCol: { value: color(0xff4326) },
      uRiverCol: { value: color(0x2f8fe8) },
      uFogCol: { value: fogColor },
      uFogDensity: { value: 0.0065 },
    },
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;

  return {
    mesh,
    setState(s: ValleyState) {
      const u = material.uniforms;
      u.uStage.value = s.stageM;
      u.uWorst.value = s.worstStageM;
      u.uRainAcc.value = s.rainAcc;
      u.uTime.value = s.timeS;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
