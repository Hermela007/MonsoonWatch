import * as THREE from 'three';
import type { GeoFrame } from '../geo/region';
import { cellLngLat, type Heightmap } from '../terrain/heightmap';
import type { SlideSource } from '../terrain/landslide';
import { REPLAY_HOURS, rainAccumulated } from '../mock/replay2014';

const REVEAL_HOURS = 5; // debris path draws out over this many replay hours
const PARTICLES_PER_PATH = 14;

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
uniform float uTime;
uniform vec3 uFogCol;
uniform float uFogDensity;
varying vec2 vUv;
varying float vViewDist;
void main() {
  if (vUv.x > uReveal) discard;
  float flow = fract(vUv.x * 10.0 - uTime * 1.2);
  float band = smoothstep(0.0, 0.25, flow) * smoothstep(1.0, 0.55, flow);
  vec3 col = mix(vec3(0.35, 0.12, 0.04), vec3(1.0, 0.45, 0.12), band);
  col += smoothstep(uReveal - 0.08, uReveal, vUv.x) * vec3(1.0, 0.75, 0.4);
  float fog = 1.0 - exp(-pow(uFogDensity * vViewDist, 2.0));
  gl_FragColor = vec4(mix(col, uFogCol, fog), 1.0);
}
`;

/** Landslide element: source beacons + debris runouts that flow downhill once a slope is flagged. */
export function createLandslides(sources: SlideSource[], hm: Heightmap, frame: GeoFrame, fogColor: THREE.Color) {
  const group = new THREE.Group();
  const beaconGeo = new THREE.ConeGeometry(0.09, 0.26, 4).rotateX(Math.PI);
  const ringGeo = new THREE.RingGeometry(0.12, 0.16, 40).rotateX(-Math.PI / 2);
  const beaconMat = new THREE.MeshBasicMaterial({ color: 0xff6a2b });
  const owned: { dispose(): void }[] = [beaconGeo, ringGeo, beaconMat];

  const triggerHour = (acc: number) => {
    for (let h = 0; h <= REPLAY_HOURS; h += 0.25) if (rainAccumulated(h) >= acc) return h;
    return Infinity;
  };

  const slides = sources.map((s) => {
    const pts = s.path.map((cell) => {
      const r = Math.floor(cell / hm.cols);
      const p = frame.lngLatToWorld(cellLngLat(hm, cell - r * hm.cols, r), hm.elevM[cell]);
      p.y += 0.06;
      return p;
    });
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const tubeGeo = new THREE.TubeGeometry(curve, Math.max(16, pts.length * 3), 0.07, 6, false);
    const tubeMat = new THREE.ShaderMaterial({
      vertexShader: tubeVertex,
      fragmentShader: tubeFragment,
      uniforms: { uReveal: { value: 0 }, uTime: { value: 0 }, uFogCol: { value: fogColor }, uFogDensity: { value: 0.0065 } },
    });
    owned.push(tubeGeo, tubeMat);
    const tube = new THREE.Mesh(tubeGeo, tubeMat);

    const marker = new THREE.Group();
    marker.position.copy(pts[0]);
    const beacon = new THREE.Mesh(beaconGeo, beaconMat);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xff6a2b, transparent: true, depthWrite: false });
    owned.push(ringMat);
    const ring = new THREE.Mesh(ringGeo, ringMat);
    marker.add(beacon, ring);

    group.add(tube, marker);
    return { source: s, curve, tube, tubeMat, marker, beacon, ring, ringMat, start: triggerHour(s.triggerRainAcc) };
  });

  const particleCount = slides.length * PARTICLES_PER_PATH;
  const particlePos = new Float32Array(particleCount * 3);
  const particleGeo = new THREE.BufferGeometry();
  particleGeo.setAttribute('position', new THREE.BufferAttribute(particlePos, 3));
  const particleMat = new THREE.PointsMaterial({ color: 0xffb070, size: 0.16, sizeAttenuation: true, transparent: true, depthWrite: false });
  owned.push(particleGeo, particleMat);
  const particles = new THREE.Points(particleGeo, particleMat);
  particles.frustumCulled = false;
  group.add(particles);

  const tmp = new THREE.Vector3();
  return {
    group,
    /** Centroid of the first few sources, for camera shots. */
    focus(): THREE.Vector3 {
      const c = new THREE.Vector3();
      const n = Math.min(3, slides.length);
      for (let i = 0; i < n; i++) c.add(slides[i].marker.position);
      return n ? c.divideScalar(n) : c;
    },
    update(hour: number, cameraDistance: number, timeS: number) {
      const size = THREE.MathUtils.clamp(cameraDistance * 0.05, 0.8, 7);
      let active = 0;
      let reachRiver = 0;
      slides.forEach((sl, si) => {
        const reveal = THREE.MathUtils.clamp((hour - sl.start) / REVEAL_HOURS, 0, 1);
        const on = reveal > 0;
        if (on) {
          active++;
          if (sl.source.reachesRiver) reachRiver++;
        }
        sl.tube.visible = on;
        sl.tubeMat.uniforms.uReveal.value = reveal;
        sl.tubeMat.uniforms.uTime.value = timeS;
        sl.marker.visible = on;
        sl.marker.scale.setScalar(size);
        sl.beacon.position.y = 0.32 + 0.05 * Math.sin(timeS * 3 + si);
        sl.beacon.rotation.y = timeS * 1.5;
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
          particlePos[o] = tmp.x;
          particlePos[o + 1] = tmp.y + 0.03;
          particlePos[o + 2] = tmp.z;
        }
      });
      particleGeo.attributes.position.needsUpdate = true;
      particleMat.size = 0.16 * Math.max(1, cameraDistance / 25);
      return { active, total: slides.length, reachRiver };
    },
    dispose() {
      owned.forEach((o) => o.dispose());
    },
  };
}
