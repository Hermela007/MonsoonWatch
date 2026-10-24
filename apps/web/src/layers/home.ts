import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const routeVertex = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const routeFragment = /* glsl */ `
uniform float uReveal;
uniform float uTime;
uniform float uLengthKm;
varying vec2 vUv;
void main() {
  if (vUv.x > uReveal) discard;
  // Chevrons moving from home towards safety, ~one every 250 m.
  // Ink dashes marching from home towards safety.
  float s = fract(vUv.x * uLengthKm * 6.0 - uTime * 1.2);
  if (s > 0.6) discard;
  gl_FragColor = vec4(0.11, 0.11, 0.1, 1.0);
}
`;

function makeBeam(color: number, text: string, cls: string, anchorX: number, height = 1) {
  const root = new THREE.Group();
  const beamGeo = new THREE.CylinderGeometry(0.012, 0.012, 1, 8, 1, true).translate(0, 0.5, 0);
  const beamMat = new THREE.MeshBasicMaterial({ color });
  const ringGeo = new THREE.CircleGeometry(0.07, 32).rotateX(-Math.PI / 2).translate(0, 0.01, 0);
  const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false });
  const ring = new THREE.Mesh(ringGeo, ringMat);
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.scale.y = height;
  root.add(beam, ring);
  const el = document.createElement('div');
  el.className = `place-label ${cls}`;
  el.textContent = text;
  const label = new CSS2DObject(el);
  label.center.set(anchorX, 1); // home label leans left, safe label right, so they don't collide
  label.position.y = height + 0.04;
  root.add(label);
  root.visible = false;
  return {
    root,
    el,
    update(size: number, t: number) {
      root.scale.setScalar(size);
      ring.scale.setScalar(1 + 0.08 * Math.sin(t * 2));
    },
    dispose() {
      beamGeo.dispose();
      beamMat.dispose();
      ringGeo.dispose();
      ringMat.dispose();
    },
  };
}

/** "Your home" and "Higher ground" beams, and the glowing route between them. */
export function createHomeLayer() {
  const group = new THREE.Group();
  const home = makeBeam(0x1d1d1b, '', 'home', 0.5, 1);
  const safe = makeBeam(0x1d1d1b, '', 'safe', 0.5, 0.55);
  group.add(home.root, safe.root);

  const routeMat = new THREE.ShaderMaterial({
    vertexShader: routeVertex,
    fragmentShader: routeFragment,
    uniforms: { uReveal: { value: 0 }, uTime: { value: 0 }, uLengthKm: { value: 1 } },
  });
  let routeMesh: THREE.Mesh | null = null;
  let curve: THREE.CatmullRomCurve3 | null = null;
  let revealStart = 0;

  return {
    group,
    get curve() {
      return curve;
    },
    setLabels(homeText: string, safeText: string) {
      home.el.textContent = homeText;
      safe.el.textContent = safeText;
    },
    set(homePos: THREE.Vector3 | null, route: THREE.Vector3[] | null, routeKm: number, nowS: number) {
      home.root.visible = !!homePos;
      if (homePos) home.root.position.copy(homePos);
      if (routeMesh) {
        group.remove(routeMesh);
        routeMesh.geometry.dispose();
        routeMesh = null;
        curve = null;
      }
      safe.root.visible = !!route && route.length > 1;
      if (route && route.length > 1) {
        safe.root.position.copy(route[route.length - 1]);
        curve = new THREE.CatmullRomCurve3(route, false, 'centripetal');
        routeMesh = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(24, route.length * 3), 0.035, 6, false), routeMat);
        routeMesh.renderOrder = 2;
        group.add(routeMesh);
        routeMat.uniforms.uLengthKm.value = Math.max(0.5, routeKm);
        revealStart = nowS;
      }
    },
    update(cameraDistance: number, t: number) {
      const size = THREE.MathUtils.clamp(cameraDistance * 0.11, 0.8, 12);
      home.update(size, t);
      safe.update(size, t);
      routeMat.uniforms.uTime.value = t;
      routeMat.uniforms.uReveal.value = Math.min(1, (t - revealStart) / 1.8);
    },
  };
}
