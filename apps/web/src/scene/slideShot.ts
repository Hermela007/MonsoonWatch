import * as THREE from 'three';

interface SlideStreet {
  groundAt(x: number, z: number): number;
  slideAt(u: number, out: THREE.Vector3): THREE.Vector3 | null;
}

/**
 * A camera vantage onto a landslide's scar with a clear line of sight over the (exaggerated) street
 * terrain: a ring search around the crown, preferring a three-quarter view from downslope (which looks
 * into the concave hollow) and staying close enough that the street fog doesn't wash it out.
 */
export function findSlideShot(street: SlideStreet) {
  const target = street.slideAt(0.1, new THREE.Vector3());
  const below = street.slideAt(0.3, new THREE.Vector3());
  if (!target || !below) return null;
  target.y = street.groundAt(target.x, target.z);
  const along = new THREE.Vector3(below.x - target.x, 0, below.z - target.z).normalize();
  const side = new THREE.Vector3(-along.z, 0, along.x);
  const cam = new THREE.Vector3();
  const dir = new THREE.Vector3();
  let best: THREE.Vector3 | null = null;
  let bestScore = -Infinity;
  for (const r of [300, 380, 460, 560]) {
    for (const up of [140, 220, 300, 400]) {
      for (let a = 0; a < 360; a += 12) {
        const ang = (a * Math.PI) / 180;
        dir.copy(along).multiplyScalar(Math.cos(ang)).addScaledVector(side, Math.sin(ang));
        cam.copy(target).addScaledVector(dir, r);
        cam.y = target.y + up;
        if (cam.y - street.groundAt(cam.x, cam.z) < 40) continue;
        let clear = true;
        for (let i = 1; i < 24 && clear; i++) {
          const t = i / 24;
          const x = cam.x + (target.x - cam.x) * t;
          const z = cam.z + (target.z - cam.z) * t;
          const y = cam.y + (target.y - cam.y) * t;
          if (street.groundAt(x, z) + 6 > y) clear = false;
        }
        if (!clear) continue;
        const score = 0.7 * Math.cos(ang) + 0.45 * Math.abs(Math.sin(ang)) - r / 1500 - up / 2500;
        if (score > bestScore) {
          bestScore = score;
          best = cam.clone();
        }
      }
    }
  }
  return best ? { position: best, target } : null;
}
