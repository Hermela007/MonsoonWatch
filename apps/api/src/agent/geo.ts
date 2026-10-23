// Small, dependency-free geometry helpers for verification. Coordinates are GeoJSON [lon, lat].
// Planar segment tests on lon/lat are fine at valley scale (tens of km, near the equator).

import type { LngLat } from "@monsoonwatch/shared";

const EARTH_RADIUS_KM = 6371;

export function haversineKm(a: LngLat, b: LngLat): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

function orient(p: LngLat, q: LngLat, r: LngLat): number {
  const v = (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1]);
  return Math.abs(v) < 1e-12 ? 0 : v > 0 ? 1 : 2;
}

function onSegment(p: LngLat, q: LngLat, r: LngLat): boolean {
  return (
    q[0] <= Math.max(p[0], r[0]) && q[0] >= Math.min(p[0], r[0]) &&
    q[1] <= Math.max(p[1], r[1]) && q[1] >= Math.min(p[1], r[1])
  );
}

/** True if segment p1–p2 touches or crosses segment q1–q2. */
export function segmentsIntersect(p1: LngLat, p2: LngLat, q1: LngLat, q2: LngLat): boolean {
  const o1 = orient(p1, p2, q1);
  const o2 = orient(p1, p2, q2);
  const o3 = orient(q1, q2, p1);
  const o4 = orient(q1, q2, p2);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(p1, q1, p2)) return true;
  if (o2 === 0 && onSegment(p1, q2, p2)) return true;
  if (o3 === 0 && onSegment(q1, p1, q2)) return true;
  if (o4 === 0 && onSegment(q1, p2, q2)) return true;
  return false;
}

/** Index of the first segment of `line` that intersects `other`, or -1. */
export function firstIntersectingSegment(line: LngLat[], other: LngLat[]): number {
  for (let i = 0; i < line.length - 1; i++) {
    for (let j = 0; j < other.length - 1; j++) {
      if (segmentsIntersect(line[i]!, line[i + 1]!, other[j]!, other[j + 1]!)) return i;
    }
  }
  return -1;
}
