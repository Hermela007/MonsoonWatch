import * as THREE from 'three';
import type { StationWithLatest } from '@monsoonwatch/shared';
import type { GeoFrame, LngLat } from '../geo/region';
import { gridCoords, sampleField, type Heightmap } from '../terrain/heightmap';
import { THEME } from '../theme';

export type GaugeStatus = 'normal' | 'alert' | 'warning' | 'danger';
const COLOR: Record<GaugeStatus, THREE.Color> = {
  normal: new THREE.Color(0x8f8a82),
  alert: THEME.floodLight,
  warning: THEME.flood,
  danger: new THREE.Color(0x1d4f7a),
};

export function gaugeStatus(s: StationWithLatest): GaugeStatus | null {
  if (s.kind !== 'river' || !s.latest || !s.thresholds) return null;
  const v = s.latest.value;
  const t = s.thresholds;
  return v >= t.danger ? 'danger' : v >= t.warning ? 'warning' : v >= t.alert ? 'alert' : 'normal';
}

/** Live JPS river gauges (from C's API) as small markers on the terrain, coloured by their current level. */
export function createStations(stations: StationWithLatest[], hm: Heightmap, frame: GeoFrame) {
  // Only stations with a real position (not ones placed at a district centre).
  const usable = stations.filter((s) => gaugeStatus(s) && (s as { locationSource?: string }).locationSource !== 'district');
  const geo = new THREE.SphereGeometry(0.22, 16, 10).translate(0, 0.22, 0);
  const mat = new THREE.MeshBasicMaterial();
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, usable.length));
  mesh.count = usable.length;
  const pos = usable.map((s) => {
    const ll = s.location.coordinates as LngLat;
    const { gx, gy } = gridCoords(hm, ll);
    const e = sampleField(hm, hm.elevM, gx, gy);
    return frame.lngLatToWorld(ll, Number.isNaN(e) ? 0 : Math.max(e, 0));
  });
  usable.forEach((s, i) => mesh.setColorAt(i, COLOR[gaugeStatus(s)!]));
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const counts = usable.reduce((c, s) => ((c[gaugeStatus(s)!] += 1), c), { normal: 0, alert: 0, warning: 0, danger: 0 } as Record<GaugeStatus, number>);
  const newest = usable.reduce((t, s) => Math.max(t, Date.parse(s.latest!.ts)), 0);
  return {
    mesh,
    counts,
    total: usable.length,
    newest,
    update(cameraDistance: number) {
      const k = THREE.MathUtils.clamp(cameraDistance * 0.008, 0.5, 2.2);
      pos.forEach((p, i) => {
        mesh.setMatrixAt(i, m.compose(p, q, sc.set(k, k, k)));
      });
      mesh.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}
