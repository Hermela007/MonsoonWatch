import * as THREE from 'three';
import type { GeoFrame, LngLat } from '../geo/region';
import { cellLngLat, gridCoords, sampleField, type Heightmap } from '../terrain/heightmap';
import type { Hydrology } from '../terrain/hydrology';
import { FOG, THEME } from '../theme';

const vertexShader = /* glsl */ `
attribute float aElev;
attribute float aSlope;
attribute float aRiverFlag;
uniform float uExag;
varying float vRiverFlag;
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
  vRiverFlag = aRiverFlag;
  vUv = uv;
  vec4 mv = viewMatrix * world;
  vViewDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uSunDir;
uniform float uTime;
uniform float uRainAcc;
uniform vec3 uPaper;
uniform vec3 uLine;
uniform vec3 uLineStrong;
uniform vec3 uRiskCol;
uniform vec3 uRiverCol;
uniform vec3 uFogCol;
uniform float uFogDensity;
uniform vec3 uFocus;
uniform float uFocusR;
uniform float uFocusOn;
varying float vElev;
varying float vSlope;
varying float vRiverFlag;
varying vec2 vUv;
varying vec3 vNormalW;
varying vec3 vWorld;
varying float vViewDist;
uniform sampler2D uMask;

// Anti-aliased grid line of period p (world km), width w (px).
float gridLine(vec2 p, float period, float w) {
  vec2 c = p / period;
  vec2 g = abs(fract(c - 0.5) - 0.5) / max(fwidth(c), vec2(1e-4));
  return 1.0 - min(min(g.x, g.y) / w, 1.0);
}

void main() {
  // Only Kelantan: the state boundary, rasterised crisply into uMask.
  if (texture2D(uMask, vUv).r < 0.5) discard;
  vec3 n = normalize(vNormalW);
  float diff = clamp(dot(n, uSunDir), 0.0, 1.0);
  // Off-white model surface; hill-shading in neutral greys so the relief reads.
  vec3 col = uPaper * (0.6 + 0.48 * diff);
  col *= 1.0 - smoothstep(12.0, 40.0, vSlope) * 0.08;

  // Grid: 1 km minor, 5 km major, fading with distance.
  float fade = 1.0 - smoothstep(60.0, 260.0, vViewDist);
  col = mix(col, uLine, gridLine(vWorld.xz, 1.0, 1.0) * 0.55 * fade);
  col = mix(col, uLineStrong, gridLine(vWorld.xz, 5.0, 1.2) * 0.6 * fade);
  // Faint 100 m contours.
  float ce = vElev / 100.0;
  float cl = abs(fract(ce - 0.5) - 0.5) / max(fwidth(ce), 1e-4);
  col = mix(col, uLine, (1.0 - min(cl, 1.0)) * 0.35 * step(5.0, vElev) * (1.0 - smoothstep(20.0, 120.0, vViewDist)));

  // Rivers: thin lines in the flood colour (the water sheet takes over as they rise).
  col = mix(col, uRiverCol * 0.85, smoothstep(0.55, 0.95, vRiverFlag) * 0.85 * smoothstep(40.0, 90.0, vViewDist));

  float inFocus = 1.0 - smoothstep(uFocusR, uFocusR * 2.2, length(vWorld.xz - uFocus.xz));

  // Landslide susceptibility (slope x accumulated rain): the only warm colour on the terrain.
  float risk = smoothstep(18.0, 35.0, vSlope) * smoothstep(0.15, 0.9, uRainAcc) * step(40.0, vElev);
  float pulse = 0.85 + 0.15 * sin(uTime * 2.0 - vWorld.z * 0.5);
  col = mix(col, uRiskCol, risk * 0.7 * pulse * mix(1.0, inFocus, uFocusOn));

  // Outside the home's area: recede into paper.
  col = mix(col, uFogCol, (1.0 - inFocus) * uFocusOn * 0.18);

  float fog = 1.0 - exp(-pow(uFogDensity * vViewDist, 2.0));
  gl_FragColor = vec4(mix(col, uFogCol, fog), 1.0);
}
`;


export interface Focus {
  centre: THREE.Vector3;
  radiusKm: number;
  /** 0 = whole valley lit, 1 = spotlight on the home. */
  amount: number;
}

/** Terrain slab: satellite imagery on the DEM, earthy sides, spotlight around the resident's home. */
export function createValley(hm: Heightmap, hy: Hydrology, frame: GeoFrame, fogColor: THREE.Color, mask: THREE.Texture, boundary: LngLat[]) {
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
  geometry.setAttribute('aRiverFlag', new THREE.BufferAttribute(Float32Array.from(hy.riverMask), 1));

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uMask: { value: mask },
      uDetail: { value: null as THREE.Texture | null },
      uDetailRect: { value: new THREE.Vector4(0, 0, 0, 0) },
      uDetailOn: { value: 0 },
      uExag: { value: frame.exag },
      uRainAcc: { value: 0 },
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(-0.55, 0.75, -0.4).normalize() },
      uPaper: { value: THEME.paper },
      uLine: { value: THEME.line },
      uLineStrong: { value: THEME.lineStrong },
      uRiskCol: { value: THEME.slide },
      uRiverCol: { value: THEME.flood },
      uFogCol: { value: fogColor },
      uFogDensity: FOG,
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
  const base = createBoundaryWall(hm, frame, boundary, 2.2);
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
  const top = new THREE.Color(0xe4e1db);
  const mid = new THREE.Color(0xdcd8d1);
  const bottom = new THREE.Color(0xcfcac2);
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

/** Soil-coloured wall along the real state boundary, its top following the terrain. */
export function createBoundaryWall(hm: Heightmap, frame: GeoFrame, ring: LngLat[], depth: number) {
  const groundAt = (ll: LngLat) => {
    const { gx, gy } = gridCoords(hm, ll);
    const e = sampleField(hm, hm.elevM, gx, gy);
    return Number.isNaN(e) ? 0 : Math.max(e, 0);
  };
  // Densify so the wall's top follows the relief (~0.4 km steps).
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const steps = Math.max(1, Math.ceil(Math.hypot((b[0] - a[0]) * 111, (b[1] - a[1]) * 110.6) / 0.4));
    for (let k = 0; k < steps; k++) {
      const ll: LngLat = [a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps];
      pts.push(frame.lngLatToWorld(ll, groundAt(ll)));
    }
  }
  const verts: number[] = [];
  const cols: number[] = [];
  const top = new THREE.Color(0xe4e1db);
  const bottom = new THREE.Color(0xcfcac2);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    verts.push(a.x, a.y, a.z, a.x, -depth, a.z, b.x, b.y, b.z, b.x, b.y, b.z, a.x, -depth, a.z, b.x, -depth, b.z);
    for (const c of [top, bottom, top, top, bottom, bottom]) cols.push(c.r, c.g, c.b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
}

/** Crisp mask of a lon/lat polygon over the heightmap's grid (uv-aligned, north at the top). */
export function boundaryMask(hm: Heightmap, ring: LngLat[], px = 2048) {
  const [minLon, minLat, maxLon, maxLat] = hm.bbox;
  const W = px;
  const H = Math.round((px * (maxLat - minLat)) / (maxLon - minLon));
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#fff';
  g.beginPath();
  ring.forEach(([lon, lat], k) => {
    const x = ((lon - minLon) / (maxLon - minLon)) * W;
    const y = ((maxLat - lat) / (maxLat - minLat)) * H;
    if (k) g.lineTo(x, y);
    else g.moveTo(x, y);
  });
  g.closePath();
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  // Also return a per-cell inside test for filtering data (hotspots, labels).
  const data = g.getImageData(0, 0, W, H).data;
  const inside = (ll: LngLat) => {
    const x = Math.floor(((ll[0] - minLon) / (maxLon - minLon)) * W);
    const y = Math.floor(((maxLat - ll[1]) / (maxLat - minLat)) * H);
    return x >= 0 && y >= 0 && x < W && y < H && data[(y * W + x) * 4] > 127;
  };
  return { texture: tex, inside };
}
