import * as THREE from 'three';
import type { GeoFrame } from '../geo/region';
import { gridCoords, sampleField, type Heightmap } from '../terrain/heightmap';

const ray = new THREE.Raycaster();
const p = new THREE.Vector3();

/** Ray-march the heightfield (cheaper than raycasting ~1M triangles). Returns the ground point or null. */
export function pickTerrain(ndc: THREE.Vector2, camera: THREE.Camera, hm: Heightmap, frame: GeoFrame): THREE.Vector3 | null {
  ray.setFromCamera(ndc, camera);
  const { origin, direction } = ray.ray;
  const groundY = (x: number, z: number) => {
    const { gx, gy } = gridCoords(hm, frame.worldToLngLat({ x, z }));
    const e = sampleField(hm, hm.elevM, gx, gy);
    return Number.isNaN(e) ? NaN : frame.elevToY(Math.max(e, 0));
  };
  let prevT = 0;
  for (let t = 0.05; t < 600; t += Math.max(0.05, t * 0.004)) {
    p.copy(origin).addScaledVector(direction, t);
    const y = groundY(p.x, p.z);
    if (!Number.isNaN(y) && p.y <= y) {
      let lo = prevT;
      let hi = t;
      for (let k = 0; k < 20; k++) {
        const mid = (lo + hi) / 2;
        p.copy(origin).addScaledVector(direction, mid);
        if (p.y <= groundY(p.x, p.z)) hi = mid;
        else lo = mid;
      }
      return origin.clone().addScaledVector(direction, hi);
    }
    prevT = t;
  }
  return null;
}
