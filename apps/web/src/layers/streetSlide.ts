import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { rng } from '../data/buildings';

const SLIDE_SECONDS = 7; // real-time duration of the debris surge once triggered
const ACROSS = 9;
const ALONG = 140;

const vertexShader = /* glsl */ `
attribute float aAcross; // -1..1
varying vec2 vUv;
varying float vAcross;
varying vec3 vWorld;
void main() {
  vUv = uv;
  vAcross = aAcross;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const fragmentShader = /* glsl */ `
uniform float uReveal; // 0..1 along the path (mud)
uniform float uWarn; // 1 = predicted path only
uniform float uTime;
uniform vec3 uSky;
uniform float uFogNear;
uniform float uFogFar;
varying vec2 vUv;
varying float vAcross;
varying vec3 vWorld;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
void main() {
  float edge = 1.0 - abs(vAcross);
  if (uWarn > 0.5) {
    // Predicted runout: translucent amber band with dashes flowing downhill.
    float dash = step(0.5, fract(vUv.y * 18.0 - uTime * 0.6));
    float border = smoothstep(0.0, 0.12, edge) * (1.0 - smoothstep(0.12, 0.25, edge));
    vec3 c = vec3(0.92, 0.62, 0.18);
    float a = border * dash * 0.9 + smoothstep(0.0, 0.3, edge) * 0.18;
    if (a < 0.02) discard;
    gl_FragColor = vec4(c, a);
    return;
  }
  // Ragged, lobed front.
  float front = uReveal - 0.03 * noise(vec2(vAcross * 4.0, uTime));
  if (vUv.y > front) discard;
  if (edge < 0.08 * noise(vWorld.xz * 0.2)) discard;
  float flow = noise(vec2(vAcross * 6.0, vUv.y * 40.0 - uTime * 3.0 * (1.0 - smoothstep(0.98, 1.0, uReveal) * 0.9)));
  vec3 mud = mix(vec3(0.33, 0.24, 0.15), vec3(0.47, 0.35, 0.22), flow);
  mud = mix(mud, vec3(0.25, 0.15, 0.09), smoothstep(0.1, 0.0, vUv.y)); // raw scar at the head scarp
  mud += pow(flow, 6.0) * 0.25; // wet sheen
  mud *= 0.75 + 0.25 * smoothstep(0.0, 0.4, edge);
  float fog = smoothstep(uFogNear, uFogFar, length(cameraPosition - vWorld));
  gl_FragColor = vec4(mix(mud, uSky, fog), 1.0);
}
`;

/**
 * A landslide on the hillside near the home: predicted path before it fails, then a debris flow
 * (mud lobe, scar, tumbling boulders, uprooted trees) surging downhill in real time.
 */
export function createStreetSlide(opts: {
  path: { x: number; z: number }[];
  groundY: (x: number, z: number) => number;
  triggerHour: number;
  sky: THREE.Color;
  labels: { warn: string; active: string };
}) {
  const { groundY } = opts;
  const group = new THREE.Group();
  const curve2 = new THREE.CatmullRomCurve3(opts.path.map((p) => new THREE.Vector3(p.x, 0, p.z)), false, 'centripetal');
  const lengthM = curve2.getLength();

  // Ribbon draped on the ground, mounded in the middle, widening into a fan at the toe.
  const pos = new Float32Array(ALONG * ACROSS * 3);
  const uv = new Float32Array(ALONG * ACROSS * 2);
  const across = new Float32Array(ALONG * ACROSS);
  const p = new THREE.Vector3();
  const tng = new THREE.Vector3();
  for (let i = 0; i < ALONG; i++) {
    const u = i / (ALONG - 1);
    curve2.getPointAt(u, p);
    curve2.getTangentAt(u, tng);
    const nx = -tng.z;
    const nz = tng.x;
    const width = 16 + 22 * Math.pow(u, 1.5);
    for (let j = 0; j < ACROSS; j++) {
      const a = (j / (ACROSS - 1)) * 2 - 1;
      const x = p.x + nx * a * width * 0.5;
      const z = p.z + nz * a * width * 0.5;
      const mound = (1 - a * a) * (1.2 + 1.3 * u);
      const k = i * ACROSS + j;
      pos.set([x, groundY(x, z) + 0.3 + mound, z], k * 3);
      uv.set([j / (ACROSS - 1), u], k * 2);
      across[k] = a;
    }
  }
  const index: number[] = [];
  for (let i = 0; i < ALONG - 1; i++) {
    for (let j = 0; j < ACROSS - 1; j++) {
      const a = i * ACROSS + j;
      index.push(a, a + 1, a + ACROSS, a + 1, a + ACROSS + 1, a + ACROSS);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('aAcross', new THREE.BufferAttribute(across, 1));
  geo.setIndex(index);
  geo.computeVertexNormals();
  const mat = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    side: THREE.DoubleSide,
    uniforms: { uReveal: { value: 0 }, uWarn: { value: 1 }, uTime: { value: 0 }, uSky: { value: opts.sky }, uFogNear: { value: 250 }, uFogFar: { value: 1100 } },
  });
  const ribbon = new THREE.Mesh(geo, mat);
  ribbon.renderOrder = 3;
  ribbon.receiveShadow = true;
  group.add(ribbon);

  // Boulders and uprooted trunks riding near the front.
  const rand = rng(Math.round(lengthM));
  const NB = 46;
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x7b7266, roughness: 0.95, flatShading: true });
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, NB);
  rocks.castShadow = true;
  const rockData = Array.from({ length: NB }, () => ({ lag: rand() * 0.22, off: (rand() - 0.5) * 0.8, size: 0.35 + Math.pow(rand(), 2) * 1.6, spin: rand() * 6, axis: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize() }));
  const NT = 7;
  const logGeo = new THREE.CylinderGeometry(0.22, 0.3, 7, 6).rotateZ(Math.PI / 2);
  const logMat = new THREE.MeshStandardMaterial({ color: 0x6a5240, roughness: 0.95 });
  const logs = new THREE.InstancedMesh(logGeo, logMat, NT);
  logs.castShadow = true;
  const logData = Array.from({ length: NT }, () => ({ lag: 0.03 + rand() * 0.18, off: (rand() - 0.5) * 0.7, yaw: rand() * Math.PI }));
  group.add(rocks, logs);

  // Head-scarp label.
  const el = document.createElement('div');
  el.className = 'slide-label street';
  const label = new CSS2DObject(el);
  label.center.set(0.5, 1.2);
  curve2.getPointAt(0, p);
  label.position.set(p.x, groundY(p.x, p.z) + 8, p.z);
  group.add(label);

  let triggeredAt = -1;
  const q = new THREE.Quaternion();
  const mx = new THREE.Matrix4();
  const s = new THREE.Vector3();
  const place = (u: number, off: number, out: THREE.Vector3) => {
    curve2.getPointAt(THREE.MathUtils.clamp(u, 0, 1), out);
    curve2.getTangentAt(THREE.MathUtils.clamp(u, 0, 1), tng);
    const width = 16 + 22 * Math.pow(u, 1.5);
    out.x += -tng.z * off * width * 0.5;
    out.z += tng.x * off * width * 0.5;
    out.y = groundY(out.x, out.z);
    return out;
  };

  let revealNow = 0;
  return {
    group,
    lengthM,
    /** How far down the path (0..1) the debris has reached. */
    get reveal() {
      return revealNow;
    },
    /** Path parameter (0..1) where this footprint is hit, or null if the debris misses it. */
    hitAt(x: number, z: number, radius: number): number | null {
      let best: number | null = null;
      for (let i = 0; i <= 100; i++) {
        const u = i / 100;
        curve2.getPointAt(u, p);
        const width = 16 + 22 * Math.pow(u, 1.5);
        if (Math.hypot(p.x - x, p.z - z) < width / 2 + radius) {
          best = u;
          break;
        }
      }
      return best;
    },
    /** Point halfway down the slide, for camera framing. */
    mid: place(0.45, 0, new THREE.Vector3()).clone(),
    /** True while the debris surge is animating (the replay slows down for it). */
    get surging() {
      return triggeredAt >= 0 && mat.uniforms.uReveal.value < 1;
    },
    update(hour: number, timeS: number) {
      const on = hour >= opts.triggerHour;
      if (!on) triggeredAt = -1;
      else if (triggeredAt < 0) triggeredAt = timeS;
      const reveal = on ? THREE.MathUtils.clamp((timeS - triggeredAt) / SLIDE_SECONDS, 0, 1) : 0;
      const eased = 1 - Math.pow(1 - reveal, 2.2);
      revealNow = eased;
      mat.uniforms.uWarn.value = on ? 0 : 1;
      mat.uniforms.uReveal.value = eased;
      mat.uniforms.uTime.value = timeS;
      el.textContent = on ? opts.labels.active : opts.labels.warn;
      el.classList.toggle('active', on);
      rocks.visible = logs.visible = on;
      if (!on) return;
      rockData.forEach((r, i) => {
        const u = eased - r.lag * (0.4 + 0.6 * eased);
        if (u <= 0.01) {
          mx.makeScale(0, 0, 0);
        } else {
          place(u, r.off, p);
          p.y += r.size * 0.6;
          q.setFromAxisAngle(r.axis, r.spin + timeS * (reveal < 1 ? 3 : 0) + u * 20);
          mx.compose(p, q, s.setScalar(r.size));
        }
        rocks.setMatrixAt(i, mx);
      });
      rocks.instanceMatrix.needsUpdate = true;
      logData.forEach((l, i) => {
        const u = eased - l.lag * (0.4 + 0.6 * eased);
        if (u <= 0.01) mx.makeScale(0, 0, 0);
        else {
          place(u, l.off, p);
          p.y += 0.5;
          q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), l.yaw + u * 3);
          mx.compose(p, q, s.setScalar(1));
        }
        logs.setMatrixAt(i, mx);
      });
      logs.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      rockGeo.dispose();
      rockMat.dispose();
      logGeo.dispose();
      logMat.dispose();
      el.remove();
    },
  };
}
