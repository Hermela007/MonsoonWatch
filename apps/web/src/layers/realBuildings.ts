import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { addUnderwater } from './underwater';

export interface Footprint {
  /** Outline in local metres (x east, z south), counter-clockwise or clockwise. */
  ring: { x: number; z: number }[];
  heightM: number;
  base: number;
}

/**
 * Real building footprints extruded to their (estimated) height, merged into one mesh with edge
 * lines. Each building can be tinted (flood depth, landslide) by vertex colour.
 */
export function createRealBuildings(footprints: Footprint[]) {
  const geos: THREE.BufferGeometry[] = [];
  const ranges: { start: number; count: number }[] = [];
  let offset = 0;
  for (const f of footprints) {
    if (f.ring.length < 3) {
      ranges.push({ start: offset, count: 0 });
      continue;
    }
    // Shape in the XY plane with y = -z; rotating by -90° about X maps it onto the ground.
    const shape = new THREE.Shape(f.ring.map((p) => new THREE.Vector2(p.x, -p.z)));
    let g: THREE.BufferGeometry = new THREE.ExtrudeGeometry(shape, { depth: f.heightM, bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    g.translate(0, f.base, 0);
    g = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
    const n = g.attributes.position.count;
    const c = new Float32Array(n * 3).fill(1);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    geos.push(g);
    ranges.push({ start: offset, count: n });
    offset += n;
  }
  const merged = geos.length ? mergeGeometries(geos, false)! : new THREE.BufferGeometry();
  geos.forEach((g) => g.dispose());
  merged.computeVertexNormals();
  const mat = addUnderwater(new THREE.MeshStandardMaterial({ color: 0xf3f1ec, vertexColors: true, roughness: 0.9 }));
  const mesh = new THREE.Mesh(merged, mat);
  mesh.castShadow = mesh.receiveShadow = true;
  const edges = new THREE.EdgesGeometry(merged, 30);
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x9d978e, transparent: true, opacity: 0.6 });
  const group = new THREE.Group();
  group.add(mesh, new THREE.LineSegments(edges, edgeMat));

  const white = new THREE.Color(1, 1, 1);
  const tint = new THREE.Color();
  return {
    group,
    setTint(i: number, color: THREE.Color | null, amount = 0.85) {
      const r = ranges[i];
      if (!r || !r.count) return;
      tint.copy(white);
      if (color) tint.lerp(color, amount);
      const attr = merged.attributes.color as THREE.BufferAttribute;
      for (let k = r.start; k < r.start + r.count; k++) attr.setXYZ(k, tint.r, tint.g, tint.b);
      attr.needsUpdate = true;
    },
    dispose() {
      merged.dispose();
      edges.dispose();
      mat.dispose();
      edgeMat.dispose();
    },
  };
}
