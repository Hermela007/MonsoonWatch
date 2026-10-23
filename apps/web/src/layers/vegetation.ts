import * as THREE from 'three';
import { distToLane, rng, type House, type Lane } from '../data/buildings';
import { addUnderwater } from './underwater';

/** Architectural-model trees: pale spheres on thin stems, instanced. */
export function createVegetation(houses: House[], lanes: Lane[], groundY: (x: number, z: number) => number, seed: number, radiusM: number) {
  const rand = rng(seed + 99);
  const free = (x: number, z: number, pad: number) =>
    houses.every((h) => Math.hypot(h.x - x, h.z - z) > Math.max(h.w, h.d) * 0.62 + pad) && lanes.every((l) => distToLane(l, x, z) > 6.5);

  const spots: THREE.Matrix4[] = [];
  const place = (x: number, z: number, s: number) =>
    spots.push(new THREE.Matrix4().compose(new THREE.Vector3(x, groundY(x, z), z), new THREE.Quaternion(), new THREE.Vector3(s, s, s)));
  // Street trees along the roads, a few in gardens.
  for (const lane of lanes) {
    const a = lane[0];
    const b = lane[lane.length - 1];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const nx = -(b.z - a.z) / len;
    const nz = (b.x - a.x) / len;
    for (let d = 0; d < len; d += 24 + rand() * 10) {
      for (const side of [-1, 1]) {
        const x = a.x + ((b.x - a.x) * d) / len + nx * side * 6.2;
        const z = a.z + ((b.z - a.z) * d) / len + nz * side * 6.2;
        // Keep the view from the street onto the home clear.
        if (Math.hypot(x, z) > 45 && Math.hypot(x, z) < radiusM && houses.every((h) => Math.hypot(h.x - x, h.z - z) > Math.max(h.w, h.d) * 0.55 + 1)) place(x, z, 0.8 + rand() * 0.35);
      }
    }
  }
  for (let k = 0; k < 70; k++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * radiusM;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (Math.hypot(x, z) > 45 && free(x, z, 3)) place(x, z, 0.9 + rand() * 0.4);
  }

  const crownGeo = new THREE.IcosahedronGeometry(1.5, 3).translate(0, 4.4, 0);
  const stemGeo = new THREE.CylinderGeometry(0.07, 0.09, 3.2, 6).translate(0, 1.6, 0);
  const crownMat = addUnderwater(new THREE.MeshStandardMaterial({ color: 0xe8e5df, roughness: 0.95 }));
  const stemMat = addUnderwater(new THREE.MeshStandardMaterial({ color: 0xbdb7ae, roughness: 0.9 }));
  const group = new THREE.Group();
  for (const [geo, mat] of [[crownGeo, crownMat], [stemGeo, stemMat]] as const) {
    const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, spots.length));
    spots.forEach((m, i) => mesh.setMatrixAt(i, m));
    mesh.count = spots.length;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return {
    group,
    dispose: () => [crownGeo, stemGeo, crownMat, stemMat].forEach((o) => o.dispose()),
  };
}
