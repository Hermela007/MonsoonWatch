import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { rainAccumulatedMm } from '../data/replay2014';

/** Deterministic PRNG for boulder sizes/spins (animation only). */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const SURGE_SECONDS = 8; // real-time duration of the failure once triggered
const WARN_FROM = 0.6; // cracks start at this fraction of the slope's rain threshold
const ACROSS = 17;
const ALONG = 220;

const NOISE = /* glsl */ `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.07; a *= 0.5; } return v; }
`;

// The debris body: thickness grows behind a moving front (a lumpy lobe), with a fan at the toe.
const vertexShader = /* glsl */ `
attribute float aAcross; // -1..1
attribute float aAlong;  // 0..1
uniform float uFront;    // 0..1, how far the mass has travelled
uniform float uFail;     // 0 before failure, 1 after
uniform float uTime;
varying float vAcross;
varying float vAlong;
varying float vThick;
varying vec3 vWorld;
${NOISE}
void main() {
  vAcross = aAcross;
  vAlong = aAlong;
  vec4 w = modelMatrix * vec4(position, 1.0);
  float across = 1.0 - aAcross * aAcross;
  // Moving lobe at the front + deposit left behind it; nothing ahead of the front.
  float behind = 1.0 - smoothstep(uFront - 0.015, uFront + 0.005, aAlong);
  float lobe = exp(-pow((aAlong - uFront) / 0.07, 2.0));
  float fan = smoothstep(0.55, 1.0, aAlong); // the toe spreads and piles up
  float lumps = fbm(w.xz * 0.12 + 3.1) * 0.9 + fbm(w.xz * 0.45) * 0.35;
  float thick = uFail * (behind * (2.2 + 3.5 * fan) + lobe * 7.0 * step(uFront, 0.999)) * pow(across, 0.6) * (0.55 + lumps);
  // The head scarp is where the hillside tore away: no deposit there.
  thick *= smoothstep(0.04, 0.14, aAlong);
  vThick = thick;
  w.y += thick + 0.05;
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const fragmentShader = /* glsl */ `
uniform float uFront;
uniform float uFail;
uniform float uWarn;     // 0..1 cracks spreading before failure
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uRisk;
uniform vec3 uDark;
uniform vec3 uSky;
uniform float uFogNear;
uniform float uFogFar;
varying float vAcross;
varying float vAlong;
varying float vThick;
varying vec3 vWorld;
${NOISE}
void main() {
  float edge = 1.0 - abs(vAcross);
  vec3 col;
  if (uFail < 0.5) {
    // Before failure: the predicted path (faint dashed outline) and tension cracks at the head.
    float border = smoothstep(0.0, 0.05, edge) * (1.0 - smoothstep(0.1, 0.2, edge));
    float dash = step(0.45, fract(vAlong * 22.0));
    float outline = border * dash * 0.9 + smoothstep(0.2, 0.6, edge) * 0.08;
    // Cracks: jagged dark lines across the upper slope, spreading downhill as uWarn rises.
    float head = 1.0 - smoothstep(0.0, 0.08 + 0.32 * uWarn, vAlong);
    float jag = vAlong * 60.0 + fbm(vec2(vAcross * 3.0, vAlong * 9.0)) * 3.0;
    float crack = smoothstep(0.85, 0.97, abs(sin(jag))) * step(0.2, edge) * head * smoothstep(0.0, 0.15, uWarn);
    float a = max(outline, crack * 0.95);
    if (a < 0.02) discard;
    col = mix(uRisk, uDark, crack);
    gl_FragColor = vec4(col, a);
    return;
  }
  // After failure.
  float scar = 1.0 - smoothstep(0.03, 0.15, vAlong);
  if (vAlong > uFront + 0.01 && scar < 0.01) discard;
  if (vThick < 0.02 && scar < 0.01) discard;
  // Faceted, earthy debris: flat normals from screen derivatives, lit by the sun.
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  float diff = clamp(dot(n, uSunDir), 0.0, 1.0);
  float grain = fbm(vWorld.xz * 0.7);
  col = mix(uDark, uRisk, 0.45 + 0.4 * grain) * (0.55 + 0.6 * diff);
  // Wet churn right behind the moving front.
  float churn = exp(-pow((vAlong - uFront) / 0.05, 2.0)) * step(uFront, 0.999);
  col = mix(col, uDark * 0.8, churn * 0.4 * (0.5 + 0.5 * sin(uTime * 9.0 + vWorld.x)));
  // Raw scar where the slope tore away.
  col = mix(col, uDark * 0.75, scar);
  float fog = smoothstep(uFogNear, uFogFar, length(cameraPosition - vWorld));
  gl_FragColor = vec4(mix(col, uSky, fog), 1.0);
}
`;

/**
 * A landslide on the hillside near the home, played as stages driven by REAL accumulated rain:
 * predicted path → tension cracks (warning) → failure: a lumpy debris mass surges downhill with
 * tumbling boulders and dust, leaving a scar and a deposit fan.
 */
export function createStreetSlide(opts: {
  path: { x: number; z: number }[];
  groundY: (x: number, z: number) => number;
  /** Accumulated rain (mm since the replay start) at which this slope fails. */
  triggerMm: number;
  sky: THREE.Color;
  risk: THREE.Color;
  labels: { watch: string; warn: string; active: string };
}) {
  const { groundY } = opts;
  const group = new THREE.Group();
  const curve = new THREE.CatmullRomCurve3(opts.path.map((p) => new THREE.Vector3(p.x, 0, p.z)), false, 'centripetal');
  const lengthM = curve.getLength();
  const widthAt = (u: number) => 22 + 34 * Math.pow(u, 1.3);

  const pos = new Float32Array(ALONG * ACROSS * 3);
  const across = new Float32Array(ALONG * ACROSS);
  const along = new Float32Array(ALONG * ACROSS);
  const p = new THREE.Vector3();
  const tng = new THREE.Vector3();
  for (let i = 0; i < ALONG; i++) {
    const u = i / (ALONG - 1);
    curve.getPointAt(u, p);
    curve.getTangentAt(u, tng);
    const nx = -tng.z;
    const nz = tng.x;
    for (let j = 0; j < ACROSS; j++) {
      const a = (j / (ACROSS - 1)) * 2 - 1;
      const x = p.x + nx * a * widthAt(u) * 0.5;
      const z = p.z + nz * a * widthAt(u) * 0.5;
      const k = i * ACROSS + j;
      pos.set([x, groundY(x, z), z], k * 3);
      across[k] = a;
      along[k] = u;
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
  geo.setAttribute('aAcross', new THREE.BufferAttribute(across, 1));
  geo.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
  geo.setIndex(index);
  const mat = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    side: THREE.DoubleSide,
    uniforms: {
      uFront: { value: 0 },
      uFail: { value: 0 },
      uWarn: { value: 0 },
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(-0.5, 0.8, 0.35).normalize() },
      uRisk: { value: opts.risk },
      uDark: { value: new THREE.Color(0x5a2a1a) },
      uSky: { value: opts.sky },
      uFogNear: { value: 700 },
      uFogFar: { value: 2400 },
    },
  });
  const body = new THREE.Mesh(geo, mat);
  body.renderOrder = 3;
  group.add(body);

  // Boulders: angular, varied, tumbling in the moving mass, then resting in the deposit.
  const rand = rng(Math.round(lengthM) + 7);
  const NB = 90;
  const rockGeo = new THREE.IcosahedronGeometry(1, 0);
  const rp = rockGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < rp.count; i++) rp.setXYZ(i, rp.getX(i) * (0.8 + rand() * 0.4), rp.getY(i) * (0.7 + rand() * 0.3), rp.getZ(i) * (0.8 + rand() * 0.4));
  rockGeo.computeVertexNormals();
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x9a8f86, roughness: 0.95, flatShading: true });
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, NB);
  rocks.castShadow = true;
  const rockData = Array.from({ length: NB }, () => ({
    lag: rand() * 0.35,
    off: (rand() - 0.5) * 0.9,
    size: 0.35 + Math.pow(rand(), 2.5) * 2.4,
    spin: rand() * 6,
    axis: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(),
  }));
  group.add(rocks);

  // Dust: soft sprites that billow up at the front while it moves, then drift and fade.
  const dustTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 2, 32, 32, 32);
    grad.addColorStop(0, 'rgba(170,120,95,0.55)');
    grad.addColorStop(1, 'rgba(170,120,95,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  const ND = 40;
  const dust = Array.from({ length: ND }, (_, i) => {
    const m = new THREE.SpriteMaterial({ map: dustTex, transparent: true, depthWrite: false, opacity: 0 });
    const sp = new THREE.Sprite(m);
    group.add(sp);
    return { sp, m, born: -1, u: 0, off: (rand() - 0.5) * 0.8, seed: i };
  });

  const el = document.createElement('div');
  el.className = 'slide-label street';
  const label = new CSS2DObject(el);
  label.center.set(0.5, 1.2);
  curve.getPointAt(0.02, p);
  label.position.set(p.x, groundY(p.x, p.z) + 10, p.z);
  group.add(label);

  const place = (u: number, off: number, out: THREE.Vector3) => {
    const uu = THREE.MathUtils.clamp(u, 0, 1);
    curve.getPointAt(uu, out);
    curve.getTangentAt(uu, tng);
    out.x += -tng.z * off * widthAt(uu) * 0.5;
    out.z += tng.x * off * widthAt(uu) * 0.5;
    out.y = groundY(out.x, out.z);
    return out;
  };

  let failedAt = -1;
  let front = 0;
  let justFailed = false;
  const q = new THREE.Quaternion();
  const mx = new THREE.Matrix4();
  const sc = new THREE.Vector3();
  return {
    group,
    lengthM,
    mid: place(0.45, 0, new THREE.Vector3()).clone(),
    head: place(0.0, 0, new THREE.Vector3()).clone(),
    toe: place(1.0, 0, new THREE.Vector3()).clone(),
    get reveal() {
      return front;
    },
    get surging() {
      return failedAt >= 0 && front < 1;
    },
    /** Where the action is: the cracking head before failure, the moving front during, the toe after. */
    focus(out: THREE.Vector3, dir: THREE.Vector3) {
      const stage = mat.uniforms.uFail.value > 0.5 ? Math.min(1, front + 0.02) : 0.08;
      place(stage, 0, out);
      curve.getTangentAt(Math.min(0.999, Math.max(0.001, stage)), dir);
      dir.setY(0).normalize();
      return mat.uniforms.uWarn.value > 0 || mat.uniforms.uFail.value > 0.5;
    },
    /** True for one frame when the slope fails (for a camera shake). */
    consumeFailure() {
      const j = justFailed;
      justFailed = false;
      return j;
    },
    hitAt(x: number, z: number, radius: number): number | null {
      for (let i = 0; i <= 100; i++) {
        const u = i / 100;
        curve.getPointAt(u, p);
        if (Math.hypot(p.x - x, p.z - z) < widthAt(u) / 2 + radius) return u;
      }
      return null;
    },
    update(hour: number, timeS: number) {
      const mm = rainAccumulatedMm(hour);
      const ratio = mm / opts.triggerMm;
      const failed = ratio >= 1;
      if (!failed) failedAt = -1;
      else if (failedAt < 0) {
        failedAt = timeS;
        justFailed = true;
      }
      const t = failed ? THREE.MathUtils.clamp((timeS - failedAt) / SURGE_SECONDS, 0, 1) : 0;
      // Fast start, long slow settle.
      front = failed ? 1 - Math.pow(1 - t, 2.6) : 0;
      const warn = THREE.MathUtils.clamp((ratio - WARN_FROM) / (1 - WARN_FROM), 0, 1);
      const u = mat.uniforms;
      u.uFront.value = front;
      u.uFail.value = failed ? 1 : 0;
      u.uWarn.value = warn;
      u.uTime.value = timeS;
      el.textContent = failed ? opts.labels.active : warn > 0 ? opts.labels.warn : opts.labels.watch;
      el.classList.toggle('active', failed);
      el.classList.toggle('warn', !failed && warn > 0);

      // Rocks: pebbles trickle during the warning; boulders ride the front after failure.
      rockData.forEach((r, i) => {
        let uu: number;
        let s = r.size;
        if (failed) uu = front - r.lag * (0.25 + 0.75 * front);
        else if (warn > 0.3 && i < 8) {
          uu = ((timeS * 0.05 + i * 0.13) % 1) * 0.35; // a few stones rolling from the cracks
          s = 0.25;
        } else uu = -1;
        if (uu <= 0.02) {
          rocks.setMatrixAt(i, mx.makeScale(0, 0, 0));
          return;
        }
        place(uu, r.off, p);
        p.y += s * 0.7 + (failed ? 1.2 * (1 - smoothstep01(front)) : 0);
        const rolling = failed ? (front < 1 ? 4 : 0) : 2;
        q.setFromAxisAngle(r.axis, r.spin + timeS * rolling + uu * 25);
        rocks.setMatrixAt(i, mx.compose(p, q, sc.setScalar(s)));
      });
      rocks.instanceMatrix.needsUpdate = true;

      // Dust at the moving front.
      dust.forEach((d, i) => {
        if (failed && front < 1 && d.born < 0 && Math.floor(timeS * 10) % ND === i) {
          d.born = timeS;
          d.u = front;
        }
        if (!failed) d.born = -1;
        if (d.born < 0) {
          d.m.opacity = 0;
          return;
        }
        const age = timeS - d.born;
        if (age > 5) {
          d.born = -1;
          d.m.opacity = 0;
          return;
        }
        place(d.u, d.off, p);
        d.sp.position.set(p.x, p.y + 3 + age * 4, p.z);
        d.sp.scale.setScalar(10 + age * 14);
        d.m.opacity = 0.55 * (1 - age / 5);
      });
    },
    dispose() {
      geo.dispose();
      mat.dispose();
      rockGeo.dispose();
      rockMat.dispose();
      dustTex.dispose();
      dust.forEach((d) => d.m.dispose());
      el.remove();
    },
  };
}

function smoothstep01(x: number) {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}
