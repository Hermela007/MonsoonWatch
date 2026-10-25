import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { LngLat } from '../geo/region';
import { cellLngLat, gridCoords, sampleField, type Heightmap } from '../terrain/heightmap';
import { NO_DRAIN_M, type Hydrology } from '../terrain/hydrology';
import { neighbourhood } from '../terrain/homeRisk';
import { triggerRainMm, type SlideSource } from '../terrain/landslide';
import { localFrame, type House, type Lane } from '../data/buildings';
import type { AreaData } from '../data/areas';
import { staffGaugeTexture } from '../data/textures';
import { REPLAY_HOURS, rainAccumulated, stageM } from '../data/replay2014';
import { createStreetWater, streetReplayRate } from './streetWater';
import { createRealBuildings, type Footprint } from './realBuildings';
import { addSlideGround, createStreetSlide, slideGroundUniforms } from './streetSlide';
import { addUnderwater, waterUniforms } from './underwater';
import { THEME } from '../theme';

const GROUND_M = 2200;
const SLIDE_MAX_M = 1000; // show a landslide in the street if its path passes this close to home
const SLIDE_CLIP_M = 700; // ...drawing the part of it within this distance (the card's 'hillside N m away')

// Roof tint = water at the house (m).
export const DEPTH_BANDS = [
  { max: 0.05, color: null, label: 'Dry' },
  { max: 0.5, color: new THREE.Color(0xd4ecf8), label: 'Up to 0.5 m' },
  { max: 1.5, color: new THREE.Color(0x8fc9ea), label: '0.5–1.5 m' },
  { max: Infinity, color: THEME.flood, label: 'Over 1.5 m' },
] as const;

const ROAD_WIDTH_M: Record<string, number> = {
  motorway: 14, trunk: 12, primary: 11, secondary: 9, tertiary: 8, unclassified: 6, residential: 6, living_street: 5, service: 4, track: 3, path: 1.5, footway: 1.5,
};

/** Plan drawing: off-white ground, real roads as slightly darker bands, building footprints outlined. */
function groundTexture(roads: { kind: string; pts: { x: number; z: number }[] }[], prints: { x: number; z: number }[][]) {
  const N = 4096;
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d')!;
  const s = N / GROUND_M;
  const X = (x: number) => (x / GROUND_M + 0.5) * N;
  g.fillStyle = '#f1efea';
  g.fillRect(0, 0, N, N);
  for (const pass of [0, 1]) {
    for (const r of roads) {
      const w = ROAD_WIDTH_M[r.kind] ?? 4;
      g.strokeStyle = pass === 0 ? 'rgba(150,143,133,0.55)' : '#e6e3dd';
      g.lineWidth = (pass === 0 ? w + 0.8 : w) * s;
      g.lineCap = g.lineJoin = 'round';
      g.beginPath();
      r.pts.forEach((p, k) => (k ? g.lineTo(X(p.x), X(p.z)) : g.moveTo(X(p.x), X(p.z))));
      g.stroke();
    }
  }
  g.fillStyle = 'rgba(150,143,133,0.25)';
  for (const ring of prints) {
    g.beginPath();
    ring.forEach((p, k) => (k ? g.lineTo(X(p.x), X(p.z)) : g.moveTo(X(p.x), X(p.z))));
    g.closePath();
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  return tex;
}

/** Oriented box (from the longest edge) of a footprint — for foam outlines and hit tests. */
function orientedBox(ring: { x: number; z: number }[]) {
  let best = 0;
  let angle = 0;
  for (let i = 1; i < ring.length; i++) {
    const dx = ring[i].x - ring[i - 1].x;
    const dz = ring[i].z - ring[i - 1].z;
    const len = Math.hypot(dx, dz);
    if (len > best) {
      best = len;
      angle = Math.atan2(-dz, dx);
    }
  }
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of ring) {
    const u = p.x * ca - p.z * sa;
    const v = p.x * sa + p.z * ca;
    minU = Math.min(minU, u); maxU = Math.max(maxU, u);
    minV = Math.min(minV, v); maxV = Math.max(maxV, v);
  }
  const cu = (minU + maxU) / 2;
  const cv = (minV + maxV) / 2;
  return { x: cu * ca + cv * sa, z: -cu * sa + cv * ca, w: maxU - minU, d: maxV - minV, angle };
}

/** Overcast storm sky: warm grey horizon darkening upwards, with drifting cloud masses. */
function createSkyDome(horizon: THREE.Color) {
  const geo = new THREE.SphereGeometry(2500, 48, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: { uTime: { value: 0 }, uHorizon: { value: horizon }, uTop: { value: new THREE.Color(0xdcd9d3) } },
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
        col = mix(col, col * 0.96, c * smoothstep(0.02, 0.25, h));
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
  /** Real buildings and roads for this area, or null if none are loaded (then none are drawn). */
  area: AreaData | null;
  slides: SlideSource[];
  homeLabel: string;
  slideLabels: { watch: string; warn: string; active: string };
}) {
  const { hm, hy, home, homeCell } = opts;
  const scene = new THREE.Scene();
  const sky = new THREE.Color(0xf4f2ee);
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, 700, 2400);
  const dome = createSkyDome(sky);
  scene.add(dome.mesh);
  const pmrem = new THREE.PMREMGenerator(opts.renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = env;
  scene.environmentIntensity = 0.55;
  scene.add(new THREE.HemisphereLight(0xffffff, 0xd9d5cd, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.3);
  sun.position.set(-160, 190, 120);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
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
  // Relief drawn 2.5× so slopes read as slopes (as on the map); depths and building heights stay true.
  const STREET_EXAG = 2.5;
  const groundY = (x: number, z: number) => (groundAbs(x, z) - ground0) * STREET_EXAG;

  // ---- Real buildings and roads -------------------------------------------------------
  const CLIP_M = 680;
  const toLoc = (ll: LngLat) => toLocal(ll);
  const prints = (opts.area?.buildings ?? [])
    .map((b) => {
      const ring = b.ring.map(toLoc);
      const box = orientedBox(ring);
      // Heights: Overture has few here; one storey (3.5 m) unless floors/height are known.
      const heightM = b.height ?? (b.floors ? b.floors * 3.3 : 3.5);
      return { ring, box, heightM, base: groundY(box.x, box.z) };
    })
    .filter((p) => Math.hypot(p.box.x, p.box.z) < CLIP_M && p.box.w < 120);
  const houses: House[] = prints.map((p) => ({ x: p.box.x, z: p.box.z, w: Math.max(p.box.w, p.box.d), d: Math.min(p.box.w, p.box.d), angle: p.box.angle, storeys: 1, heightM: p.heightM, source: 'osm', kind: 'modern' }));
  const roads = (opts.area?.roads ?? []).map((r) => ({ kind: r.kind, pts: r.line.map(toLoc) }));

  let ref = -1;
  for (const i of neighbourhood(hm, homeCell, 3)) {
    if (hy.drainElevM[i] === NO_DRAIN_M || hy.seaMask[i]) continue;
    const hand = hy.filledM[i] - hy.drainElevM[i];
    if (ref < 0 || hand < hy.filledM[ref] - hy.drainElevM[ref]) ref = i;
  }
  // Height above the river and share of the rise, smoothly sampled — the same model as the map.
  const handField = new Float32Array(hm.cols * hm.rows);
  for (let i = 0; i < handField.length; i++) {
    const d = hy.drainElevM[i];
    handField[i] = hy.seaMask[i] ? 0 : d === NO_DRAIN_M ? 200 : Math.max(0, hy.filledM[i] - d);
  }
  const handScale = (x: number, z: number): [number, number] => {
    const { gx, gy } = gridCoords(hm, toLngLat(x, z));
    const h = sampleField(hm, handField, gx, gy);
    const k = sampleField(hm, hy.stageScale, gx, gy);
    return [Number.isNaN(h) ? 200 : h, Number.isNaN(k) ? 0 : k];
  };
  const depthAtLocal = (x: number, z: number, stage: number) => {
    const [h, k] = handScale(x, z);
    return stage * k - h;
  };
  void ref;

  // Ground.
  const groundGeo = new THREE.PlaneGeometry(GROUND_M, GROUND_M, 320, 320).rotateX(-Math.PI / 2);
  const gp = groundGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < gp.count; i++) gp.setY(i, groundY(gp.getX(i), gp.getZ(i)));
  groundGeo.computeVertexNormals();
  const groundTex = groundTexture(roads, prints.map((p) => p.ring));
  const slideU = slideGroundUniforms();
  const groundMat = addSlideGround(addUnderwater(new THREE.MeshStandardMaterial({ map: groundTex, roughness: 1 }), true), slideU);
  const groundMesh = new THREE.Mesh(groundGeo, groundMat);
  groundMesh.receiveShadow = true;
  scene.add(groundMesh);
  disposables.push(groundGeo, groundMat, groundTex);

  // Real buildings.
  const built = createRealBuildings(prints.map((p): Footprint => ({ ring: p.ring, heightM: p.heightM, base: p.base - 0.3 })));
  scene.add(built.group);
  disposables.push(built);

  // Water.
  const water = createStreetWater(houses, sky, { near: 250, far: 1100 }, groundY, handScale, roads);
  waterUniforms.uWaterGround.value = water.textures.ground;
  waterUniforms.uWaterHand.value = water.textures.hand;
  scene.add(water.mesh);
  disposables.push(water);

  // "Your home": the real building nearest the chosen point (within 60 m), else just the point.
  let homeIdx = -1;
  houses.forEach((h, i) => {
    const d = Math.hypot(h.x, h.z);
    if (d < 60 && (homeIdx < 0 || d < Math.hypot(houses[homeIdx].x, houses[homeIdx].z))) homeIdx = i;
  });
  const homeHouse: House = homeIdx >= 0 ? houses[homeIdx] : { x: 0, z: 0, w: 0, d: 0, angle: 0, storeys: 1, source: 'osm', kind: 'modern' };
  const homeTop = homeIdx >= 0 ? prints[homeIdx].base + prints[homeIdx].heightM : groundY(0, 0);

  // JPS-style staff gauges: one at the home's front, two on nearby compounds.
  const gaugeTex = staffGaugeTexture();
  const boardMat = addUnderwater(new THREE.MeshStandardMaterial({ map: gaugeTex, roughness: 0.6 }));
  const postMat = addUnderwater(new THREE.MeshStandardMaterial({ color: 0x1d1d1b, roughness: 0.7 }));
  const boardGeo = new THREE.BoxGeometry(0.3, 5, 0.03).translate(0, 2.5, 0);
  const postGeo = new THREE.BoxGeometry(0.1, 5.6, 0.1).translate(0, 2.5, -0.06);
  // Adult figure, 1.7 m: torso and legs as one capsule (0–1.44 m), head above.
  const personBodyGeo = new THREE.CapsuleGeometry(0.2, 1.04, 4, 10).translate(0, 0.72, 0);
  const personHeadGeo = new THREE.SphereGeometry(0.12, 12, 8).translate(0, 1.58, 0);
  disposables.push(gaugeTex, boardMat, postMat, boardGeo, postGeo, personBodyGeo, personHeadGeo);
  const near = houses.map((h, i) => ({ h, i, d: Math.hypot(h.x, h.z) })).sort((a, b) => a.d - b.d);
  // One depth gauge (a measuring aid, not a real object) at the home.
  for (const { h } of [near[0]].filter(Boolean).filter(() => homeIdx >= 0).map(() => ({ h: homeHouse }))) {
    const fx = h.x + Math.sin(h.angle) * (h.d / 2 + 4.5) + Math.cos(h.angle) * (h.w / 2 - 1);
    const fz = h.z + Math.cos(h.angle) * (h.d / 2 + 4.5) - Math.sin(h.angle) * (h.w / 2 - 1);
    const g = new THREE.Group();
    g.add(new THREE.Mesh(boardGeo, boardMat), new THREE.Mesh(postGeo, postMat));
    g.position.set(fx, groundY(fx, fz), fz);
    g.rotation.y = h.angle;
    // A 1.7 m adult beside the gauge: depth in human terms (knee, waist, over the head).
    const person = new THREE.Group();
    const body = new THREE.Mesh(personBodyGeo, postMat);
    const head = new THREE.Mesh(personHeadGeo, postMat);
    person.add(body, head);
    person.position.set(1.1, 0, 0.25);
    g.add(person);
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
    if (pts.length < 2) continue;
    // Densify (terrain cells are ~250 m apart) so the drawn stretch follows the runout smoothly.
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p.x, 0, p.z)), false, 'centripetal');
    const dense = curve.getSpacedPoints(Math.max(8, Math.round(curve.getLength() / 25))).map((v) => ({ x: v.x, z: v.z }));
    const d = Math.min(...dense.map((p) => Math.hypot(p.x, p.z)));
    // Only the stretch of the runout that comes down into the neighbourhood — reaching a little past its
    // closest point, so a slope ~1 km out (still within the screening's 1 km rule) is drawn too.
    const clip = Math.max(SLIDE_CLIP_M, d + 350);
    const first = dense.findIndex((p) => Math.hypot(p.x, p.z) <= clip);
    const near = first < 0 ? [] : dense.slice(first).filter((p) => Math.hypot(p.x, p.z) <= clip + 50);
    if (d < SLIDE_MAX_M && near.length >= 6 && (!best || d < best.d)) best = { s, d, pts: near };
  }
  if (best && best.pts.length >= 3) {
    // A landslide street is framed wide (crown to toe, ~1 km), so the haze starts further out.
    if (scene.fog instanceof THREE.Fog) [scene.fog.near, scene.fog.far] = [1300, 3400];
    slide = createStreetSlide({ path: best.pts, groundY, triggerMm: best.s.triggerMm ?? triggerRainMm(best.s.slopeDeg), sky, risk: THEME.slide, labels: opts.slideLabels, groundUniforms: slideU, fogRange: [1300, 3400] });
    scene.add(slide.group);
    disposables.push(slide);
  }

  // Houses in the debris path, and how far down the path each is reached.
  const MUD = THEME.slide;
  const hitU = houses.map((h) => (slide ? slide.hitAt(h.x, h.z, Math.max(h.w, h.d) * 0.4) : null));
  const buried = houses.map(() => false);
  let buriedCount = 0;

  // "Your home" label with live depth.
  const el = document.createElement('div');
  el.className = 'place-label home street-home';
  const label = new CSS2DObject(el);
  label.center.set(0.5, 1);
  label.position.set(homeHouse.x, homeTop + 3, homeHouse.z);
  scene.add(label);

  let lastHour = NaN;
  let level = -Infinity;
  let stageNow = 0;
  // Per-building height above the river and share of the rise (fixed; depth = stage × share − height).
  const bHS = houses.map((h) => handScale(h.x, h.z));
  let homeDepthNow = 0;
  const bands = houses.map(() => -1);
  return {
    scene,
    get level() {
      return level;
    },
    /** Earliest replay hour any building here gets water (for a playback that starts dry), or null. */
    firstWetHour(): number | null {
      for (let h = 0; h <= REPLAY_HOURS; h += 1) {
        const s = stageM(h);
        if (bHS.some(([hh, k]) => s * k - hh > 0.05)) return h;
      }
      return null;
    },
    /** Slow the visual replay at first inundation so metres of rise do not flash past in one second.
     * This changes playback speed only; each displayed depth still comes from stageM at that time. */
    replayRate(hour: number) {
      const before = depthAtLocal(homeHouse.x, homeHouse.z, stageM(hour));
      const after = depthAtLocal(homeHouse.x, homeHouse.z, stageM(hour + .25));
      return streetReplayRate(before, after);
    },
    /** Ground height (local m) — to keep the camera out of hillsides. */
    groundAt: groundY,
    get buried() {
      return buriedCount;
    },
    /** Landslide focus for the follow camera; false when nothing is happening yet. */
    slideFocus(out: THREE.Vector3, dir: THREE.Vector3) {
      return slide ? slide.focus(out, dir) : false;
    },
    /** True once when the slope fails (camera shake). */
    slideFailedNow() {
      return slide?.consumeFailure() ?? false;
    },
    /** Landslide path midpoint (local m) if one is shown, for camera framing. */
    slideMid: slide?.mid ?? null,
    slideHead: slide?.head ?? null,
    slideToe: slide?.toe ?? null,
    get slideState() {
      return slide?.state ?? 'quiet';
    },
    /** A point on the landslide centreline (u = 0 crown … 1 toe), or null without a slide. */
    slideAt(u: number, out: THREE.Vector3) {
      return slide ? slide.at(u, out) : null;
    },
    get slideSurging() {
      return slide?.surging ?? false;
    },
    homeFocus: new THREE.Vector3(homeHouse.x, groundY(homeHouse.x, homeHouse.z) + 3, homeHouse.z),
    /** Unit vector from the home towards its street frontage. */
    homeFront: new THREE.Vector3(Math.sin(homeHouse.angle), 0, Math.cos(homeHouse.angle)),
    counts: { osm: houses.length, illustrative: 0 },
    /** True when no real building data covers this place. */
    noBuildings: houses.length === 0,
    /** Every frame: waves, clouds, landslide. */
    animate(hour: number, timeS: number) {
      dome.update(timeS);
      waterUniforms.uWaterStage.value = stageNow;
      waterUniforms.uWaterTime.value = timeS;
      slide?.update(hour, timeS);
      if (slide) {
        const r = slide.reveal;
        houses.forEach((_, i) => {
          const hit = hitU[i] !== null && hour >= 0 && r > 0 && r >= hitU[i]!;
          if (hit === buried[i]) return;
          buried[i] = hit;
          buriedCount += hit ? 1 : -1;
          if (hit) built.setTint(i, MUD, 0.85);
          else bands[i] = -2; // force the flood tint to be re-applied
        });
        if (buriedCount === 0 && r === 0) lastHour = NaN;
      }
      water.update(stageNow, timeS);
    },
    /** When the replay hour changes: water level and roof tints. */
    update(hour: number) {
      if (hour === lastHour) return null;
      lastHour = hour;
      stageNow = stageM(hour);
      let wet = 0;
      houses.forEach((h, i) => {
        const depth = stageNow * bHS[i][1] - bHS[i][0];
        // No whole-building tint: buildings get a silt tint only below the real waterline (underwater
        // shader), so the water is seen climbing the walls — smooth, and physically right.
        void bands;
        if (depth > 0.05) wet++;
        if (i === homeIdx) homeDepthNow = depth;
      });
      if (homeIdx < 0) homeDepthNow = depthAtLocal(0, 0, stageNow);
      // Water surface at the home (for keeping the camera above it).
      level = homeDepthNow > 0 ? groundY(homeHouse.x, homeHouse.z) + homeDepthNow : -Infinity;
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
