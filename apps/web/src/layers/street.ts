import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { LngLat } from '../geo/region';
import { gridCoords, sampleField, type Heightmap } from '../terrain/heightmap';
import type { Hydrology } from '../terrain/hydrology';
import { NO_DRAIN_M } from '../terrain/hydrology';
import { neighbourhood } from '../terrain/homeRisk';
import { localFrame, rng, type House } from '../data/buildings';
import { stageM } from '../mock/replay2014';
import { createStreetWater } from './streetWater';

const SIZE_M = 1400;
const WALL_M = { 1: 3.4, 2: 6.4 } as const;
const RULER_M = 6;
const RULERS = 10;

// Roof colour = water at the house (m).
export const DEPTH_BANDS = [
  { max: 0.05, color: 0x9aa3ad, label: 'Dry' },
  { max: 0.5, color: 0xf3e66b, label: 'Up to 0.5 m' },
  { max: 1.5, color: 0xf5b13d, label: '0.5–1.5 m' },
  { max: Infinity, color: 0xe8483a, label: 'Over 1.5 m' },
] as const;

function rulerTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 512;
  const g = c.getContext('2d')!;
  const pxPerM = c.height / RULER_M;
  g.fillStyle = '#111';
  g.fillRect(6, 0, 3, c.height);
  g.font = 'bold 22px system-ui, sans-serif';
  for (let q = 1; q < RULER_M * 4; q++) {
    const y = c.height - q * (pxPerM / 4);
    const major = q % 4 === 0;
    g.fillRect(6, y - 1, major ? 26 : 14, major ? 3 : 2);
    if (major) g.fillText(`${q / 4} m`, 30, y + 8);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function roofGeometry(w: number, d: number, rise: number) {
  const oh = 0.6;
  const shape = new THREE.Shape([
    new THREE.Vector2(-d / 2 - oh, 0),
    new THREE.Vector2(d / 2 + oh, 0),
    new THREE.Vector2(0, rise),
  ]);
  const g = new THREE.ExtrudeGeometry(shape, { depth: w + oh * 2, bevelEnabled: false });
  g.rotateY(Math.PI / 2);
  g.translate(-(w / 2 + oh), 0, 0);
  return g;
}

/** Overcast storm sky: warm grey horizon darkening upwards, with drifting cloud masses. */
function createSkyDome(horizon: THREE.Color) {
  const geo = new THREE.SphereGeometry(2500, 48, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
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
  return {
    mesh,
    update(t: number) {
      mat.uniforms.uTime.value = t;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}

/**
 * Street-level scene (1 unit = 1 m) around the resident's home: houses, ground from the DEM,
 * and a flat flood surface at the model's local water level.
 */
export function createStreet(opts: {
  renderer: THREE.WebGLRenderer;
  hm: Heightmap;
  hy: Hydrology;
  home: LngLat;
  homeCell: number;
  houses: House[];
  homeLabel: string;
}) {
  const { hm, hy, home, homeCell, houses } = opts;
  const scene = new THREE.Scene();
  const sky = new THREE.Color(0xd2cdc3); // horizon colour; the dome darkens upwards
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, 250, 1100);
  const dome = createSkyDome(sky);
  scene.add(dome.mesh);
  const pmrem = new THREE.PMREMGenerator(opts.renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = env;
  scene.environmentIntensity = 0.6;
  scene.add(new THREE.HemisphereLight(0xe6edf5, 0x46523f, 1.2));
  const sun = new THREE.DirectionalLight(0xfff4e2, 1.6);
  sun.position.set(-160, 180, 120);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = sun.shadow.camera.bottom = -260;
  sun.shadow.camera.right = sun.shadow.camera.top = 260;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 700;
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.6;
  sun.shadow.radius = 4;
  scene.add(sun);
  const disposables: { dispose(): void }[] = [env, pmrem, dome];

  const { toLngLat } = localFrame(home);
  // Ground = the depression-filled surface the flood model uses, so street depths match the card.
  const groundAbs = (x: number, z: number) => {
    const { gx, gy } = gridCoords(hm, toLngLat(x, z));
    const e = sampleField(hm, hy.filledM, gx, gy);
    return Number.isNaN(e) ? 0 : Math.max(e, 0);
  };
  const ground0 = groundAbs(0, 0);
  const groundY = (x: number, z: number) => groundAbs(x, z) - ground0;

  // Water reference: the most river-connected cell around the home.
  let ref = -1;
  for (const i of neighbourhood(hm, homeCell, 3)) {
    if (hy.drainElevM[i] === NO_DRAIN_M || hy.seaMask[i]) continue;
    const hand = hy.filledM[i] - hy.drainElevM[i];
    if (ref < 0 || hand < hy.filledM[ref] - hy.drainElevM[ref]) ref = i;
  }
  const waterAbs = (hour: number) => (ref < 0 ? -Infinity : hy.drainElevM[ref] + stageM(hour) * hy.stageScale[ref]);

  // Ground.
  const groundGeo = new THREE.PlaneGeometry(SIZE_M, SIZE_M, 140, 140).rotateX(-Math.PI / 2);
  const gp = groundGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < gp.count; i++) gp.setY(i, groundY(gp.getX(i), gp.getZ(i)));
  groundGeo.computeVertexNormals();
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x6f7d5c, roughness: 1 });
  const groundMesh = new THREE.Mesh(groundGeo, groundMat);
  groundMesh.receiveShadow = true;
  scene.add(groundMesh);
  disposables.push(groundGeo, groundMat);

  // Water: animated waves (Gerstner) with foam on crests and against walls.
  const water = createStreetWater(houses, sky, { near: 250, far: 1100 }, groundY);
  scene.add(water.mesh);
  disposables.push(water);

  // Houses.
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xf2f1ec, roughness: 0.85 });
  const rulerMat = new THREE.MeshBasicMaterial({ map: rulerTexture(), transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const rulerGeo = new THREE.PlaneGeometry(0.9, RULER_M).translate(0.45, RULER_M / 2, 0);
  disposables.push(wallMat, rulerMat, rulerMat.map!, rulerGeo);

  const homeIdx = houses.reduce((best, h, i) => (Math.hypot(h.x, h.z) < Math.hypot(houses[best].x, houses[best].z) ? i : best), 0);
  const byDistance = houses.map((h, i) => ({ i, d: Math.hypot(h.x, h.z) })).sort((a, b) => a.d - b.d);
  const withRuler = new Set(byDistance.slice(0, RULERS).map((x) => x.i));

  const items = houses.map((h, i) => {
    const wallH = WALL_M[h.storeys];
    const base = groundY(h.x, h.z);
    const group = new THREE.Group();
    group.position.set(h.x, base, h.z);
    group.rotation.y = h.angle;
    const wallGeo = new THREE.BoxGeometry(h.w, wallH + 1.5, h.d).translate(0, (wallH - 1.5) / 2, 0);
    const roofGeo = roofGeometry(h.w, h.d, Math.min(h.d * 0.45, 3.2)).translate(0, wallH, 0);
    const roofMat = new THREE.MeshStandardMaterial({ color: DEPTH_BANDS[0].color, roughness: 0.7 });
    disposables.push(wallGeo, roofGeo, roofMat);
    const walls = new THREE.Mesh(wallGeo, i === homeIdx ? new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x333333 }) : wallMat);
    const roof = new THREE.Mesh(roofGeo, roofMat);
    walls.castShadow = walls.receiveShadow = roof.castShadow = true;
    group.add(walls, roof);
    if (withRuler.has(i)) {
      // Depth ruler on the front corner, like a flood gauge.
      const r = new THREE.Mesh(rulerGeo, rulerMat);
      r.position.set(h.w / 2 + 0.05, 0, h.d / 2 + 0.05);
      r.rotation.y = Math.PI / 4;
      group.add(r);
    }
    scene.add(group);
    return { h, base, roofMat, roofTop: wallH + Math.min(h.d * 0.45, 3.2) };
  });

  // Trees between houses.
  const rand = rng(homeCell);
  const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 4, 6).translate(0, 2, 0);
  const crownGeo = new THREE.IcosahedronGeometry(3, 0).translate(0, 5.5, 0);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5b4636, roughness: 1 });
  const crownMat = new THREE.MeshStandardMaterial({ color: 0x3f6b3a, roughness: 1, flatShading: true });
  disposables.push(trunkGeo, crownGeo, trunkMat, crownMat);
  for (let k = 0; k < 160; k++) {
    const x = (rand() - 0.5) * 700;
    const z = (rand() - 0.5) * 700;
    if (houses.some((h) => Math.hypot(h.x - x, h.z - z) < Math.max(h.w, h.d) / 2 + 3)) continue;
    const t = new THREE.Group();
    const crown = new THREE.Mesh(crownGeo, crownMat);
    crown.castShadow = true;
    t.add(new THREE.Mesh(trunkGeo, trunkMat), crown);
    t.position.set(x, groundY(x, z), z);
    t.scale.setScalar(0.8 + rand() * 0.7);
    scene.add(t);
  }

  // "Your home" label with live depth.
  const el = document.createElement('div');
  el.className = 'place-label home street-home';
  const label = new CSS2DObject(el);
  label.center.set(0.5, 1);
  const homeItem = items[homeIdx];
  label.position.set(homeItem.h.x, homeItem.base + homeItem.roofTop + 2, homeItem.h.z);
  scene.add(label);

  let lastHour = NaN;
  let level = -Infinity;
  let homeDepthNow = 0;
  return {
    scene,
    /** Current water surface in local metres (−Infinity when dry). */
    get level() {
      return level;
    },
    homeFocus: new THREE.Vector3(homeItem.h.x, homeItem.base + 2, homeItem.h.z),
    counts: { osm: houses.filter((h) => h.source === 'osm').length, illustrative: houses.filter((h) => h.source === 'illustrative').length },
    /** Updates water and roofs; returns how many houses have water and the home's depth. */
    /** Every frame: animates the waves and clouds. */
    animate(timeS: number) {
      dome.update(timeS);
      water.mesh.visible = Number.isFinite(level);
      if (water.mesh.visible) water.update(level, homeDepthNow, timeS);
    },
    update(hour: number) {
      if (hour === lastHour) return null;
      lastHour = hour;
      const w = waterAbs(hour) - ground0;
      level = w;
      let wet = 0;
      let homeDepth = 0;
      items.forEach((it, i) => {
        const depth = Number.isFinite(w) ? w - it.base : 0;
        const band = DEPTH_BANDS.find((b) => depth <= b.max)!;
        it.roofMat.color.setHex(band.color);
        if (depth > 0.05) wet++;
        if (i === homeIdx) homeDepth = depth;
      });
      homeDepthNow = homeDepth;
      el.textContent = homeDepth > 0.05 ? `${opts.homeLabel} · ${homeDepth.toFixed(1)} m of water` : `${opts.homeLabel} · dry`;
      el.classList.toggle('wet', homeDepth > 0.05);
      return { wet, total: items.length, homeDepth };
    },
    dispose() {
      for (const d of disposables) d.dispose();
      el.remove();
    },
  };
}
