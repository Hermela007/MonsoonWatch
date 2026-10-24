import { Vector3 } from 'three';

/** [lon, lat] — GeoJSON order. */
export type LngLat = [number, number];
/** minLon, minLat, maxLon, maxLat — same shape as `Region.bbox` in the shared contract. */
export type BBox = [number, number, number, number];

export interface Town {
  name: string;
  lngLat: LngLat;
  /** Short qualifier shown next to the name in suggestions (e.g. "below steep slopes"). */
  note?: string;
}

// Local stand-in until `region.kelantan.json` lands in packages/shared (Workstream C).
export const KELANTAN = {
  id: 'kelantan',
  name: 'Kelantan',
  // The whole state of Kelantan (boundary: geoBoundaries ADM1), with a small margin.
  bbox: [101.3, 4.53, 102.7, 6.27] as BBox,
};

/**
 * World frame: 1 unit = 1 km. Origin at bbox centre, +x east, -z north, +y up.
 * Every layer converts through `lngLatToWorld` / `worldToLngLat`.
 */
export class GeoFrame {
  readonly centre: LngLat;
  readonly kmPerDegLon: number;
  readonly kmPerDegLat = 110.57;
  readonly widthKm: number;
  readonly heightKm: number;

  constructor(
    readonly bbox: BBox,
    readonly exag: number,
  ) {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    this.centre = [(minLon + maxLon) / 2, (minLat + maxLat) / 2];
    this.kmPerDegLon = 111.32 * Math.cos((this.centre[1] * Math.PI) / 180);
    this.widthKm = (maxLon - minLon) * this.kmPerDegLon;
    this.heightKm = (maxLat - minLat) * this.kmPerDegLat;
  }

  elevToY(elevM: number): number {
    return elevM * 0.001 * this.exag;
  }

  yToElev(y: number): number {
    return y / (0.001 * this.exag);
  }

  lngLatToWorld([lon, lat]: LngLat, elevM = 0, target = new Vector3()): Vector3 {
    return target.set(
      (lon - this.centre[0]) * this.kmPerDegLon,
      this.elevToY(elevM),
      -(lat - this.centre[1]) * this.kmPerDegLat,
    );
  }

  worldToLngLat(v: { x: number; z: number }): LngLat {
    return [this.centre[0] + v.x / this.kmPerDegLon, this.centre[1] - v.z / this.kmPerDegLat];
  }
}
