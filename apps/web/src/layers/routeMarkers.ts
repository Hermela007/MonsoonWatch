import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

/** Numbered turn markers along the route (route screen). Clicking one selects that step. */
export function createRouteMarkers() {
  const group = new THREE.Group();
  let items: { obj: CSS2DObject; el: HTMLElement }[] = [];

  const clear = () => {
    for (const { obj, el } of items) {
      group.remove(obj);
      el.remove();
    }
    items = [];
  };

  return {
    group,
    set(points: THREE.Vector3[], onSelect: (i: number) => void) {
      clear();
      points.forEach((p, i) => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'turn-marker';
        el.textContent = String(i + 1);
        el.setAttribute('aria-label', `Step ${i + 1}`);
        el.addEventListener('click', () => onSelect(i));
        const obj = new CSS2DObject(el);
        obj.position.copy(p);
        group.add(obj);
        items.push({ obj, el });
      });
    },
    select(i: number | null) {
      items.forEach(({ el }, k) => el.classList.toggle('on', k === i));
    },
    clear,
  };
}
