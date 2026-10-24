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
  /** Inside Kelantan? Rivers outside the state are not drawn. */
  inside: (ll: LngLat) => boolean;
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
  const riverMeshes: THREE.Mesh[] = [];
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
  const mat = new THREE.MeshBasicMaterial({ color: THEME.flood, transparent: true, opacity: 0.9, depthWrite: false });
  owned.push(mat);
  for (const r of opts.rivers) {
    const name = latinName(r.name);
    const radius = /Kelantan|Galas|Lebir/.test(name) ? 0.11 : 0.07;
    for (const full of r.lines) {
      const line = full.filter((ll) => opts.inside(ll));
      if (line.length < 2) continue;
      const pts = line.map((ll) => frame.lngLatToWorld(ll, groundAt(ll)).add(new THREE.Vector3(0, 0.05, 0)));
      const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), Math.min(400, pts.length * 2), radius, 4, false);
      owned.push(geo);
      const mesh = new THREE.Mesh(geo, mat);
      riverMeshes.push(mesh);
      group.add(mesh);
    }
    // Label at the midpoint of the river's longest piece.
    const longest = [...r.lines].map((l) => l.filter((ll) => opts.inside(ll))).sort((a, b) => b.length - a.length)[0];
    if (longest?.length > 4 && /Kelantan|Galas|Lebir|Nenggiri|Pergau|Golok/.test(name)) label(name, longest[Math.floor(longest.length / 2)], 'river', 0.25);
  }
  for (const t of opts.towns) label(t.name, t.lngLat, t.major ? 'town major' : 'town');
  // Where Kelantan sits, without a map: its neighbours, named just beyond the border.
  label('South China Sea', [102.55, 6.36], 'sea', 0);
  label('THAILAND', [101.5, 6.08], 'country', 0);
  label('PERAK', [101.12, 5.3], 'country', 0);
  label('PAHANG', [101.85, 4.38], 'country', 0);
  label('TERENGGANU', [102.82, 5.15], 'country', 0);

  return {
    group,
    /** Fade labels with distance so the frame never gets busy. */
    update(camera: THREE.Camera, focusOn: boolean, cameraDistance = 999) {
      // River centre lines are a far-view cue only; close up, the modelled water is the river.
      mat.opacity = 0.9 * THREE.MathUtils.smoothstep(cameraDistance, 45, 90);
      riverMeshes.forEach((m) => (m.visible = mat.opacity > 0.01));
      for (const l of labels) {
        const d = camera.position.distanceTo(l.obj.position);
        const vis = l.kind.includes('major') || l.kind === 'sea' || l.kind === 'country' ? d < 900 : d < 200;
        l.obj.visible = vis && !(focusOn && l.kind === 'river' && d > 60);
      }
    },
    dispose() {
      owned.forEach((o) => o.dispose());
      labels.forEach((l) => l.el.remove());
    },
  };
}
