import * as THREE from 'three';
import type { GeoFrame } from '../geo/region';
import { cellLngLat, type Heightmap } from '../terrain/heightmap';
import type { Hydrology } from '../terrain/hydrology';

const vertexShader = /* glsl */ `
attribute float aElev;
attribute float aSlope;
uniform float uExag;
varying float vElev;
varying float vSlope;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vWorld;
varying float vViewDist;

void main() {
  vec4 world = modelMatrix * vec4(position.x, max(aElev, 0.0) * uExag * 0.001, position.z, 1.0);
  vWorld = world.xyz;
  vNormalW = normalize(mat3(modelMatrix) * normal);
  vElev = aElev;
  vSlope = aSlope;
  vUv = uv;
  vec4 mv = viewMatrix * world;
  vViewDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const fragmentShader = /* glsl */ `
uniform sampler2D uImagery;
uniform float uHasImagery;
uniform sampler2D uDetail;
uniform vec4 uDetailRect; // uv rect (u0, v0, u1, v1) covered by uDetail
uniform float uDetailOn;
uniform vec3 uSunDir;
uniform float uTime;
uniform float uRainAcc;
uniform vec3 uLow;
uniform vec3 uHigh;
uniform vec3 uRiskCol;
uniform vec3 uFogCol;
uniform float uFogDensity;
uniform vec3 uFocus;
uniform float uFocusR;
uniform float uFocusOn;
varying float vElev;
varying float vSlope;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vWorld;
varying float vViewDist;

void main() {
  vec3 n = normalize(vNormalW);
  float diff = clamp(dot(n, uSunDir), 0.0, 1.0);
  // Satellite image, lifted a little (S2 forest is very dark) and hill-shaded softly.
  vec3 img = texture2D(uImagery, vUv).rgb;
  vec2 d = (vUv - uDetailRect.xy) / (uDetailRect.zw - uDetailRect.xy);
  if (uDetailOn > 0.0 && d.x > 0.0 && d.y > 0.0 && d.x < 1.0 && d.y < 1.0) {
    float edge = smoothstep(0.0, 0.08, min(min(d.x, d.y), min(1.0 - d.x, 1.0 - d.y)));
    img = mix(img, texture2D(uDetail, d).rgb, edge * uDetailOn);
  }
  img = pow(img, vec3(0.85)) * 1.15;
  vec3 hyps = mix(uLow, uHigh, smoothstep(0.0, 900.0, vElev));
  vec3 base = mix(hyps, img, uHasImagery);
  vec3 col = base * (0.4 + 0.8 * diff) * vec3(1.04, 1.0, 0.95);

  float inFocus = 1.0 - smoothstep(uFocusR, uFocusR * 2.2, length(vWorld.xz - uFocus.xz));

  // Landslide screening tint (slope x accumulated rain), only around the home.
  float risk = smoothstep(18.0, 35.0, vSlope) * smoothstep(0.15, 0.9, uRainAcc) * step(40.0, vElev);
  float pulse = 0.8 + 0.2 * sin(uTime * 2.4 - vWorld.z * 0.5);
  col = mix(col, uRiskCol * (0.6 + 0.4 * diff) * pulse, risk * 0.6 * inFocus * uFocusOn);

  // Outside the home's area: wash out towards paper instead of darkening.
  float grey = dot(col, vec3(0.299, 0.587, 0.114));
  vec3 washed = mix(vec3(grey), uFogCol, 0.55);
  col = mix(col, washed, (1.0 - inFocus) * uFocusOn * 0.85);

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

/** Terrain slab: satellite imagery on the DEM, earthy sides, spotlight around the resident's home. */
export function createValley(hm: Heightmap, hy: Hydrology, frame: GeoFrame, fogColor: THREE.Color, imagery: THREE.Texture | null) {
  const { cols, rows } = hm;
  const n = cols * rows;
  const pos = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const v = new THREE.Vector3();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      frame.lngLatToWorld(cellLngLat(hm, c, r), Math.max(hm.elevM[i], 0), v);
      pos.set([v.x, v.y, v.z], i * 3);
      uv.set([c / (cols - 1), 1 - r / (rows - 1)], i * 2);
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
  geometry.computeVertexNormals();
  geometry.setAttribute('aElev', new THREE.BufferAttribute(hm.elevM, 1));
  geometry.setAttribute('aSlope', new THREE.BufferAttribute(hy.slopeDeg, 1));

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uImagery: { value: imagery },
      uHasImagery: { value: imagery ? 1 : 0 },
      uDetail: { value: null as THREE.Texture | null },
      uDetailRect: { value: new THREE.Vector4(0, 0, 0, 0) },
      uDetailOn: { value: 0 },
      uExag: { value: frame.exag },
      uRainAcc: { value: 0 },
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(-0.55, 0.75, -0.4).normalize() },
      uLow: { value: color(0x8d9a6a) },
      uHigh: { value: color(0x5f6f45) },
      uRiskCol: { value: color(0xd9502e) },
      uFogCol: { value: fogColor },
      uFogDensity: { value: 0.0022 },
      uFocus: { value: new THREE.Vector3() },
      uFocusR: { value: 6 },
      uFocusOn: { value: 0 },
    },
  });
  const surface = new THREE.Mesh(geometry, material);
  surface.frustumCulled = false;

  // Earthy sides down to a flat base, so the valley reads as a cut-out block.
  const group = new THREE.Group();
  group.add(surface);
  const base = createSkirt(hm, frame, pos, 2.2);
  group.add(base);

  return {
    mesh: group,
    /** High-res imagery for a sub-area (uv rect in the valley texture), or null to clear. */
    setDetail(tex: THREE.Texture | null, rect?: THREE.Vector4) {
      const u = material.uniforms;
      (u.uDetail.value as THREE.Texture | null)?.dispose();
      u.uDetail.value = tex;
      if (rect) u.uDetailRect.value.copy(rect);
      u.uDetailOn.value = tex ? 1 : 0;
    },
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
      base.geometry.dispose();
      (base.material as THREE.Material).dispose();
    },
  };
}

/** Side walls + bottom: soil-coloured strata from the terrain edge down to y = -depth. */
export function createSkirt(hm: Heightmap, frame: GeoFrame, topPos: Float32Array | null, depth: number) {
  const { cols, rows } = hm;
  const ring: number[] = [];
  for (let c = 0; c < cols; c++) ring.push(c);
  for (let r = 1; r < rows; r++) ring.push(r * cols + cols - 1);
  for (let c = cols - 2; c >= 0; c--) ring.push((rows - 1) * cols + c);
  for (let r = rows - 2; r > 0; r--) ring.push(r * cols);
  ring.push(0);

  const verts: number[] = [];
  const colors: number[] = [];
  const top = new THREE.Color(0xb59a76);
  const mid = new THREE.Color(0x9a7c5a);
  const bottom = new THREE.Color(0x7c6247);
  const v = new THREE.Vector3();
  const corner = (i: number) => {
    if (topPos) return v.set(topPos[i * 3], topPos[i * 3 + 1], topPos[i * 3 + 2]);
    const r = Math.floor(i / cols);
    return frame.lngLatToWorld(cellLngLat(hm, i - r * cols, r), 0, v);
  };
  const midY = -depth * 0.35;
  const quad = (ax: number, az: number, bx: number, bz: number, aTop: number, bTop: number, yBot: number, cTop: THREE.Color, cBot: THREE.Color) => {
    verts.push(ax, aTop, az, ax, yBot, az, bx, bTop, bz, bx, bTop, bz, ax, yBot, az, bx, yBot, bz);
    for (const c of [cTop, cBot, cTop, cTop, cBot, cBot]) colors.push(c.r, c.g, c.b);
  };
  for (let k = 0; k < ring.length - 1; k++) {
    const a = corner(ring[k]).clone();
    const b = corner(ring[k + 1]).clone();
    quad(a.x, a.z, b.x, b.z, a.y, b.y, midY, top, mid); // soil band
    quad(a.x, a.z, b.x, b.z, midY, midY, -depth, mid, bottom); // deeper strata
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
}
