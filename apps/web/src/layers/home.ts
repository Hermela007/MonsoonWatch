import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

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
uniform float uSolid;
uniform vec3 uColor;
varying vec2 vUv;
void main() {
  if (vUv.x > uReveal) discard;
  if (uSolid > 0.5) { gl_FragColor = vec4(uColor, 1.0); return; }
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
    uniforms: { uReveal: { value: 0 }, uTime: { value: 0 }, uLengthKm: { value: 1 }, uSolid: { value: 0 }, uColor: { value: new THREE.Color(0x1d1d1b) } },
  });
  // Route screen: a map-style line — constant width on screen, rounded, with a white casing, drawn over
  // the terrain (like a navigation app) rather than a 3D tube that swells towards the camera.
  const coreMat = new LineMaterial({ color: 0x1d1d1b, linewidth: 6, worldUnits: false, depthTest: false, transparent: true });
  const casingLineMat = new LineMaterial({ color: 0xfbfaf8, linewidth: 11, worldUnits: false, depthTest: false, transparent: true });
  let lines: Line2[] = [];
  let bold = false;
  let lastRoute: THREE.Vector3[] | null = null;
  const tubeRadius = () => 0.035;
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
      for (const l of lines) {
        group.remove(l);
        l.geometry.dispose();
      }
      lines = [];
      lastRoute = route;
      safe.root.visible = !!route && route.length > 1;
      if (route && route.length > 1) {
        safe.root.position.copy(route[route.length - 1]);
        curve = new THREE.CatmullRomCurve3(route, false, 'centripetal');
        if (bold) {
          // Draped points as given (already sampled along the terrain); casing under, ink core over.
          const flat = route.flatMap((p) => [p.x, p.y, p.z]);
          for (const [mat, order] of [[casingLineMat, 20], [coreMat, 21]] as const) {
            const g = new LineGeometry();
            g.setPositions(flat);
            const l = new Line2(g, mat);
            l.computeLineDistances();
            l.renderOrder = order;
            l.frustumCulled = false;
            group.add(l);
            lines.push(l);
          }
        } else {
          routeMesh = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(24, route.length * 3), tubeRadius(), 6, false), routeMat);
          routeMesh.renderOrder = 2;
          group.add(routeMesh);
        }
        routeMat.uniforms.uLengthKm.value = Math.max(0.5, routeKm);
        revealStart = nowS;
      }
    },
    /** Bold solid route (the route screen) or the marching dashes (the home card). Redraws the current route. */
    setBold(on: boolean, nowS: number) {
      if (on === bold) return;
      bold = on;
      routeMat.uniforms.uSolid.value = on ? 1 : 0;
      const homeVisible = home.root.visible ? home.root.position.clone() : null;
      if (lastRoute) {
        const km = routeMat.uniforms.uLengthKm.value;
        this.set(homeVisible, lastRoute, km, nowS);
      }
    },
    /** Screen size, for the constant-width route line. */
    setResolution(w: number, h: number) {
      coreMat.resolution.set(w, h);
      casingLineMat.resolution.set(w, h);
    },
    update(cameraDistance: number, t: number) {
      // On the route screen the camera comes close: the markers shrink with it instead of swamping the streets.
      const size = bold ? THREE.MathUtils.clamp(cameraDistance * 0.035, 0.03, 12) : THREE.MathUtils.clamp(cameraDistance * 0.11, 0.8, 12);
      home.update(size, t);
      safe.update(size, t);
      routeMat.uniforms.uTime.value = t;
      routeMat.uniforms.uReveal.value = Math.min(1, (t - revealStart) / 1.8);
    },
  };
}
