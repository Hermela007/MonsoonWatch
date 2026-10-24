import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { GeoFrame, LngLat } from '../geo/region';
import { gridCoords, sampleField, type Heightmap } from '../terrain/heightmap';
import { THEME } from '../theme';

export interface NamedRiver {
  name: string;
  km: number;
  lines: LngLat[][];
}

/** OSM names like "แม่น้ำโกลก / Sungai Golok" → "Sungai Golok". */
const latinName = (n: string) => n.split('/').map((x) => x.trim()).find((x) => /^[\x00-\x7F]+$/.test(x)) ?? n;

/**
 * Atlas layer: the real named rivers drawn on the terrain, and quiet labels for rivers, towns, the
 * sea and the border — so the valley reads as Kelantan, not a generic landscape.
 */
export function createGeoContext(opts: {
  hm: Heightmap;
  frame: GeoFrame;
  rivers: NamedRiver[];
  towns: { name: string; lngLat: LngLat; major: boolean }[];
}) {
  const { hm, frame } = opts;
  const group = new THREE.Group();
  const owned: { dispose(): void }[] = [];
  const groundAt = (ll: LngLat) => {
    const { gx, gy } = gridCoords(hm, ll);
    const e = sampleField(hm, hm.elevM, gx, gy);
    return Number.isNaN(e) ? 0 : Math.max(e, 0);
  };
  const labels: { obj: CSS2DObject; el: HTMLElement; kind: string }[] = [];
  const label = (text: string, ll: LngLat, cls: string, lift = 0.4) => {
    const el = document.createElement('div');
    el.className = `atlas ${cls}`;
    el.textContent = text;
    const obj = new CSS2DObject(el);
    obj.position.copy(frame.lngLatToWorld(ll, groundAt(ll))).add(new THREE.Vector3(0, lift, 0));
    group.add(obj);
    labels.push({ obj, el, kind: cls });
  };

  // Rivers as thin lines on the terrain; the main stem slightly heavier.
  const mat = new THREE.MeshBasicMaterial({ color: THEME.flood, transparent: true, opacity: 0.9 });
  owned.push(mat);
  for (const r of opts.rivers) {
    const name = latinName(r.name);
    const radius = /Kelantan|Galas|Lebir/.test(name) ? 0.11 : 0.07;
    for (const line of r.lines) {
      if (line.length < 2) continue;
      const pts = line.map((ll) => frame.lngLatToWorld(ll, groundAt(ll)).add(new THREE.Vector3(0, 0.05, 0)));
      const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), Math.min(400, pts.length * 2), radius, 4, false);
      owned.push(geo);
      group.add(new THREE.Mesh(geo, mat));
    }
    // Label at the midpoint of the river's longest piece.
    const longest = [...r.lines].sort((a, b) => b.length - a.length)[0];
    if (longest?.length > 4) label(name, longest[Math.floor(longest.length / 2)], 'river', 0.25);
  }
  for (const t of opts.towns) label(t.name, t.lngLat, t.major ? 'town major' : 'town');
  label('South China Sea', [102.45, 6.24], 'sea', 0);
  label('THAILAND', [101.86, 6.1], 'country', 0.3);

  return {
    group,
    /** Fade labels with distance so the frame never gets busy. */
    update(camera: THREE.Camera, focusOn: boolean) {
      for (const l of labels) {
        const d = camera.position.distanceTo(l.obj.position);
        const vis = l.kind.includes('major') || l.kind === 'sea' || l.kind === 'country' ? d < 900 : d < 160;
        l.obj.visible = vis && !(focusOn && l.kind === 'river' && d > 60);
      }
    },
    dispose() {
      owned.forEach((o) => o.dispose());
      labels.forEach((l) => l.el.remove());
    },
  };
}
