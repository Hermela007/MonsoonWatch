import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { GeoFrame, Town } from '../geo/region';
import { nearestCell, type Heightmap } from '../terrain/heightmap';
import { depthAt, type Hydrology } from '../terrain/hydrology';

const RADIUS_CELLS = 6; // ≈1 km

/** Town labels: deepest modelled floodplain water (river channel excluded) within ~1 km of the centre. */
export function createTowns(towns: Town[], hm: Heightmap, hy: Hydrology, frame: GeoFrame) {
  const group = new THREE.Group();
  const items = towns.flatMap((town) => {
    const centre = nearestCell(hm, town.lngLat);
    if (centre === null) return [];
    const cells: number[] = [];
    const r0 = Math.floor(centre / hm.cols);
    const c0 = centre - r0 * hm.cols;
    for (let dr = -RADIUS_CELLS; dr <= RADIUS_CELLS; dr++) {
      for (let dc = -RADIUS_CELLS; dc <= RADIUS_CELLS; dc++) {
        const r = r0 + dr;
        const c = c0 + dc;
        if (r >= 0 && c >= 0 && r < hm.rows && c < hm.cols && !hy.riverMask[r * hm.cols + c] && !hy.seaMask[r * hm.cols + c]) cells.push(r * hm.cols + c);
      }
    }
    const el = document.createElement('div');
    el.className = 'town';
    el.innerHTML = `<span class="town-dot"></span><span class="town-name">${town.name}</span><span class="town-depth"></span>`;
    const depthEl = el.querySelector<HTMLElement>('.town-depth')!;
    const obj = new CSS2DObject(el);
    obj.center.set(0, 0.5); // dot sits on the town
    group.add(obj);
    return [{ town, centre, cells, el, depthEl, obj }];
  });

  const pos = new THREE.Vector3();
  return {
    group,
    update(stageM: number) {
      for (const it of items) {
        let maxDepth = -Infinity;
        for (const i of it.cells) maxDepth = Math.max(maxDepth, depthAt(hm, hy, i, stageM));
        const surf = Math.max(hm.elevM[it.centre], depthAt(hm, hy, it.centre, stageM) > 0 ? hy.drainElevM[it.centre] + stageM * hy.stageScale[it.centre] : 0);
        frame.lngLatToWorld(it.town.lngLat, surf, pos);
        it.obj.position.copy(pos);
        const wet = maxDepth > 0.05;
        it.el.classList.toggle('wet', wet);
        it.el.classList.toggle('deep', maxDepth > 2);
        it.depthEl.textContent = wet ? `${maxDepth.toFixed(1)} m` : 'dry';
      }
    },
  };
}
