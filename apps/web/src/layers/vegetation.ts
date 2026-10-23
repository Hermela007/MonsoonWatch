import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { distToLane, rng, type House, type Lane } from '../data/buildings';
import { bananaLeafTexture, frondTexture } from '../data/textures';

/** Bend a vertical strip (base at y=0, length `len`) into an arching, drooping leaf pointing along +z. */
function arch(geo: THREE.PlaneGeometry, len: number, lift: number, droop: number) {
  const p = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const s = p.getY(i) / len; // 0..1 along the leaf
    const w = p.getX(i) * (1 - s * 0.55);
    p.setXYZ(i, w, (lift * s - droop * s * s) * len, s * len * 0.95);
  }
  geo.computeVertexNormals();
  return geo;
}

function palmTemplate(rand: () => number) {
  const H = 10;
  const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(0, -0.5, 0), new THREE.Vector3(0.2, 3, 0), new THREE.Vector3(0.8, 6.5, 0), new THREE.Vector3(1.5, H, 0)]);
  const trunk = new THREE.TubeGeometry(curve, 16, 0.17, 7);
  const fronds: THREE.BufferGeometry[] = [];
  const n = 13;
  for (let i = 0; i < n; i++) {
    const g = arch(new THREE.PlaneGeometry(1.1, 4.4, 1, 10).translate(0, 2.2, 0), 4.4, 0.55 + rand() * 0.3, 0.9 + rand() * 0.5);
    g.rotateX(-0.15 - rand() * 0.2);
    g.rotateY((i / n) * Math.PI * 2 + rand() * 0.3);
    g.translate(1.5, H, 0);
    fronds.push(g);
  }
  const withUv = (g: THREE.BufferGeometry) => {
    const ng = g.index ? g.toNonIndexed() : g;
    if (!ng.attributes.uv) ng.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(ng.attributes.position.count * 2), 2));
    return ng;
  };
  const nuts = [0, 1, 2, 3].map((k) => withUv(new THREE.IcosahedronGeometry(0.16, 0).translate(1.5 + Math.cos(k * 1.6) * 0.22, H - 0.35, Math.sin(k * 1.6) * 0.22)));
  return { trunk: mergeGeometries([withUv(trunk), ...nuts], false)!, leaves: mergeGeometries(fronds.map((g) => g.toNonIndexed()), false)! };
}

function bananaTemplate(rand: () => number) {
  const stem = new THREE.CylinderGeometry(0.11, 0.16, 2.2, 7).translate(0, 1.1, 0);
  const leaves: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 7; i++) {
    const g = arch(new THREE.PlaneGeometry(0.75, 2.4, 1, 8).translate(0, 1.2, 0), 2.4, 0.7, 0.75 + rand() * 0.3);
    g.rotateY((i / 7) * Math.PI * 2 + rand() * 0.4);
    g.translate(0, 2.0, 0);
    leaves.push(g.toNonIndexed());
  }
  return { trunk: stem.toNonIndexed(), leaves: mergeGeometries(leaves, false)! };
}

function treeTemplate(rand: () => number) {
  const trunk = new THREE.CylinderGeometry(0.17, 0.3, 3.6, 7).translate(0, 1.8, 0);
  const blobs: THREE.BufferGeometry[] = [];
  const col = new THREE.Color();
  for (let k = 0; k < 7; k++) {
    const r = 1.3 + rand() * 0.9;
    const g = new THREE.IcosahedronGeometry(r, 1).toNonIndexed();
    const p = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) p.setXYZ(i, p.getX(i) * (1 + (rand() - 0.5) * 0.15), p.getY(i) * 0.8, p.getZ(i) * (1 + (rand() - 0.5) * 0.15));
    g.translate((rand() - 0.5) * 2.6, 4.2 + rand() * 1.6, (rand() - 0.5) * 2.6);
    const c = new Float32Array(p.count * 3);
    col.setHSL(0.27 + rand() * 0.05, 0.38 + rand() * 0.15, 0.22 + rand() * 0.1);
    for (let i = 0; i < p.count; i++) c.set([col.r, col.g, col.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    g.computeVertexNormals();
    blobs.push(g);
  }
  return { trunk: trunk.toNonIndexed(), leaves: mergeGeometries(blobs, false)! };
}

/** Coconut palms, banana plants and fruit trees around the houses — instanced. */
export function createVegetation(houses: House[], lanes: Lane[], groundY: (x: number, z: number) => number, seed: number, radiusM: number) {
  const rand = rng(seed + 99);
  const group = new THREE.Group();
  const owned: { dispose(): void }[] = [];
  const frond = frondTexture();
  const banana = bananaLeafTexture();
  owned.push(frond, banana);

  const free = (x: number, z: number, pad: number) =>
    houses.every((h) => Math.hypot(h.x - x, h.z - z) > Math.max(h.w, h.d) * 0.62 + pad) &&
    lanes.every((l) => distToLane(l, x, z) > 6);

  const spots = { palm: [] as THREE.Matrix4[], banana: [] as THREE.Matrix4[], tree: [] as THREE.Matrix4[] };
  const place = (kind: keyof typeof spots, x: number, z: number, s: number) =>
    spots[kind].push(new THREE.Matrix4().compose(new THREE.Vector3(x, groundY(x, z), z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI * 2), new THREE.Vector3(s, s, s)));

  for (const h of houses) {
    for (const [kind, n, r0, r1] of [['palm', rand() < 0.3 ? 1 : 0, 8, 14], ['banana', rand() < 0.25 ? 1 : 0, 7, 10], ['tree', rand() < 0.55 ? 1 : 0, 9, 14]] as const) {
      for (let k = 0; k < n; k++) {
        const a = rand() * Math.PI * 2;
        const r = r0 + rand() * (r1 - r0);
        const x = h.x + Math.cos(a) * r;
        const z = h.z + Math.sin(a) * r;
        if (free(x, z, 1.5)) place(kind, x, z, kind === 'palm' ? 0.8 + rand() * 0.45 : 0.85 + rand() * 0.4);
      }
    }
  }
  // Orchards and scattered trees between compounds.
  for (let k = 0; k < 160; k++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * radiusM;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (free(x, z, 4)) place(rand() < 0.25 ? 'palm' : 'tree', x, z, 0.8 + rand() * 0.5);
  }

  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x8a7964, roughness: 0.95 });
  const palmLeaf = new THREE.MeshStandardMaterial({ map: frond, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.8 });
  const bananaLeaf = new THREE.MeshStandardMaterial({ map: banana, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.75 });
  const bananaStem = new THREE.MeshStandardMaterial({ color: 0x7d8f4a, roughness: 0.9 });
  const canopy = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1 });
  owned.push(trunkMat, palmLeaf, bananaLeaf, bananaStem, canopy);

  const templates = { palm: palmTemplate(rand), banana: bananaTemplate(rand), tree: treeTemplate(rand) };
  const mats = { palm: [trunkMat, palmLeaf], banana: [bananaStem, bananaLeaf], tree: [trunkMat, canopy] } as const;
  for (const kind of ['palm', 'banana', 'tree'] as const) {
    const list = spots[kind];
    if (!list.length) continue;
    const t = templates[kind];
    [t.trunk, t.leaves].forEach((geo, gi) => {
      const mesh = new THREE.InstancedMesh(geo, mats[kind][gi], list.length);
      list.forEach((mx, i) => mesh.setMatrixAt(i, mx));
      mesh.castShadow = true;
      mesh.receiveShadow = gi === 0;
      group.add(mesh);
      owned.push(geo);
    });
  }
  return { group, dispose: () => owned.forEach((o) => o.dispose()) };
}
