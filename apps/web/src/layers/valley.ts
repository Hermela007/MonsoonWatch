import * as THREE from 'three';
import type { GeoFrame } from '../geo/region';
import { cellLngLat, type Heightmap } from '../terrain/heightmap';
import type { Hydrology } from '../terrain/hydrology';

const vertexShader = /* glsl */ `
attribute float aElev;
attribute float aSlope;
attribute float aRiver;
attribute float aRiverFlag;
uniform float uExag;
varying float vElev;
varying float vSlope;
varying float vRiver;
varying float vRiverFlag;
varying vec3 vNormalW;
varying vec3 vWorld;
varying float vViewDist;

void main() {
  vec4 world = modelMatrix * vec4(position.x, max(aElev, 0.0) * uExag * 0.001, position.z, 1.0);
  vWorld = world.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vElev = aElev;
  vSlope = aSlope;
  vRiver = aRiver;
  vRiverFlag = aRiverFlag;
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
uniform vec3 uRiskCol;
uniform vec3 uRiverCol;
uniform vec3 uFogCol;
uniform float uFogDensity;
uniform vec3 uFocus;
uniform float uFocusR;
uniform float uFocusOn;
varying float vElev;
varying float vSlope;
varying float vRiver;
varying float vRiverFlag;
varying vec3 vNormalW;
varying vec3 vWorld;
varying float vViewDist;

void main() {
  vec3 n = normalize(vNormalW);
  float shade = 0.12 + clamp(dot(n, uSunDir), 0.0, 1.0);
  vec3 col = mix(uLow, uHigh, smoothstep(0.0, 900.0, vElev)) * shade;

  float ce = vElev / 100.0;
  float cl = abs(fract(ce - 0.5) - 0.5) / max(fwidth(ce), 1e-4);
  col += (1.0 - min(cl, 1.0)) * (1.0 - smoothstep(20.0, 90.0, vViewDist)) * step(5.0, vElev) * 0.03;

  float line = smoothstep(0.6, 0.95, vRiverFlag);
  col = mix(col, uRiverCol * (0.6 + 0.4 * shade), line * (0.35 + 0.4 * vRiver));

  // Spotlight on the chosen home; everything else recedes.
  float inFocus = 1.0 - smoothstep(uFocusR, uFocusR * 2.2, length(vWorld.xz - uFocus.xz));
  float focus = mix(1.0, inFocus, uFocusOn);

  // Landslide screening tint (slope x accumulated rain), only around the home.
  float risk = smoothstep(18.0, 35.0, vSlope) * smoothstep(0.15, 0.9, uRainAcc) * step(40.0, vElev);
  float pulse = 0.8 + 0.2 * sin(uTime * 2.4 - vWorld.z * 0.5);
  col = mix(col, uRiskCol * (0.5 + 0.5 * shade) * pulse, risk * 0.6 * inFocus * uFocusOn);

  col *= mix(0.32, 1.0, focus);
  float fog = 1.0 - exp(-pow(uFogDensity * vViewDist, 2.0));
  gl_FragColor = vec4(mix(col, uFogCol, fog), 1.0);
}
`;

const color = (hex: number) => new THREE.Color(hex);

export interface Focus {
  centre: THREE.Vector3;
  radiusKm: number;
  /** 0 = whole valley lit, 1 = spotlight on the home. */
  amount: number;
}

/** Terrain: hillshade, rivers, and a spotlight around the resident's home. */
export function createValley(hm: Heightmap, hy: Hydrology, frame: GeoFrame, fogColor: THREE.Color) {
  const { cols, rows } = hm;
  const n = cols * rows;
  const pos = new Float32Array(n * 3);
  const v = new THREE.Vector3();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      frame.lngLatToWorld(cellLngLat(hm, c, r), Math.max(hm.elevM[i], 0), v);
      pos.set([v.x, v.y, v.z], i * 3);
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
  geometry.computeVertexNormals();
  geometry.setAttribute('aElev', new THREE.BufferAttribute(hm.elevM, 1));
  geometry.setAttribute('aSlope', new THREE.BufferAttribute(hy.slopeDeg, 1));
  geometry.setAttribute('aRiver', new THREE.BufferAttribute(hy.riverStrength, 1));
  geometry.setAttribute('aRiverFlag', new THREE.BufferAttribute(Float32Array.from(hy.riverMask), 1));

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uExag: { value: frame.exag },
      uRainAcc: { value: 0 },
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(-0.55, 0.75, -0.4).normalize() },
      uLow: { value: color(0x28343f) },
      uHigh: { value: color(0x4c5866) },
      uRiskCol: { value: color(0xff4326) },
      uRiverCol: { value: color(0x2f8fe8) },
      uFogCol: { value: fogColor },
      uFogDensity: { value: 0.0065 },
      uFocus: { value: new THREE.Vector3() },
      uFocusR: { value: 6 },
      uFocusOn: { value: 0 },
    },
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;

  return {
    mesh,
    update(rainAcc: number, timeS: number, focus: Focus) {
      const u = material.uniforms;
      u.uRainAcc.value = rainAcc;
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
