import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { GeoFrame } from '../geo/region';
import { gridCoords, nearestCell, sampleField, type Heightmap } from '../terrain/heightmap';
import { depthAt, landslideRisk, type Hydrology } from '../terrain/hydrology';
import { firstWetHour, replayDate } from '../mock/replay2014';

/** Click the terrain → water depth now, worst case, and first-wet time at that point. */
export function createInspector(hm: Heightmap, hy: Hydrology, frame: GeoFrame, camera: THREE.Camera) {
  // CSS2DRenderer owns the wrapper's transform, so anchoring is done with `center` and padding.
  const wrap = document.createElement('div');
  wrap.className = 'inspect';
  const el = document.createElement('div');
  el.className = 'inspect-card';
  wrap.appendChild(el);
  const obj = new CSS2DObject(wrap);
  obj.center.set(0, 1);
  obj.visible = false;

  const ray = new THREE.Raycaster();
  const p = new THREE.Vector3();
  let picked: { lngLat: [number, number]; cell: number } | null = null;

  const surfaceY = (x: number, z: number, stageM: number) => {
    const { gx, gy } = gridCoords(hm, frame.worldToLngLat({ x, z }));
    const elev = sampleField(hm, hm.elevM, gx, gy);
    if (Number.isNaN(elev)) return NaN;
    const fill = sampleField(hm, hy.filledM, gx, gy);
    const surf = sampleField(hm, hy.drainElevM, gx, gy) + stageM * sampleField(hm, hy.stageScale, gx, gy);
    return frame.elevToY(Math.max(elev, surf > fill ? surf : 0, 0));
  };

  const fmt = (h: number | null) =>
    h === null
      ? '—'
      : replayDate(h).toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  return {
    object: obj,
    pick(ndc: THREE.Vector2, stageM: number): boolean {
      ray.setFromCamera(ndc, camera);
      const { origin, direction } = ray.ray;
      let prevT = 0;
      let hit = -1;
      for (let t = 0.05; t < 600; t += Math.max(0.05, t * 0.004)) {
        p.copy(origin).addScaledVector(direction, t);
        const y = surfaceY(p.x, p.z, stageM);
        if (!Number.isNaN(y) && p.y <= y) {
          let lo = prevT;
          let hi = t;
          for (let k = 0; k < 20; k++) {
            const mid = (lo + hi) / 2;
            p.copy(origin).addScaledVector(direction, mid);
            if (p.y <= surfaceY(p.x, p.z, stageM)) hi = mid;
            else lo = mid;
          }
          hit = hi;
          break;
        }
        prevT = t;
      }
      if (hit < 0) {
        obj.visible = false;
        picked = null;
        return false;
      }
      p.copy(origin).addScaledVector(direction, hit);
      const lngLat = frame.worldToLngLat(p);
      const cell = nearestCell(hm, lngLat);
      if (cell === null) return false;
      picked = { lngLat, cell };
      const flip = ndc.x > 0.1;
      wrap.classList.toggle('flip', flip);
      obj.center.set(flip ? 1 : 0, 1);
      obj.position.copy(p);
      obj.visible = true;
      return true;
    },
    update(stageM: number, worstM: number, rainAcc: number) {
      if (!picked) return;
      const i = picked.cell;
      const depth = depthAt(hm, hy, i, stageM);
      const worst = depthAt(hm, hy, i, worstM);
      const risk = landslideRisk(hy.slopeDeg[i], hm.elevM[i], rainAcc);
      const wetAt = firstWetHour((s) => depthAt(hm, hy, i, s));
      const worstWetAt = firstWetHour((s) => depthAt(hm, hy, i, s), true);
      const sea = hy.seaMask[i] === 1;
      el.innerHTML = sea
        ? `<b>Sea</b>`
        : `
        <div class="inspect-coord">${picked.lngLat[1].toFixed(4)}°N ${picked.lngLat[0].toFixed(4)}°E · ground ${Math.round(hm.elevM[i])} m</div>
        <div class="inspect-row"><span>Water now</span><b class="${depth > 0.05 ? 'wet' : ''}">${depth > 0.05 ? depth.toFixed(1) + ' m' : 'dry'}</b></div>
        <div class="inspect-row"><span>Worst case</span><b>${worst > 0.05 ? worst.toFixed(1) + ' m' : 'dry'}</b></div>
        <div class="inspect-row"><span>First wet</span><b>${fmt(wetAt)}</b></div>
        <div class="inspect-row"><span>Worst-case wet</span><b>${fmt(worstWetAt)}</b></div>
        <div class="inspect-row"><span>Slope</span><b class="${risk > 0.5 ? 'risk' : ''}">${hy.slopeDeg[i].toFixed(0)}°${risk > 0.5 ? ' · check' : ''}</b></div>
        <div class="inspect-note">HAND flood approximation · illustrative 2014 curve</div>`;
    },
    hide() {
      obj.visible = false;
      picked = null;
    },
  };
}
