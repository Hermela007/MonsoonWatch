import * as THREE from 'three';

interface SlideStreet {
  groundAt(x: number, z: number): number;
  slideAt(u: number, out: THREE.Vector3): THREE.Vector3 | null;
}

export interface SlideShot {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

/** The part of the screen not covered by UI, in normalised device coordinates. */
export interface FrameBounds {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

/** Visible 3D area: right of a side card (laptop) or above a bottom sheet (phone), below the top bar. */
export function visibleBounds(card: HTMLElement | null, topBarPx = 70): FrameBounds {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const b: FrameBounds = { xMin: -0.9, xMax: 0.9, yMin: -0.85, yMax: 1 - ((topBarPx + 30) / h) * 2 };
  const r = card?.getBoundingClientRect();
  if (r && r.width > 0) {
    if (r.right < w * 0.6) b.xMin = ((r.right + 40) / w) * 2 - 1;
    else if (r.top > h * 0.25) b.yMin = 1 - ((r.top - 30) / h) * 2;
  }
  return b;
}

/**
 * A vantage that frames the given points (e.g. crown, toe and home) with a clear line of sight over the
 * exaggerated street terrain. A ring search around their centre at a few elevations, preferring a low
 * three-quarter view from downslope (the concave scar faces the camera and the slope reads in profile).
 * Each candidate is pulled back until every point projects inside the frame.
 */
export function frameSlide(
  street: SlideStreet,
  keep: THREE.Vector3[],
  downslope: THREE.Vector3,
  cam: THREE.PerspectiveCamera,
  bounds: FrameBounds,
  opts: { maxR?: number; minClear?: number } = {},
): SlideShot | null {
  const maxR = opts.maxR ?? 1500;
  const box = new THREE.Box3().setFromPoints(keep);
  const target = box.getCenter(new THREE.Vector3());
  const probe = cam.clone();
  const along = downslope.clone().setY(0).normalize();
  const side = new THREE.Vector3(-along.z, 0, along.x);
  const pos = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const ndc = new THREE.Vector3();
  const clearTo = (p: THREE.Vector3) => {
    for (let i = 1; i < 32; i++) {
      const t = i / 32;
      const x = pos.x + (p.x - pos.x) * t;
      const z = pos.z + (p.z - pos.z) * t;
      const y = pos.y + (p.y + 4 - pos.y) * t;
      if (street.groundAt(x, z) + 3 > y) return false;
    }
    return true;
  };
  // Inside the visible frame (the stage's own view offset keeps the side card clear).
  const fits = () => {
    probe.position.copy(pos);
    probe.lookAt(target);
    probe.updateMatrixWorld();
    return keep.every((p) => {
      ndc.copy(p).project(probe);
      return ndc.x > bounds.xMin && ndc.x < bounds.xMax && ndc.y > bounds.yMin && ndc.y < bounds.yMax && ndc.z < 1;
    });
  };
  let best: SlideShot | null = null;
  let bestScore = -Infinity;
  for (const elev of [0.3, 0.4, 0.52, 0.65]) {
    for (let a = 0; a < 360; a += 10) {
      const ang = (a * Math.PI) / 180;
      // ang = 0 looks back up the path from below; ±90° is side-on.
      dir.copy(along).multiplyScalar(Math.cos(ang)).addScaledVector(side, Math.sin(ang));
      let r = 150;
      const place = () => pos.copy(target).addScaledVector(dir, r * Math.cos(elev)).setY(target.y + r * Math.sin(elev));
      place();
      while (r < maxR && !fits()) {
        r *= 1.08;
        place();
      }
      if (r >= maxR) continue;
      if (pos.y - street.groundAt(pos.x, pos.z) < (opts.minClear ?? 50)) continue;
      if (!keep.every(clearTo)) continue;
      const score = 0.55 * Math.cos(ang) + 0.75 * Math.abs(Math.sin(ang)) - r / 3000 - 1.4 * Math.abs(elev - 0.38);
      if (score > bestScore) {
        bestScore = score;
        best = { position: pos.clone(), target: target.clone() };
      }
    }
  }
  return best;
}

/** The landslide street's two shots: wide (crown → toe → home) and close (the runout reaching the houses). */
export function findSlideShots(street: SlideStreet, home: THREE.Vector3, cam: THREE.PerspectiveCamera, bounds: FrameBounds) {
  const crown = street.slideAt(0.02, new THREE.Vector3());
  const lower = street.slideAt(0.6, new THREE.Vector3());
  const toe = street.slideAt(1, new THREE.Vector3());
  if (!crown || !lower || !toe) return null;
  const down = toe.clone().sub(crown).setY(0);
  // The deposit spreads past the toe; keep that in frame too.
  const lobe = toe.clone().addScaledVector(down.clone().normalize(), Math.max(70, down.length() * 0.11));
  for (const p of [crown, lower, toe, lobe]) p.y = street.groundAt(p.x, p.z);
  const wide = frameSlide(street, [crown, lobe, home], down, cam, bounds);
  if (!wide) return null;
  const close = frameSlide(street, [lower, lobe, home], down, cam, bounds, { maxR: 1000, minClear: 30 }) ?? wide;
  return { wide, close };
}
