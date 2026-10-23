import * as THREE from 'three';
import type { House } from '../data/buildings';
import { THEME } from '../theme';

const SIZE_M = 900;
const SEGMENTS = 220; // ~4 m vertex spacing: enough for the shortest wave below

const NOISE = /* glsl */ `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
`;

// Sum of Gerstner waves (crests sharpen, troughs flatten) with analytic normals.
const vertexShader = /* glsl */ `
uniform float uTime;
uniform float uCalm; // 0 = full waves, 1 = flat
uniform float uLevel; // water surface, local metres
uniform sampler2D uGround; // ground height, local metres
uniform float uSize;
uniform vec3 uOrigin;
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vHeight;
varying float vDepth;

vec3 gerstner(vec2 p, vec2 dir, float steep, float wl, inout vec3 tangent, inout vec3 binormal) {
  float k = 6.28318 / wl;
  float c = sqrt(9.8 / k);
  vec2 d = normalize(dir);
  float f = k * (dot(d, p) - c * uTime);
  float a = steep / k;
  tangent += vec3(-d.x * d.x * steep * sin(f), d.x * steep * cos(f), -d.x * d.y * steep * sin(f));
  binormal += vec3(-d.x * d.y * steep * sin(f), d.y * steep * cos(f), -d.y * d.y * steep * sin(f));
  return vec3(d.x * a * cos(f), a * sin(f), d.y * a * cos(f));
}

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vec2 p = world.xz;
  vec2 guv = vec2((p.x - uOrigin.x) / uSize + 0.5, 0.5 - (p.y - uOrigin.z) / uSize);
  vDepth = uLevel - texture2D(uGround, guv).r;
  // Waves die out in shallow water instead of poking through the ground.
  float s = (1.0 - uCalm) * smoothstep(0.0, 2.5, vDepth);
  vec3 tangent = vec3(1.0, 0.0, 0.0);
  vec3 binormal = vec3(0.0, 0.0, 1.0);
  vec3 offset = vec3(0.0);
  offset += gerstner(p, vec2(1.0, 0.6), 0.20 * s, 16.0, tangent, binormal);
  offset += gerstner(p, vec2(-0.4, 1.0), 0.16 * s, 10.0, tangent, binormal);
  offset += gerstner(p, vec2(0.7, -0.8), 0.12 * s, 6.5, tangent, binormal);
  offset += gerstner(p, vec2(0.2, 1.0), 0.08 * s, 9.0, tangent, binormal);
  world.xyz += offset;
  vHeight = offset.y;
  vNormalW = normalize(cross(binormal, tangent));
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const fragmentShader = /* glsl */ `
uniform float uTime;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform vec3 uSky;
uniform vec3 uFoam;
uniform vec3 uSunDir;
uniform sampler2D uWallFoam;
uniform float uSize;
uniform vec3 uOrigin;
uniform float uFogNear;
uniform float uFogFar;
varying vec3 vWorld;
varying vec3 vNormalW;
varying float vHeight;
varying float vDepth;
${NOISE}

void main() {
  if (vDepth < 0.0) discard;
  vec3 n = normalize(vNormalW);
  // Small moving ripples on top of the big waves.
  // (faded with distance: at grazing angles noisy normals turn into camouflage blotches)
  float dist = length(cameraPosition - vWorld);
  vec2 rp = vWorld.xz * 0.5;
  float r1 = noise(rp + vec2(uTime * 0.6, uTime * 0.3));
  float r2 = noise(rp * 2.1 - vec2(uTime * 0.4, -uTime * 0.7));
  n = normalize(n + vec3(r1 - 0.5, 0.0, r2 - 0.5) * 0.08 * (1.0 - smoothstep(20.0, 120.0, dist)));

  vec3 viewDir = normalize(cameraPosition - vWorld);
  float fres = 0.2 * pow(1.0 - max(dot(n, viewDir), 0.0), 5.0);
  float spec = pow(max(dot(reflect(-uSunDir, n), viewDir), 0.0), 70.0);

  // Clear water: barely tinted when shallow, the flood blue deepening with depth; sky reflection at grazing angles.
  float depthK = 1.0 - exp(-max(vDepth, 0.0) / 3.5);
  vec3 col = mix(uShallow, uDeep, depthK * 0.85) * (0.92 + 0.12 * smoothstep(-0.4, 0.5, vHeight));
  col = mix(col, uSky, fres * 2.5) + spec * 0.6;

  // Foam: on wave crests, and where water laps against walls.
  // Streaky foam: stretched noise along the main wave direction, only near crests.
  vec2 fp = vec2(dot(vWorld.xz, vec2(0.86, 0.51)) * 0.25, dot(vWorld.xz, vec2(-0.51, 0.86)) * 1.6);
  float crest = smoothstep(0.75, 0.95, vHeight) * smoothstep(0.65, 0.85, noise(fp + uTime * 0.3));
  vec2 fuv = vec2((vWorld.x - uOrigin.x) / uSize + 0.5, 0.5 - (vWorld.z - uOrigin.z) / uSize);
  float wall = texture2D(uWallFoam, fuv).r;
  // Only while walls still stick out of the water (single storey ≈ 3.4 m).
  float lap = smoothstep(0.6, 0.95, wall) * smoothstep(0.15, 1.0, vDepth) * (1.0 - smoothstep(2.5, 3.4, vDepth)) * smoothstep(0.4, 0.8, noise(vWorld.xz * 1.5 - uTime * 1.2) + 0.25 * sin(uTime * 3.0 + wall * 6.0));
  // Shoreline: a thin foam line where the water meets dry ground.
  float shore = 1.0 - smoothstep(0.0, 0.08, vDepth);
  // A crisp waterline at the shore and a whisper of white on the biggest crests.
  col = mix(col, uDeep, shore * 0.8);
  col = mix(col, vec3(1.0), clamp(crest * 0.25 + lap * 0.2, 0.0, 1.0));

  float fog = smoothstep(uFogNear, uFogFar, dist);
  float alpha = 0.28 + 0.5 * depthK + 0.4 * fres + shore * 0.5;
  gl_FragColor = vec4(mix(col, uSky, fog), clamp(alpha, 0.0, 0.95));
}
`;

/** Top-down mask of house outlines (blurred) so foam can lap against walls. */
function wallFoamTexture(houses: House[]) {
  const px = 1024;
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d')!;
  const s = px / SIZE_M;
  g.filter = 'blur(3px)';
  g.strokeStyle = '#fff';
  g.lineWidth = 2.2 * s;
  for (const h of houses) {
    g.save();
    g.translate((h.x / SIZE_M + 0.5) * px, (h.z / SIZE_M + 0.5) * px);
    g.rotate(-h.angle);
    g.strokeRect((-h.w / 2) * s, (-h.d / 2) * s, h.w * s, h.d * s);
    g.restore();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/** Ground heights (local m) over the water square, as a filterable half-float texture. */
function groundTexture(groundY: (x: number, z: number) => number) {
  const N = 192;
  const data = new Uint16Array(N * N);
  for (let j = 0; j < N; j++) {
    const z = (0.5 - (j + 0.5) / N) * SIZE_M;
    for (let i = 0; i < N; i++) data[j * N + i] = THREE.DataUtils.toHalfFloat(groundY(((i + 0.5) / N - 0.5) * SIZE_M, z));
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.HalfFloatType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** Animated floodwater for the street view: Gerstner waves, ripples, crest/wall/shore foam. */
export function createStreetWater(
  houses: House[],
  sky: THREE.Color,
  fog: { near: number; far: number },
  groundY: (x: number, z: number) => number,
) {
  const geometry = new THREE.PlaneGeometry(SIZE_M, SIZE_M, SEGMENTS, SEGMENTS).rotateX(-Math.PI / 2);
  const foamTex = wallFoamTexture(houses);
  const groundTex = groundTexture(groundY);
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    uniforms: {
      uTime: { value: 0 },
      uCalm: { value: 0 },
      uLevel: { value: 0 },
      uGround: { value: groundTex },
      uDeep: { value: THEME.flood },
      uShallow: { value: THEME.floodLight },
      uSky: { value: sky },
      uFoam: { value: new THREE.Color(0xeee6d2) },
      uSunDir: { value: new THREE.Vector3(-0.5, 0.8, 0.35).normalize() },
      uWallFoam: { value: foamTex },
      uSize: { value: SIZE_M },
      uOrigin: { value: new THREE.Vector3() },
      uFogNear: { value: fog.near },
      uFogFar: { value: fog.far },
    },
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 2;
  mesh.frustumCulled = false;

  return {
    mesh,
    /** `level` = water surface (local metres); `depthAtHome` scales wave height. */
    update(level: number, depthAtHome: number, timeS: number) {
      mesh.position.y = level;
      material.uniforms.uLevel.value = level;
      material.uniforms.uTime.value = timeS;
      // Flowing floodwater always has some chop; deeper water gets the full waves.
      material.uniforms.uCalm.value = 0.45 * (1 - THREE.MathUtils.smoothstep(depthAtHome, 0.3, 2));
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      foamTex.dispose();
      groundTex.dispose();
    },
  };
}
