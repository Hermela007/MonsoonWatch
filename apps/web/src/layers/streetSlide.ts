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
  // Only the moving front of earth: a low, lumpy band just behind the leading edge.
  // (The concave scar and the deposit fan are carved into the ground itself — see slideGround.)
  // The centre runs ahead of the flanks (a rounded snout), with a lumpy, uneven leading edge.
  float lead = uFront - 0.035 * aAcross * aAcross + (fbm(vec2(aAcross * 4.0, uTime * 0.3)) - 0.5) * 0.02;
  float lobe = exp(-pow((aAlong - lead) / 0.07, 2.0)) * (1.0 - smoothstep(lead - 0.004, lead + 0.006, aAlong));
  float lumps = fbm(w.xz * 0.12 + 3.1) * 0.9 + fbm(w.xz * 0.45) * 0.35;
  float moving = 1.0 - step(0.999, uFront);
  float thick = uFail * moving * lobe * 5.0 * smoothstep(0.0, 0.5, across) * (0.5 + lumps);
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
  // After failure: only the moving earth front is drawn here.
  if (vThick < 0.05) discard;
  // Faceted, earthy debris: flat normals from screen derivatives, lit by the sun.
  vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
  float diff = clamp(dot(n, uSunDir), 0.0, 1.0);
  float grain = fbm(vWorld.xz * 0.7);
  vec3 earth = mix(vec3(0.36, 0.25, 0.17), vec3(0.55, 0.40, 0.28), grain);
  col = earth * (0.5 + 0.65 * diff);
  col = mix(col, uRisk * 0.7, 0.18); // a hint of the risk colour
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
  /** Uniforms of the ground material's slide patch (see slideGroundUniforms / addSlideGround). */
  groundUniforms?: ReturnType<typeof slideGroundUniforms>;
  fogRange?: [number, number];
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
      uFogNear: { value: opts.fogRange?.[0] ?? 700 },
      uFogFar: { value: opts.fogRange?.[1] ?? 2400 },
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
    grad.addColorStop(0, 'rgba(150,128,105,0.5)');
    grad.addColorStop(1, 'rgba(150,128,105,0)');
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

  // Field over the slide's footprint, sampled by the ground shader to carve the scar and build the fan:
  // r = position along the path (0 crown → 1 toe), g = signed distance across it (m),
  // b = distance beyond the ends along the path (m; < 0 above the crown, > 0 past the toe), a = path half-width (m).
  const samples = Array.from({ length: 240 }, (_, i) => {
    const u = i / 239;
    const c = curve.getPointAt(u, new THREE.Vector3());
    const t = curve.getTangentAt(u, new THREE.Vector3()).setY(0).normalize();
    return { u, x: c.x, z: c.z, tx: t.x, tz: t.z, hw: widthAt(u) / 2 };
  });
  const pad = 220;
  const minX = Math.min(...samples.map((q) => q.x)) - pad;
  const maxX = Math.max(...samples.map((q) => q.x)) + pad;
  const minZ = Math.min(...samples.map((q) => q.z)) - pad;
  const maxZ = Math.max(...samples.map((q) => q.z)) + pad;
  const FN = 256;
  const fdata = new Uint16Array(FN * FN * 4);
  const half = THREE.DataUtils.toHalfFloat;
  for (let j = 0; j < FN; j++) {
    const z = minZ + ((j + 0.5) / FN) * (maxZ - minZ);
    for (let i = 0; i < FN; i++) {
      const x = minX + ((i + 0.5) / FN) * (maxX - minX);
      let best = Infinity;
      let q = samples[0];
      for (const c of samples) {
        const d2 = (c.x - x) ** 2 + (c.z - z) ** 2;
        if (d2 < best) {
          best = d2;
          q = c;
        }
      }
      const along = (x - q.x) * q.tx + (z - q.z) * q.tz;
      const across = -(x - q.x) * q.tz + (z - q.z) * q.tx;
      const beyond = q.u === 0 ? Math.min(0, along) : q.u === 1 ? Math.max(0, along) : 0;
      const k = (j * FN + i) * 4;
      fdata[k] = half(q.u);
      fdata[k + 1] = half(Math.max(-900, Math.min(900, across)));
      fdata[k + 2] = half(Math.max(-900, Math.min(900, beyond)));
      fdata[k + 3] = half(q.hw);
    }
  }
  const fieldTex = new THREE.DataTexture(fdata, FN, FN, THREE.RGBAFormat, THREE.HalfFloatType);
  fieldTex.magFilter = fieldTex.minFilter = THREE.LinearFilter;
  fieldTex.needsUpdate = true;
  if (opts.groundUniforms) {
    opts.groundUniforms.uSlideField.value = fieldTex;
    opts.groundUniforms.uSlideBox.value.set(minX, minZ, maxX - minX, maxZ - minZ);
    opts.groundUniforms.uSlideLen.value = lengthM;
  }

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
    /** quiet → warn (cracks) → surge (moving) → settled (scar and deposit left behind). */
    get state(): 'quiet' | 'warn' | 'surge' | 'settled' {
      if (failedAt >= 0) return front < 1 ? 'surge' : 'settled';
      return mat.uniforms.uWarn.value > 0 ? 'warn' : 'quiet';
    },
    /** A point on the path centreline, u = 0 (crown) … 1 (toe). */
    at(u: number, out: THREE.Vector3) {
      return place(u, 0, out);
    },
    /** Where the action is: the cracking head before failure, the moving front during, the scar after (dir reversed). */
    focus(out: THREE.Vector3, dir: THREE.Vector3) {
      const failed = mat.uniforms.uFail.value > 0.5;
      const settled = failed && front >= 0.999;
      // Once settled, look back up into the concave scar from below.
      const stage = settled ? 0.12 : failed ? Math.min(1, front + 0.02) : 0.08;
      place(stage, 0, out);
      curve.getTangentAt(Math.min(0.999, Math.max(0.001, stage)), dir);
      dir.setY(0).normalize();
      if (settled) dir.negate();
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
      if (opts.groundUniforms) {
        opts.groundUniforms.uSlideFront.value = front;
        opts.groundUniforms.uSlideFail.value = failed ? 1 : 0;
        opts.groundUniforms.uSlideWarn.value = warn;
      }
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
      fieldTex.dispose();
      dust.forEach((d) => d.m.dispose());
      el.remove();
    },
  };
}

function smoothstep01(x: number) {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}

/** Uniforms shared between the street ground material and the landslide. */
export function slideGroundUniforms() {
  return {
    uSlideField: { value: null as THREE.Texture | null },
    uSlideBox: { value: new THREE.Vector4(0, 0, 1, 1) },
    uSlideLen: { value: 1000 },
    uSlideFront: { value: 0 },
    uSlideFail: { value: 0 },
    uSlideWarn: { value: 0 },
    uScarDepth: { value: 22 },
    uFanHeight: { value: 9 },
    /** Contour interval in world units (10 m of real height × the street's vertical exaggeration). */
    uContour: { value: 25 },
  };
}

// Shared by the vertex (shape) and fragment (colour) stages so edges are crisp per pixel.
const SLIDE_GROUND = /* glsl */ `
uniform sampler2D uSlideField;
uniform vec4 uSlideBox;
uniform float uSlideLen;
uniform float uSlideFront;
uniform float uSlideFail;
uniform float uSlideWarn;
uniform float uScarDepth;
uniform float uFanHeight;
uniform float uContour;
float mwHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float mwNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mwHash(i), mwHash(i + vec2(1, 0)), u.x), mix(mwHash(i + vec2(0, 1)), mwHash(i + vec2(1, 1)), u.x), u.y);
}
// x = scar (concave hollow at the crown, 0..1), y = track (stripped ground down the path),
// z = deposit lobe at the toe, w = crown edge (the torn headscarp line).
// Path coordinates at a ground point: x = metres from the crown along the path, y = metres across,
// z = path half-width; false outside the slide's footprint.
bool slideCoords(vec2 xz, out vec3 c) {
  vec2 suv = (xz - uSlideBox.xy) / uSlideBox.zw;
  c = vec3(0.0);
  if (suv.x <= 0.0 || suv.y <= 0.0 || suv.x >= 1.0 || suv.y >= 1.0) return false;
  vec4 f = texture2D(uSlideField, suv);
  c = vec3(f.r * uSlideLen + f.b, f.g, f.a);
  return true;
}
// The spoon-shaped scar outline: < 1 inside. Shared by the warning cracks and the failure.
float scarShape(vec3 c, float wobble) {
  float L = uSlideLen;
  float cM = 0.1 * L;
  float rA = c.x < cM ? 0.075 * L : 0.16 * L;
  float rX = max(42.0, c.z * 3.4) * mix(1.0, 0.55, smoothstep(cM, cM + 0.16 * L, c.x));
  return pow((c.x - cM) / rA, 2.0) + pow(c.y / rX, 2.0) + wobble;
}
// Before failure: tension cracks tracing where the crown will tear, spreading as the rain builds.
float slideCracks(vec2 xz) {
  vec3 c;
  if (uSlideFail > 0.5 || uSlideWarn <= 0.0 || !slideCoords(xz, c)) return 0.0;
  float wobble = (mwNoise(c.xy * 0.035) - 0.5) * 0.25;
  float e = scarShape(c, wobble);
  float upper = step(c.x, 0.1 * uSlideLen + 0.02 * uSlideLen);
  float arc = (1.0 - smoothstep(0.0, 0.03 + 0.04 * uSlideWarn, abs(e - 1.0 + 0.04 * sin(c.y * 0.3)))) * upper;
  // Broken into jagged segments that join up as the warning grows.
  float seg = step(1.0 - uSlideWarn * 1.15, mwNoise(vec2(c.y * 0.07, 3.0)));
  // Shorter cracks inside the zone, across the slope, once the warning is well along.
  float band = abs(fract(c.x * 0.035 + mwNoise(c.yx * 0.04) * 0.8) - 0.5);
  float inner = (1.0 - smoothstep(0.0, 0.035, band)) * smoothstep(0.75, 0.3, e) * smoothstep(0.45, 0.9, uSlideWarn)
    * step(0.55, mwNoise(c.xy * 0.05 + 7.0));
  return max(arc * seg, inner * 0.8);
}
vec4 slideMasks(vec2 xz) {
  vec3 c;
  if (uSlideFail < 0.5 || !slideCoords(xz, c)) return vec4(0.0);
  float L = uSlideLen;
  float sM = c.x;                      // metres from the crown along the path
  float gM = c.y;                      // metres across
  float hw = c.z;
  float wobble = (mwNoise(vec2(gM, sM) * 0.035) - 0.5) * 0.25;
  // Material leaves the slope as the front passes.
  float passed = 1.0 - smoothstep(uSlideFront * L - 30.0, uSlideFront * L + 5.0, sM);
  // Scar: a spoon-shaped hollow, steep at the crown and shallowing downslope.
  float cM = 0.1 * L;
  float e = scarShape(c, wobble);
  float scar = smoothstep(1.0, 0.25, e) * passed;
  float edge = (1.0 - smoothstep(0.0, 0.07, abs(e - 1.0))) * step(sM, cM + 0.02 * L) * passed;
  // Track: the ground stripped along the path below the scar.
  float lane = 1.0 - smoothstep(0.75, 1.05, abs(gM) / hw + wobble);
  float track = lane * smoothstep(cM, cM + 0.08 * L, sM) * (1.0 - smoothstep(L, L + 20.0, sM)) * passed;
  // Deposit lobe: a rounded tongue of debris spreading out at the toe.
  float tA = max(45.0, 0.07 * L);
  float tX = max(30.0, hw * 1.35);
  float eT = pow((sM - L) / tA, 2.0) + pow(gM / tX, 2.0) + wobble * 0.6;
  float lobe = smoothstep(1.0, 0.0, eT) * smoothstep(0.75, 1.0, uSlideFront);
  return vec4(scar, track, lobe, edge);
}
`;

/**
 * Patch the street ground so a failed slope is CARVED: a concave scar of exposed soil opens at the crown
 * as the material leaves, a stripped track runs down the path, and a rounded debris lobe builds at the toe.
 * Shape in the vertex stage; colour and normals per pixel (crisp edges on a coarse mesh).
 * Chains after any existing onBeforeCompile (e.g. the underwater/grid patch).
 */
export function addSlideGround(mat: THREE.MeshStandardMaterial, u: ReturnType<typeof slideGroundUniforms>) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    Object.assign(shader.uniforms, u);
    shader.vertexShader =
      SLIDE_GROUND +
      'varying vec2 vSlideXZ;\nvarying float vGroundY;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vSlideXZ = position.xz;
        vGroundY = transformed.y;
        vec4 sm = slideMasks(position.xz);
        transformed.y += uFanHeight * smoothstep(0.0, 1.0, sm.z) - uScarDepth * sm.x - 1.2 * sm.y;`,
      );
    shader.fragmentShader =
      SLIDE_GROUND +
      'varying vec2 vSlideXZ;\nvarying float vGroundY;\n' +
      shader.fragmentShader
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          vec4 smF = slideMasks(vSlideXZ);
          // Faint contour lines (10 m, every fifth stronger) so the hillside reads as a slope.
          float cy = vGroundY / uContour;
          float cl = 1.0 - smoothstep(0.0, fwidth(cy) * 1.6, abs(fract(cy - 0.5) - 0.5));
          float major = step(abs(mod(floor(cy + 0.5), 5.0)), 0.5);
          diffuseColor.rgb *= 1.0 - cl * mix(0.13, 0.24, major);
          float grain = mwNoise(vSlideXZ * 0.12) * 0.6 + mwNoise(vSlideXZ * 0.5) * 0.4;
          // Linear colours: dark wet soil in the hollow, paler scoured earth on the track, mixed debris on the lobe.
          vec3 scarSoil = mix(vec3(0.16, 0.10, 0.06), vec3(0.075, 0.045, 0.028), smF.x) * (0.85 + 0.3 * grain);
          vec3 trackSoil = vec3(0.30, 0.21, 0.14) * (0.8 + 0.4 * grain);
          vec3 lobeSoil = mix(vec3(0.20, 0.13, 0.08), vec3(0.34, 0.25, 0.17), grain);
          float aTrack = smoothstep(0.05, 0.4, smF.y);
          float aScar = smoothstep(0.02, 0.12, smF.x);
          float aLobe = smoothstep(0.02, 0.15, smF.z);
          diffuseColor.rgb = mix(diffuseColor.rgb, trackSoil, aTrack * 0.85);
          diffuseColor.rgb = mix(diffuseColor.rgb, lobeSoil, aLobe);
          diffuseColor.rgb = mix(diffuseColor.rgb, scarSoil, aScar);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.03, 0.02, 0.015), smF.w * 0.9);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.04, 0.025, 0.018), slideCracks(vSlideXZ) * 0.9);`,
        )
        .replace(
          '#include <normal_fragment_begin>',
          `#include <normal_fragment_begin>
          {
            vec4 smN = slideMasks(vSlideXZ);
            float carved = max(smN.x, smN.z);
            if (carved > 0.01) {
              vec3 fn = normalize(cross(dFdx(vViewPosition), dFdy(vViewPosition)));
              normal = normalize(mix(normal, fn, smoothstep(0.01, 0.3, carved)));
            }
          }`,
        );
  };
  const prevKey = mat.customProgramCacheKey?.bind(mat);
  mat.customProgramCacheKey = () => `${prevKey ? prevKey() : ''}-slide2`;
  return mat;
}
