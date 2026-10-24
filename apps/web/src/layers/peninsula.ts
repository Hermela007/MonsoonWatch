import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { GeoFrame, LngLat } from '../geo/region';
import { THEME } from '../theme';

export interface MalaysiaData {
  source: string;
  states: { name: string; polygons: LngLat[][] }[];
}

/** Flat map of Peninsular Malaysia under the valley model, Kelantan outlined — for the opening zoom. */
export function createPeninsula(data: MalaysiaData, frame: GeoFrame, y: number) {
  const group = new THREE.Group();
  const owned: { dispose(): void }[] = [];
  const land = new THREE.MeshBasicMaterial({ color: THEME.paperDark, side: THREE.DoubleSide });
  const kelFill = new THREE.MeshBasicMaterial({ color: 0xdcd8d0, side: THREE.DoubleSide });
  const border = new THREE.LineBasicMaterial({ color: 0xb9b3a9 });
  const kelLine = new THREE.LineBasicMaterial({ color: THEME.ink });
  owned.push(land, kelFill, border, kelLine);
  const toV = (ll: LngLat) => frame.lngLatToWorld(ll);
  let kelCentre = new THREE.Vector3();
  for (const st of data.states) {
    const isKel = st.name === 'Kelantan';
    for (const ring of st.polygons) {
      const pts = ring.map(toV);
      const shape = new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, -p.z)));
      const geo = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(0, y, 0);
      const lineGeo = new THREE.BufferGeometry().setFromPoints(pts.map((p) => new THREE.Vector3(p.x, y + 0.05, p.z)));
      owned.push(geo, lineGeo);
      group.add(new THREE.Mesh(geo, isKel ? kelFill : land), new THREE.LineLoop(lineGeo, isKel ? kelLine : border));
      if (isKel && pts.length > kelCentre.length()) kelCentre = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(pts.length);
    }
  }
  const el = document.createElement('div');
  el.className = 'atlas state';
  el.textContent = 'KELANTAN';
  const lab = new CSS2DObject(el);
  lab.position.set(kelCentre.x - 60, y, kelCentre.z + 20);
  group.add(lab);
  const el2 = document.createElement('div');
  el2.className = 'atlas country';
  el2.textContent = 'PENINSULAR MALAYSIA';
  const lab2 = new CSS2DObject(el2);
  lab2.position.copy(frame.lngLatToWorld([101.9, 3.6])).setY(y);
  group.add(lab2);
  return {
    group,
    update(cameraDistance: number) {
      // Map labels only while zoomed out.
      lab.visible = lab2.visible = cameraDistance > 400;
    },
    dispose() {
      owned.forEach((o) => o.dispose());
      el.remove();
      el2.remove();
    },
  };
}
