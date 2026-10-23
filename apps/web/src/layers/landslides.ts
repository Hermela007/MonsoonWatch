import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { GeoFrame } from '../geo/region';
import { cellLngLat, type Heightmap } from '../terrain/heightmap';
import type { SlideSource } from '../terrain/landslide';
import { REPLAY_HOURS, rainAccumulated } from '../mock/replay2014';

const REVEAL_HOURS = 5; // debris path draws out over this many replay hours once a slope is flagged
const PARTICLES_PER_PATH = 14;
const WATCH = 0xe0a030; // flagged as susceptible, not yet triggered
const ACTIVE = 0xd9502e; // enough rain has fallen

const tubeVertex = /* glsl */ `
varying vec2 vUv;
varying float vViewDist;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const tubeFragment = /* glsl */ `
uniform float uReveal;
uniform float uActive;
uniform float uTime;
uniform vec3 uFogCol;
uniform float uFogDensity;
varying vec2 vUv;
varying float vViewDist;
void main() {
  if (vUv.x > uReveal) discard;
  vec3 watch = vec3(0.88, 0.63, 0.19);
  float flow = fract(vUv.x * 10.0 - uTime * 1.2);
  float band = smoothstep(0.0, 0.25, flow) * smoothstep(1.0, 0.55, flow);
  vec3 failing = mix(vec3(0.55, 0.22, 0.1), vec3(0.95, 0.42, 0.16), band); // ('active' is reserved in GLSL)
  failing += smoothstep(uReveal - 0.08, uReveal, vUv.x) * vec3(0.4, 0.25, 0.1);
  vec3 col = mix(watch, failing, uActive);
  float fog = 1.0 - exp(-pow(uFogDensity * vViewDist, 2.0));
  gl_FragColor = vec4(mix(col, uFogCol, fog), mix(0.75, 1.0, uActive));
}
`;

/** Landslide element: a beacon on each susceptible slope and its debris runout downhill. */
export function createLandslides(
  sources: SlideSource[],
  hm: Heightmap,
  frame: GeoFrame,
  fogColor: THREE.Color,
  opts: { tubeRadiusKm?: number; labelled?: number; labelText?: string; labelSpacingKm?: number } = {},
) {
  const group = new THREE.Group();
  const beaconGeo = new THREE.ConeGeometry(0.09, 0.26, 4).rotateX(Math.PI);
  const ringGeo = new THREE.RingGeometry(0.12, 0.16, 40).rotateX(-Math.PI / 2);
  const owned: { dispose(): void }[] = [beaconGeo, ringGeo];
  const labelEls: HTMLElement[] = [];

  const triggerHour = (acc: number) => {
    for (let h = 0; h <= REPLAY_HOURS; h += 0.25) if (rainAccumulated(h) >= acc) return h;
    return Infinity;
  };

  const labelledAt: THREE.Vector3[] = [];
  const labelObjs: CSS2DObject[] = [];
  const slides = sources.map((s) => {
    const pts = s.path.map((cell) => {
      const r = Math.floor(cell / hm.cols);
      const p = frame.lngLatToWorld(cellLngLat(hm, cell - r * hm.cols, r), hm.elevM[cell]);
      p.y += 0.06;
      return p;
    });
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const tubeGeo = new THREE.TubeGeometry(curve, Math.max(16, pts.length * 3), opts.tubeRadiusKm ?? 0.07, 6, false);
    const tubeMat = new THREE.ShaderMaterial({
      vertexShader: tubeVertex,
      fragmentShader: tubeFragment,
      transparent: true,
      uniforms: {
        uReveal: { value: 1 },
        uActive: { value: 0 },
        uTime: { value: 0 },
        uFogCol: { value: fogColor },
        uFogDensity: { value: 0.0022 },
      },
    });
    const beaconMat = new THREE.MeshBasicMaterial({ color: WATCH });
    const ringMat = new THREE.MeshBasicMaterial({ color: ACTIVE, transparent: true, depthWrite: false });
    owned.push(tubeGeo, tubeMat, beaconMat, ringMat);
    const tube = new THREE.Mesh(tubeGeo, tubeMat);

    const marker = new THREE.Group();
    marker.position.copy(pts[0]);
    const beacon = new THREE.Mesh(beaconGeo, beaconMat);
    const ring = new THREE.Mesh(ringGeo, ringMat);
    marker.add(beacon, ring);
    const spaced = labelledAt.every((p) => p.distanceTo(pts[0]) > (opts.labelSpacingKm ?? 0));
    if (labelledAt.length < (opts.labelled ?? 0) && spaced) {
      labelledAt.push(pts[0]);
      const el = document.createElement('div');
      el.className = 'slide-label';
      el.textContent = opts.labelText ?? 'Landslide risk';
      labelEls.push(el);
      const label = new CSS2DObject(el);
      label.center.set(0.5, 1.3);
      label.position.y = 0.4;
      marker.add(label);
      labelObjs.push(label);
    }
    group.add(tube, marker);
    return { source: s, curve, tube, tubeMat, beacon, beaconMat, ring, ringMat, marker, start: triggerHour(s.triggerRainAcc) };
  });

  const particlePos = new Float32Array(slides.length * PARTICLES_PER_PATH * 3);
  const particleGeo = new THREE.BufferGeometry();
  particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePos, 3));
  const particleMat = new THREE.PointsMaterial({ color: 0x7a4a26, size: 0.16, sizeAttenuation: true, transparent: true, depthWrite: false });
  owned.push(particleGeo, particleMat);
  const particles = new THREE.Points(particleGeo, particleMat);
  particles.frustumCulled = false;
  group.add(particles);

  // Dust plume where a slope fails: a soft brown cloud that billows up and fades.
  const plumeTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    grad.addColorStop(0, 'rgba(150,118,84,0.85)');
    grad.addColorStop(0.6, 'rgba(150,118,84,0.35)');
    grad.addColorStop(1, 'rgba(150,118,84,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  })();
  owned.push(plumeTex);
  const plumes = slides.map((sl) => {
    const mat = new THREE.SpriteMaterial({ map: plumeTex, transparent: true, depthWrite: false });
    owned.push(mat);
    const sp = new THREE.Sprite(mat);
    sp.position.copy(sl.marker.position);
    group.add(sp);
    return { sp, mat };
  });

  const tmp = new THREE.Vector3();
  return {
    group,
    sources,
    update(hour: number, cameraDistance: number, timeS: number) {
      const size = THREE.MathUtils.clamp(cameraDistance * 0.05, 0.8, 9);
      let active = 0;
      slides.forEach((sl, si) => {
        const on = hour >= sl.start;
        if (on) active++;
        const reveal = on ? THREE.MathUtils.clamp((hour - sl.start) / REVEAL_HOURS, 0.02, 1) : 1;
        sl.tubeMat.uniforms.uReveal.value = reveal;
        sl.tubeMat.uniforms.uActive.value = on ? 1 : 0;
        sl.tubeMat.uniforms.uTime.value = timeS;
        sl.beaconMat.color.setHex(on ? ACTIVE : WATCH);
        sl.marker.scale.setScalar(size);
        sl.beacon.position.y = 0.32 + 0.05 * Math.sin(timeS * 3 + si);
        sl.beacon.rotation.y = timeS * 1.5;
        sl.ring.visible = on;
        const p = (timeS * 0.8 + si * 0.37) % 1;
        sl.ring.scale.setScalar(1 + p * 2.2);
        sl.ringMat.opacity = 1 - p;
        for (let k = 0; k < PARTICLES_PER_PATH; k++) {
          const o = (si * PARTICLES_PER_PATH + k) * 3;
          if (!on) {
            particlePos[o + 1] = -1e4;
            continue;
          }
          const u = ((timeS * 0.12 + k / PARTICLES_PER_PATH + si * 0.13) % 1) * reveal;
          sl.curve.getPointAt(u, tmp);
          particlePos.set([tmp.x, tmp.y + 0.03, tmp.z], o);
        }
      });
      particleGeo.attributes.position.needsUpdate = true;
      slides.forEach((sl, si) => {
        const age = hour - sl.start;
        const { sp, mat } = plumes[si];
        sp.visible = age >= 0 && age < 8;
        if (!sp.visible) return;
        const k = THREE.MathUtils.clamp(age / 8, 0, 1);
        sp.scale.setScalar(size * (1.5 + 5 * Math.sqrt(k)));
        sp.position.copy(sl.marker.position);
        sp.position.y += size * (0.5 + 1.5 * k);
        mat.opacity = (1 - k) * 0.85;
      });
      particleMat.size = 0.16 * Math.max(1, cameraDistance / 25);
      for (const el of labelEls) el.classList.toggle('active', active > 0);
      return { active, total: slides.length };
    },
    setLabelsVisible(v: boolean) {
      for (const l of labelObjs) l.visible = v;
    },
    setVisible(v: boolean) {
      group.visible = v;
    },
    dispose() {
      owned.forEach((o) => o.dispose());
      labelEls.forEach((el) => el.remove());
    },
  };
}
