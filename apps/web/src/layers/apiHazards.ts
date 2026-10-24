import * as THREE from 'three';
import type { HazardScenario } from '../api/hazards';
import type { GeoFrame, LngLat } from '../geo/region';
import { cellLngLat, gridCoords, sampleField, type Heightmap } from '../terrain/heightmap';

/** Water is a display interpolation near mapped rivers, not an API flood-extent polygon.
 * Road closures and landslide geometry are drawn directly from the scenario response. */
export function createApiHazards(hm: Heightmap, frame: GeoFrame, rivers: { lines: LngLat[][] }[], inside: (ll: LngLat) => boolean) {
  const group = new THREE.Group();
  const riverBins = new Map<string, THREE.Vector3[]>();
  const key = (x: number, z: number) => `${Math.floor(x / 3)},${Math.floor(z / 3)}`;
  for (const river of rivers) for (const line of river.lines) for (let i = 1; i < line.length; i++) {
    const a = frame.lngLatToWorld(line[i - 1]), b = frame.lngLatToWorld(line[i]);
    const n = Math.max(1, Math.ceil(a.distanceTo(b) / .25));
    for (let j = 0; j <= n; j++) {
      const p = a.clone().lerp(b, j / n), k = key(p.x, p.z);
      if (!riverBins.has(k)) riverBins.set(k, []);
      riverBins.get(k)!.push(p);
    }
  }
  const cells: { ll: LngLat; p: THREE.Vector3; ground: number }[] = [];
  const stride = 2;
  for (let r = 0; r < hm.rows; r += stride) for (let c = 0; c < hm.cols; c += stride) {
    const ll = cellLngLat(hm, c, r);
    if (!inside(ll)) continue;
    const p = frame.lngLatToWorld(ll), bx = Math.floor(p.x / 3), bz = Math.floor(p.z / 3);
    let near = false;
    for (let dz = -1; dz <= 1 && !near; dz++) for (let dx = -1; dx <= 1 && !near; dx++) near = (riverBins.get(`${bx + dx},${bz + dz}`) ?? []).some(q => q.distanceToSquared(p) <= 9);
    if (near) cells.push({ ll, p, ground: hm.elevM[r * hm.cols + c] });
  }
  const clear = () => {
    for (const child of [...group.children]) {
      group.remove(child);
      const drawable = child as THREE.Mesh;
      drawable.geometry?.dispose();
      const materials = Array.isArray(drawable.material) ? drawable.material : [drawable.material];
      materials.forEach(m => m?.dispose());
    }
  };
  const ground = (ll: LngLat) => {
    const { gx, gy } = gridCoords(hm, ll), e = sampleField(hm, hm.elevM, gx, gy);
    return Number.isFinite(e) ? Math.max(0, e) : 0;
  };
  const lineLayer = (lines: LngLat[][], color: number) => {
    const positions: number[] = [];
    for (const line of lines) for (let i = 1; i < line.length; i++) for (const ll of [line[i - 1], line[i]]) {
      const p = frame.lngLatToWorld(ll, ground(ll) + 18); positions.push(p.x, p.y, p.z);
    }
    const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    group.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: .9 })));
  };
  return {
    group,
    clear,
    set(data: HazardScenario) {
      clear();
      const gauges = [...data.gauges, ...data.gaugesWithoutReading.filter(g => g.lngLat).map(g => ({ ...g, name: '', lngLat: g.lngLat!, levelM: 0, level: 'normal' as const, stale: true, thresholds: { alert: Infinity } }))].map(g => ({ ...g, p: frame.lngLatToWorld(g.lngLat) }));
      const likely: number[] = [], worst: number[] = [];
      const halfX = hm.cellXM * stride / 2000, halfZ = hm.cellYM * stride / 2000;
      const margin = Math.max(0, data.water.worstLevelM - data.water.likelyLevelM);
      for (const cell of cells) {
        const [w, s, e, n] = data.coverage.bbox;
        if (cell.ll[0] < w || cell.ll[0] > e || cell.ll[1] < s || cell.ll[1] > n) continue;
        let nearest = gauges[0], distance = Infinity;
        for (const g of gauges) { const d = cell.p.distanceToSquared(g.p); if (d < distance) { distance = d; nearest = g; } }
        if (!nearest || distance > 400 || nearest.stale || nearest.levelM < nearest.thresholds.alert) continue;
        for (const [positions, level] of [[worst, nearest.levelM + margin], [likely, nearest.levelM]] as const) {
          if (cell.ground >= level) continue;
          const { x, z } = cell.p, y = frame.elevToY(level) + .012;
          positions.push(x-halfX,y,z-halfZ, x-halfX,y,z+halfZ, x+halfX,y,z-halfZ, x+halfX,y,z-halfZ, x-halfX,y,z+halfZ, x+halfX,y,z+halfZ);
        }
      }
      for (const [positions, opacity, color] of [[worst, .16, 0x6ba5b3], [likely, .65, 0x3987a9]] as const) {
        const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        group.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, opacity, transparent: true, depthWrite: false, side: THREE.DoubleSide })));
      }
      lineLayer(data.blockedRoads.coordinates, 0xa83d30);
      lineLayer(data.landslide.runouts.map(r => r.coordinates), 0xc36332);
      const positions: number[] = [], colors: number[] = [];
      for (const cell of data.landslide.cells) {
        if (cell.risk <= 0 || !inside(cell.lngLat)) continue;
        const p = frame.lngLatToWorld(cell.lngLat, ground(cell.lngLat) + 20);
        positions.push(p.x,p.y,p.z);
        const color = new THREE.Color(0xe6bd83).lerp(new THREE.Color(0xa63b25), Math.max(0, Math.min(1, cell.risk)));
        colors.push(color.r,color.g,color.b);
      }
      const g = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)).setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      group.add(new THREE.Points(g, new THREE.PointsMaterial({ size: .5, vertexColors: true, transparent: true, opacity: .75, depthTest: false })));
    },
    dispose() { clear(); },
  };
}
