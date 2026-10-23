import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { LngLat } from '../geo/region';
import { cellLngLat, gridCoords, sampleField, type Heightmap } from '../terrain/heightmap';
import { NO_DRAIN_M, type Hydrology } from '../terrain/hydrology';
import { neighbourhood } from '../terrain/homeRisk';
import type { SlideSource } from '../terrain/landslide';
import { localFrame, rng, type House, type Lane } from '../data/buildings';
import { staffGaugeTexture } from '../data/textures';
import { REPLAY_HOURS, rainAccumulated, stageM } from '../mock/replay2014';
import { createStreetWater } from './streetWater';
import { createHouses } from './houses';
import { createVegetation } from './vegetation';
import { createStreetSlide } from './streetSlide';

const GROUND_M = 1400;
const SLIDE_MAX_M = 900; // show a landslide in the street if its path passes this close to home
const SLIDE_CLIP_M = 650; // ...drawing the part of it within this distance

// Roof tint = water at the house (m).
export const DEPTH_BANDS = [
  { max: 0.05, color: null, label: 'Dry' },
  { max: 0.5, color: new THREE.Color(0xf3e05a), label: 'Up to 0.5 m' },
  { max: 1.5, color: new THREE.Color(0xf29a2e), label: '0.5–1.5 m' },
  { max: Infinity, color: new THREE.Color(0xe23d2d), label: 'Over 1.5 m' },
] as const;

/** Lawns, concrete driveways and porches, asphalt roads with kerbs and centre lines. */
function groundTexture(houses: House[], lanes: Lane[], seed: number) {
  const N = 4096;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d')!;
  const s = N / GROUND_M;
  const X = (x: number) => (x / GROUND_M + 0.5) * N;
  const rand = rng(seed + 5);
  g.fillStyle = '#86995a';
  g.fillRect(0, 0, N, N);
  for (let k = 0; k < 7000; k++) {
    g.fillStyle = `hsla(${72 + rand() * 20}, ${26 + rand() * 16}%, ${34 + rand() * 14}%, 0.16)`;
    g.beginPath();
    g.arc(rand() * N, rand() * N, 4 + rand() * 30, 0, Math.PI * 2);
    g.fill();
  }
  // Plots: mown lawn, concrete apron/driveway in front of each house.
  for (const h of houses) {
    const L = h.kind === 'terrace' ? h.w : Math.max(h.w, h.d);
    const W = h.kind === 'terrace' ? Math.min(h.d, 12) : Math.min(h.w, h.d);
    g.save();
    g.translate(X(h.x), X(h.z));
    g.rotate(-h.angle);
    g.fillStyle = '#93a865';
    g.fillRect((-L / 2 - 4) * s, (-W / 2 - 4) * s, (L + 12) * s, (W + 10) * s);
    g.fillStyle = '#cbc6bb';
    if (h.kind === 'terrace') g.fillRect((-L / 2) * s, (W / 2) * s, L * s, 6 * s);
    else {
      g.fillRect((L / 2 + 0.1) * s, (-2.2) * s, 3.6 * s, (W / 2 + 9) * s); // driveway
      g.fillRect((-L * 0.12 - 1.8) * s, (W / 2) * s, 3.6 * s, 2.4 * s); // porch
    }
    g.restore();
  }
  // Roads: kerb, asphalt, dashed centre line.
  for (const [w, col, dash] of [
    [10.4, '#c9c4b8', null],
    [9, '#5f605d', null],
    [0.25, '#ece8dc', [3 * s, 3 * s]],
  ] as const) {
    g.strokeStyle = col;
    g.lineWidth = w * s;
    g.lineCap = 'butt';
    g.setLineDash(dash ? [...dash] : []);
    for (const lane of lanes) {
      g.beginPath();
      lane.forEach((p, k) => (k ? g.lineTo(X(p.x), X(p.z)) : g.moveTo(X(p.x), X(p.z))));
      g.stroke();
    }
  }
  g.setLineDash([]);
  // Asphalt grain.
  for (let k = 0; k < 4000; k++) {
    g.fillStyle = `rgba(${rand() < 0.5 ? '30,30,30' : '200,200,200'},0.04)`;
    g.fillRect(rand() * N, rand() * N, 2, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  return tex;
}

/** Overcast storm sky: warm grey horizon darkening upwards, with drifting cloud masses. */
function createSkyDome(horizon: THREE.Color) {
  const geo = new THREE.SphereGeometry(2500, 48, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { uTime: { value: 0 }, uHorizon: { value: horizon }, uTop: { value: new THREE.Color(0x6f716f) } },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uHorizon;
      uniform vec3 uTop;
      varying vec3 vDir;
      float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
      }
      float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.0; a *= 0.5; } return v; }
      void main() {
        float h = max(vDir.y, 0.0);
        vec3 col = mix(uHorizon, uTop, smoothstep(0.0, 0.6, h));
        vec2 uv = vDir.xz / (vDir.y + 0.15) * 1.5 + vec2(uTime * 0.012, uTime * 0.006);
        float c = smoothstep(0.45, 0.8, fbm(uv));
        col = mix(col, col * 0.72, c * smoothstep(0.02, 0.25, h));
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -1;
  return { mesh, update: (t: number) => (mat.uniforms.uTime.value = t), dispose: () => (geo.dispose(), mat.dispose()) };
}

/**
 * Street-level scene (1 unit = 1 m) around the resident's home: a town neighbourhood on the real
 * ground slope, floodwater at the model's level, and a landslide if a flagged slope is close.
 */
export function createStreet(opts: {
  renderer: THREE.WebGLRenderer;
  hm: Heightmap;
  hy: Hydrology;
  home: LngLat;
  homeCell: number;
  houses: House[];
  lanes: Lane[];
  slides: SlideSource[];
  homeLabel: string;
  slideLabels: { warn: string; active: string };
}) {
  const { hm, hy, home, homeCell, houses } = opts;
  const scene = new THREE.Scene();
  const sky = new THREE.Color(0xd2cdc3);
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, 250, 1100);
  const dome = createSkyDome(sky);
  scene.add(dome.mesh);
  const pmrem = new THREE.PMREMGenerator(opts.renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = env;
  scene.environmentIntensity = 0.55;
  scene.add(new THREE.HemisphereLight(0xe8eef4, 0x4d5a40, 1.15));
  const sun = new THREE.DirectionalLight(0xfff1dc, 1.7);
  sun.position.set(-160, 190, 120);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -320;
  sun.shadow.camera.right = sun.shadow.camera.top = 320;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 800;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.5;
  sun.shadow.radius = 3;
  scene.add(sun);
  const disposables: { dispose(): void }[] = [env, pmrem, dome];

  const { toLngLat, toLocal } = localFrame(home);
  // Ground = the depression-filled surface the flood model uses, so street depths match the card.
  const groundAbs = (x: number, z: number) => {
    const { gx, gy } = gridCoords(hm, toLngLat(x, z));
    const e = sampleField(hm, hy.filledM, gx, gy);
    return Number.isNaN(e) ? 0 : Math.max(e, 0);
  };
  const ground0 = groundAbs(0, 0);
  const groundY = (x: number, z: number) => groundAbs(x, z) - ground0;

  let ref = -1;
  for (const i of neighbourhood(hm, homeCell, 3)) {
    if (hy.drainElevM[i] === NO_DRAIN_M || hy.seaMask[i]) continue;
    const hand = hy.filledM[i] - hy.drainElevM[i];
    if (ref < 0 || hand < hy.filledM[ref] - hy.drainElevM[ref]) ref = i;
  }
  const waterAbs = (hour: number) => (ref < 0 ? -Infinity : hy.drainElevM[ref] + stageM(hour) * hy.stageScale[ref]);

  // Ground.
  const groundGeo = new THREE.PlaneGeometry(GROUND_M, GROUND_M, 180, 180).rotateX(-Math.PI / 2);
  const gp = groundGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < gp.count; i++) gp.setY(i, groundY(gp.getX(i), gp.getZ(i)));
  groundGeo.computeVertexNormals();
  const groundTex = groundTexture(houses, opts.lanes, homeCell);
  const groundMat = new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1 });
  const groundMesh = new THREE.Mesh(groundGeo, groundMat);
  groundMesh.receiveShadow = true;
  scene.add(groundMesh);
  disposables.push(groundGeo, groundMat, groundTex);

  // Houses and plants.
  const built = createHouses(houses, groundY, homeCell);
  scene.add(built.group);
  const veg = createVegetation(houses, opts.lanes, groundY, homeCell, 650);
  scene.add(veg.group);
  disposables.push(built, veg);

  // Water.
  const water = createStreetWater(houses, sky, { near: 250, far: 1100 }, groundY);
  scene.add(water.mesh);
  disposables.push(water);

  const homeIdx = houses.reduce((best, h, i) => (Math.hypot(h.x, h.z) < Math.hypot(houses[best].x, houses[best].z) ? i : best), 0);
  const homeHouse = houses[homeIdx];

  // JPS-style staff gauges: one at the home's front, two on nearby compounds.
  const gaugeTex = staffGaugeTexture();
  const boardMat = new THREE.MeshStandardMaterial({ map: gaugeTex, roughness: 0.6 });
  const postMat = new THREE.MeshStandardMaterial({ color: 0x3b3b38, roughness: 0.7 });
  const boardGeo = new THREE.BoxGeometry(0.3, 5, 0.03).translate(0, 2.5, 0);
  const postGeo = new THREE.BoxGeometry(0.1, 5.6, 0.1).translate(0, 2.5, -0.06);
  disposables.push(gaugeTex, boardMat, postMat, boardGeo, postGeo);
  const near = houses.map((h, i) => ({ h, i, d: Math.hypot(h.x, h.z) })).sort((a, b) => a.d - b.d);
  for (const { h } of [near[0], near[4], near[9]].filter(Boolean)) {
    const fx = h.x + Math.sin(h.angle) * (h.d / 2 + 4.5) + Math.cos(h.angle) * (h.w / 2 - 1);
    const fz = h.z + Math.cos(h.angle) * (h.d / 2 + 4.5) - Math.sin(h.angle) * (h.w / 2 - 1);
    const g = new THREE.Group();
    g.add(new THREE.Mesh(boardGeo, boardMat), new THREE.Mesh(postGeo, postMat));
    g.position.set(fx, groundY(fx, fz), fz);
    g.rotation.y = h.angle;
    g.traverse((o) => (o.castShadow = true));
    scene.add(g);
  }

  // Landslide: the flagged slope whose runout passes closest to home, if close enough.
  let slide: ReturnType<typeof createStreetSlide> | null = null;
  let best: { s: SlideSource; d: number; pts: { x: number; z: number }[] } | null = null;
  for (const s of opts.slides) {
    const pts = s.path.map((cell) => {
      const r = Math.floor(cell / hm.cols);
      return toLocal(cellLngLat(hm, cell - r * hm.cols, r));
    });
    const d = Math.min(...pts.map((p) => Math.hypot(p.x, p.z)));
    // Only the stretch of the runout that comes down into the neighbourhood.
    const first = pts.findIndex((p) => Math.hypot(p.x, p.z) <= SLIDE_CLIP_M);
    const near = first < 0 ? [] : pts.slice(first).filter((p) => Math.hypot(p.x, p.z) <= SLIDE_CLIP_M + 50);
    if (d < SLIDE_MAX_M && near.length >= 3 && (!best || d < best.d)) best = { s, d, pts: near };
  }
  if (best && best.pts.length >= 3) {
    let triggerHour = Infinity;
    for (let h = 0; h <= REPLAY_HOURS; h += 0.25) if (rainAccumulated(h) >= best.s.triggerRainAcc) { triggerHour = h; break; }
    slide = createStreetSlide({ path: best.pts, groundY, triggerHour, sky, labels: opts.slideLabels });
    scene.add(slide.group);
    disposables.push(slide);
  }

  // Houses in the debris path, and how far down the path each is reached.
  const MUD = new THREE.Color(0x6b4a2e);
  const hitU = houses.map((h) => (slide ? slide.hitAt(h.x, h.z, Math.max(h.w, h.d) * 0.4) : null));
  const buried = houses.map(() => false);
  let buriedCount = 0;

  // "Your home" label with live depth.
  const el = document.createElement('div');
  el.className = 'place-label home street-home';
  const label = new CSS2DObject(el);
  label.center.set(0.5, 1);
  label.position.set(homeHouse.x, built.roofTop[homeIdx] + 2, homeHouse.z);
  scene.add(label);

  let lastHour = NaN;
  let level = -Infinity;
  let homeDepthNow = 0;
  const bands = houses.map(() => -1);
  return {
    scene,
    get level() {
      return level;
    },
    /** Ground height (local m) — to keep the camera out of hillsides. */
    groundAt: groundY,
    get buried() {
      return buriedCount;
    },
    get slideSurging() {
      return slide?.surging ?? false;
    },
    /** Landslide path midpoint (local m) if one is shown, for camera framing. */
    slideMid: slide?.mid ?? null,
    homeFocus: new THREE.Vector3(homeHouse.x, groundY(homeHouse.x, homeHouse.z) + 3, homeHouse.z),
    /** Unit vector from the home towards its street frontage. */
    homeFront: new THREE.Vector3(Math.sin(homeHouse.angle), 0, Math.cos(homeHouse.angle)),
    counts: { osm: houses.filter((h) => h.source === 'osm').length, illustrative: houses.filter((h) => h.source === 'illustrative').length },
    /** Every frame: waves, clouds, landslide. */
    animate(hour: number, timeS: number) {
      dome.update(timeS);
      slide?.update(hour, timeS);
      if (slide) {
        const r = slide.reveal;
        houses.forEach((_, i) => {
          const hit = hitU[i] !== null && hour >= 0 && r > 0 && r >= hitU[i]!;
          if (hit === buried[i]) return;
          buried[i] = hit;
          buriedCount += hit ? 1 : -1;
          if (hit) built.setRoofTint(i, MUD, 0.85);
          else bands[i] = -2; // force the flood tint to be re-applied
        });
        if (buriedCount === 0 && r === 0) lastHour = NaN;
      }
      water.mesh.visible = Number.isFinite(level);
      if (water.mesh.visible) water.update(level, homeDepthNow, timeS);
    },
    /** When the replay hour changes: water level and roof tints. */
    update(hour: number) {
      if (hour === lastHour) return null;
      lastHour = hour;
      level = waterAbs(hour) - ground0;
      let wet = 0;
      houses.forEach((h, i) => {
        const depth = Number.isFinite(level) ? level - groundY(h.x, h.z) : 0;
        const band = DEPTH_BANDS.findIndex((b) => depth <= b.max);
        if (band !== bands[i] && !buried[i]) {
          bands[i] = band;
          built.setRoofTint(i, DEPTH_BANDS[band].color);
        }
        if (depth > 0.05) wet++;
        if (i === homeIdx) homeDepthNow = depth;
      });
      el.textContent = homeDepthNow > 0.05 ? `${opts.homeLabel} · ${homeDepthNow.toFixed(1)} m of water` : `${opts.homeLabel} · dry`;
      el.classList.toggle('wet', homeDepthNow > 0.05);
      return { wet, total: houses.length, homeDepth: homeDepthNow, buried: buriedCount };
    },
    dispose() {
      for (const d of disposables) d.dispose();
      el.remove();
    },
  };
}
