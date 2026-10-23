import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export interface Shot {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** Eased camera moves: `flyTo` for single shots, `tour` for a smooth spline through several. */
export function createCameraDirector(camera: THREE.PerspectiveCamera, controls: OrbitControls) {
  let anim: { update: (now: number) => boolean } | null = null;
  let onDone: (() => void) | null = null;

  const finish = () => {
    anim = null;
    controls.enabled = true;
    const cb = onDone;
    onDone = null;
    cb?.();
  };

  return {
    get busy() {
      return anim !== null;
    },
    flyTo(shot: Shot, durationMs = 2200, done?: () => void) {
      const p0 = camera.position.clone();
      const t0 = controls.target.clone();
      const start = performance.now();
      controls.enabled = false;
      onDone = done ?? null;
      anim = {
        update(now) {
          const u = Math.min(1, (now - start) / durationMs);
          const e = ease(u);
          camera.position.lerpVectors(p0, shot.position, e);
          // Arc up mid-flight so long moves read as a fly-over.
          camera.position.y += Math.sin(Math.PI * e) * p0.distanceTo(shot.position) * 0.15;
          controls.target.lerpVectors(t0, shot.target, e);
          return u < 1;
        },
      };
    },
    tour(shots: Shot[], durationMs: number, done?: () => void) {
      const all = [{ position: camera.position.clone(), target: controls.target.clone() }, ...shots];
      const pos = new THREE.CatmullRomCurve3(all.map((s) => s.position), false, 'centripetal');
      const tgt = new THREE.CatmullRomCurve3(all.map((s) => s.target), false, 'centripetal');
      const start = performance.now();
      controls.enabled = false;
      onDone = done ?? null;
      anim = {
        update(now) {
          const u = Math.min(1, (now - start) / durationMs);
          const e = ease(u);
          pos.getPointAt(e, camera.position);
          tgt.getPointAt(e, controls.target);
          return u < 1;
        },
      };
    },
    cancel() {
      if (anim) finish();
    },
    update(now: number) {
      if (anim && !anim.update(now)) finish();
    },
  };
}
