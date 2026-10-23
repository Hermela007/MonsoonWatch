import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { rng, type House } from '../data/buildings';
import { addUnderwater } from './underwater';

type MatKey = 'timber' | 'trim' | 'zinc' | 'tile' | 'plaster' | 'louvre' | 'glazed' | 'breeze' | 'car';
type RoofKey = 'zinc' | 'tile';

// Architectural-model palette: everything off-white, openings a touch darker. Colour is reserved for risk.
const KAMPUNG_PAINT = ['#f3f1ec', '#efede8', '#f6f4f0'];
const MODERN_PAINT = ['#f6f4f0', '#f2f0eb', '#f8f7f3', '#efece6'];
const CAR_PAINT = ['#e9e7e2'];
const DARK_TIMBER = '#d8d4cc';
const WHITE_TRIM = '#fbfaf7';

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const m = (x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) =>
  new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), tmpQ.setFromEuler(tmpE.set(rx, ry, rz, 'YXZ')), new THREE.Vector3(1, 1, 1));

/** Box whose UVs repeat once per metre (so plank/zinc/tile textures stay to scale). */
function box(w: number, h: number, d: number, unitUv = false) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (unitUv) return g;
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const f = Math.floor(i / 4);
    const [su, sv] = f < 2 ? [d, h] : f < 4 ? [w, d] : [w, h];
    uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  }
  return g;
}

function triangle(w: number, h: number, thick: number) {
  const s = new THREE.Shape([new THREE.Vector2(-w / 2, 0), new THREE.Vector2(w / 2, 0), new THREE.Vector2(0, h)]);
  return new THREE.ExtrudeGeometry(s, { depth: thick, bevelEnabled: false }).rotateY(Math.PI / 2).translate(-thick / 2, 0, 0);
}

class Builder {
  readonly buckets = new Map<MatKey, THREE.BufferGeometry[]>();
  readonly counts = new Map<MatKey, number>();
  readonly roofRanges: { house: number; key: RoofKey; start: number; count: number }[] = [];
  house = 0;
  houseM = new THREE.Matrix4();
  private col = new THREE.Color();

  add(key: MatKey, geo: THREE.BufferGeometry, local: THREE.Matrix4, color: string) {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    for (const name of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(name)) g.deleteAttribute(name);
    g.applyMatrix4(tmpM.copy(this.houseM).multiply(local));
    const n = g.attributes.position.count;
    this.col.set(color);
    const c = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) c.set([this.col.r, this.col.g, this.col.b], i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    const start = this.counts.get(key) ?? 0;
    if (key === 'zinc' || key === 'tile') this.roofRanges.push({ house: this.house, key, start, count: n });
    this.counts.set(key, start + n);
    if (!this.buckets.has(key)) this.buckets.set(key, []);
    this.buckets.get(key)!.push(g);
  }

  /** Hip roof over L × W walls (L ≥ W) whose top is at y0, with white fascia boards. */
  hipRoof(xf: THREE.Matrix4, L: number, W: number, y0: number, pitch: number, oh: number, key: RoofKey) {
    const t = Math.tan(pitch);
    const cos = Math.cos(pitch);
    const Lp = L + 2 * oh;
    const Wp = W + 2 * oh;
    const ye = y0 - oh * t + 0.05;
    const yr = ye + (Wp / 2) * t;
    const r = Math.max(0, (Lp - Wp) / 2);
    const A = [-Lp / 2, ye, -Wp / 2], B = [Lp / 2, ye, -Wp / 2], C = [Lp / 2, ye, Wp / 2], D = [-Lp / 2, ye, Wp / 2];
    const R1 = [-r, yr, 0], R2 = [r, yr, 0];
    const tris = [[D, C, R2], [D, R2, R1], [B, A, R1], [B, R1, R2], [A, D, R1], [C, B, R2]];
    const pos: number[] = [];
    const uv: number[] = [];
    tris.forEach((tri, k) => {
      for (const v of tri) {
        pos.push(v[0], v[1], v[2]);
        if (k < 4) uv.push(v[0], (Wp / 2 - Math.abs(v[2])) / cos);
        else uv.push(v[2], (Lp / 2 - Math.abs(v[0])) / cos);
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    this.add(key, g, xf, '#ffffff');
    for (const z of [-Wp / 2, Wp / 2]) this.add('trim', box(Lp + 0.05, 0.22, 0.05), xf.clone().multiply(m(0, ye - 0.08, z)), WHITE_TRIM);
    for (const x of [-Lp / 2, Lp / 2]) this.add('trim', box(0.05, 0.22, Wp + 0.05), xf.clone().multiply(m(x, ye - 0.08, 0)), WHITE_TRIM);
    return yr;
  }

  /** Gable roof, ridge along local x, sitting on walls of size L × W whose top is at y0. */
  gableRoof(xf: THREE.Matrix4, L: number, W: number, y0: number, pitch: number, oh: number, roofKey: RoofKey, gableKey: MatKey, gableColor: string, layang: boolean) {
    const t = Math.tan(pitch);
    const hw = W / 2 + oh;
    const slope = hw / Math.cos(pitch);
    for (const side of [-1, 1]) {
      const y = y0 + (W / 2 - hw / 2) * t + 0.04;
      this.add(roofKey, box(L + 2 * oh, 0.05, slope), xf.clone().multiply(m(0, y, (side * hw) / 2, side * pitch)), '#ffffff');
    }
    const ridgeY = y0 + (W / 2) * t;
    this.add('trim', box(L + 2 * oh, 0.1, 0.28), xf.clone().multiply(m(0, ridgeY + 0.06, 0)), roofKey === 'zinc' ? '#9a9c98' : '#9c4a2c');
    for (const end of [-1, 1]) {
      this.add(gableKey, triangle(W, (W / 2) * t, 0.06), xf.clone().multiply(m((end * L) / 2, y0, 0)), gableColor);
      if (!layang) continue;
      // Papan layang: the Kelantan gable boards, crossing above the ridge.
      for (const side of [-1, 1]) {
        const up = new THREE.Vector3(0, Math.sin(pitch), -side * Math.cos(pitch));
        const c = new THREE.Vector3(end * (L / 2 + oh * 0.9), y0 + (W / 2 - hw / 2) * t + 0.14, (side * hw) / 2).addScaledVector(up, 0.32);
        this.add('trim', box(0.07, 0.26, slope + 0.65), xf.clone().multiply(m(c.x, c.y, c.z, side * pitch)), WHITE_TRIM);
      }
    }
  }
}

function kampungHouse(b: Builder, h: House, rand: () => number) {
  const L = h.w;
  const W = h.d;
  const stiltH = 1.2 + rand() * 0.8;
  const floorT = 0.2;
  const wallH = 2.6;
  const paint = KAMPUNG_PAINT[Math.floor(rand() * KAMPUNG_PAINT.length)];
  const stiltCol = rand() < 0.5 ? '#e2dfd9' : '#d8d4cc';
  const id = new THREE.Matrix4();
  const floorY = stiltH + floorT;

  // Stilts (tiang), buried a little into the ground.
  const nx = Math.max(3, Math.round(L / 2.3) + 1);
  for (let i = 0; i < nx; i++) {
    const x = -L / 2 + 0.25 + (i * (L - 0.5)) / (nx - 1);
    for (const z of [-W / 2 + 0.15, 0, W / 2 - 0.15]) b.add('trim', box(0.2, stiltH + 0.3, 0.2), m(x, (stiltH - 0.3) / 2, z), stiltCol);
  }
  b.add('trim', box(L + 0.25, floorT, W + 0.25), m(0, stiltH + floorT / 2, 0), DARK_TIMBER);
  b.add('timber', box(L, wallH, W), m(0, floorY + wallH / 2, 0), paint);
  // Skirting and wall-plate boards.
  b.add('trim', box(L + 0.06, 0.12, W + 0.06), m(0, floorY + 0.06, 0), DARK_TIMBER);
  b.add('trim', box(L + 0.06, 0.12, W + 0.06), m(0, floorY + wallH - 0.06, 0), DARK_TIMBER);

  // Louvred windows on the long sides, door in the middle of the front.
  const nw = Math.max(2, Math.floor(L / 2.4));
  for (const side of [-1, 1]) {
    for (let i = 0; i < nw; i++) {
      const x = -L / 2 + ((i + 0.5) * L) / nw;
      if (side > 0 && Math.abs(x) < 0.9) continue;
      b.add('louvre', box(0.95, 1.35, 0.05, true), m(x, floorY + 1.3, side * (W / 2 + 0.03)), '#ffffff');
    }
  }
  b.add('louvre', box(0.95, 2.0, 0.05, true), m(0, floorY + 1.0, W / 2 + 0.03), '#ffffff');

  // Verandah (serambi) across part of the front, a step lower, with its own lean-to roof.
  let stairTop = floorY;
  let stairZ = W / 2;
  if (rand() < 0.6) {
    const Lv = L * (0.5 + rand() * 0.3);
    const Dv = 2.2;
    const vy = floorY - 0.3;
    b.add('trim', box(Lv, 0.14, Dv), m(0, vy - 0.07, W / 2 + Dv / 2), DARK_TIMBER);
    for (const x of [-Lv / 2 + 0.1, 0, Lv / 2 - 0.1]) {
      b.add('trim', box(0.16, vy + 0.3, 0.16), m(x, (vy - 0.3) / 2, W / 2 + Dv - 0.1), stiltCol);
      b.add('trim', box(0.12, 2.5, 0.12), m(x, vy + 1.25, W / 2 + Dv - 0.1), DARK_TIMBER);
    }
    b.add('trim', box(Lv, 0.07, 0.07), m(0, vy + 0.85, W / 2 + Dv - 0.1), paint);
    for (let k = 0; k < Math.floor(Lv / 0.35); k++) {
      const x = -Lv / 2 + 0.2 + k * 0.35;
      if (Math.abs(x) > 0.6) b.add('trim', box(0.04, 0.8, 0.04), m(x, vy + 0.45, W / 2 + Dv - 0.1), paint);
    }
    b.add('zinc', box(Lv + 0.5, 0.04, Dv + 0.6), m(0, floorY + wallH - 0.25 - 0.3, W / 2 + Dv / 2 + 0.2, 0.22), '#ffffff');
    stairTop = vy;
    stairZ = W / 2 + Dv;
  }
  // Front stairs (tangga).
  const steps = Math.max(3, Math.ceil(stairTop / 0.22));
  for (let k = 0; k < steps; k++) {
    const y = stairTop - ((k + 1) * stairTop) / (steps + 0.5);
    b.add('trim', box(1.05, 0.06, 0.3), m(0, y, stairZ + 0.15 + k * 0.26), '#cfcac2');
  }
  for (const x of [-0.55, 0.55]) {
    const len = Math.hypot(stairTop, steps * 0.26);
    b.add('trim', box(0.06, 0.22, len), m(x, stairTop / 2, stairZ + (steps * 0.26) / 2, Math.atan2(stairTop, steps * 0.26)), '#d8d4cc');
  }

  b.gableRoof(id, L, W, floorY + wallH, 0.72, 0.75, 'zinc', 'timber', paint, true);

  // Kitchen wing (dapur) at the back, lower floor, roof at right angles.
  if (rand() < 0.55) {
    const Lk = L * 0.42;
    const Wk = 3.4;
    const xo = (rand() < 0.5 ? -1 : 1) * L * 0.18;
    const zc = -W / 2 - Wk / 2 + 0.05;
    const fy = floorY - 0.25;
    for (const x of [xo - Lk / 2 + 0.15, xo + Lk / 2 - 0.15]) for (const z of [zc - Wk / 2 + 0.15, zc + Wk / 2 - 0.15]) b.add('trim', box(0.18, fy + 0.3, 0.18), m(x, (fy - 0.3) / 2, z), stiltCol);
    b.add('timber', box(Lk, 2.3, Wk), m(xo, fy + 1.15, zc), paint);
    b.add('louvre', box(0.8, 1.0, 0.05, true), m(xo, fy + 1.3, zc - Wk / 2 - 0.03), '#ffffff');
    b.gableRoof(m(xo, 0, zc, 0, Math.PI / 2), Wk, Lk, fy + 2.3, 0.6, 0.45, 'zinc', 'timber', paint, false);
  }
}

const shade = (hex: string, k: number) => '#' + new THREE.Color(hex).multiplyScalar(k).getHexString();

/** Window with grille, concrete hood above and sill below, on a wall facing local +z (rotated by `ry`). */
function windowUnit(b: Builder, x: number, y: number, z: number, ry: number, w = 1.5, h = 1.35) {
  const xf = m(x, y, z, 0, ry);
  b.add('glazed', box(w, h, 0.05, true), xf, '#ffffff');
  b.add('plaster', box(w + 0.5, 0.08, 0.5), xf.clone().multiply(m(0, h / 2 + 0.22, 0.22)), WHITE_TRIM);
  b.add('plaster', box(w + 0.2, 0.07, 0.18), xf.clone().multiply(m(0, -h / 2 - 0.05, 0.08)), WHITE_TRIM);
}

function car(b: Builder, x: number, y: number, z: number, ry: number, rand: () => number) {
  const paint = CAR_PAINT[Math.floor(rand() * CAR_PAINT.length)];
  const xf = m(x, y, z, 0, ry);
  b.add('car', box(1.78, 0.62, 4.4), xf.clone().multiply(m(0, 0.58, 0)), paint);
  b.add('car', box(1.58, 0.52, 2.3), xf.clone().multiply(m(0, 1.14, -0.25)), paint);
  b.add('glazed', box(1.6, 0.42, 2.2, true), xf.clone().multiply(m(0, 1.16, -0.25)), '#3c4446');
  for (const [wx, wz] of [[-0.82, 1.35], [0.82, 1.35], [-0.82, -1.35], [0.82, -1.35]])
    b.add('trim', new THREE.CylinderGeometry(0.33, 0.33, 0.24, 14).rotateZ(Math.PI / 2), xf.clone().multiply(m(wx, 0.33, wz)), '#1e1e1e');
}

/** Low boundary wall with pillars around a plot, leaving a gate opening (with a sliding gate) at the front. */
function compoundWall(b: Builder, PL: number, PW: number, zc: number, gateX: number, gateW: number, wallColor: string) {
  const H = 1.25;
  const segs: [number, number, number, number][] = [
    [-PL / 2, zc - PW / 2, PL / 2, zc - PW / 2],
    [-PL / 2, zc - PW / 2, -PL / 2, zc + PW / 2],
    [PL / 2, zc - PW / 2, PL / 2, zc + PW / 2],
    [-PL / 2, zc + PW / 2, gateX - gateW / 2, zc + PW / 2],
    [gateX + gateW / 2, zc + PW / 2, PL / 2, zc + PW / 2],
  ];
  for (const [x0, z0, x1, z1] of segs) {
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 0.3) continue;
    const along = Math.abs(z1 - z0) < 1e-6;
    b.add('plaster', along ? box(len, H, 0.15) : box(0.15, H, len), m((x0 + x1) / 2, H / 2 - 0.1, (z0 + z1) / 2), wallColor);
    const n = Math.max(1, Math.round(len / 3));
    for (let k = 0; k <= n; k++) {
      const px = x0 + ((x1 - x0) * k) / n;
      const pz = z0 + ((z1 - z0) * k) / n;
      b.add('plaster', box(0.32, H + 0.25, 0.32), m(px, (H + 0.25) / 2 - 0.1, pz), shade(wallColor, 0.92));
    }
  }
  // Sliding metal gate.
  const gz = zc + PW / 2;
  b.add('trim', box(gateW, 0.06, 0.06), m(gateX, 1.15, gz), '#4a4d4f');
  b.add('trim', box(gateW, 0.06, 0.06), m(gateX, 0.12, gz), '#4a4d4f');
  for (let k = 0; k <= Math.round(gateW / 0.14); k++) b.add('trim', box(0.03, 1.05, 0.03), m(gateX - gateW / 2 + k * 0.14, 0.64, gz), '#4a4d4f');
}

/** Detached single-storey bungalow: hip roof, grilled windows with hoods, porch, car porch, walled plot. */
function modernHouse(b: Builder, h: House, rand: () => number) {
  const L = Math.max(h.w, h.d);
  const W = Math.min(h.w, h.d);
  const wallH = 3.1;
  const base = 0.45;
  const paint = MODERN_PAINT[Math.floor(rand() * MODERN_PAINT.length)];
  const id = new THREE.Matrix4();
  b.add('plaster', box(L + 0.3, 0.6, W + 0.3), m(0, base - 0.3, 0), '#bdb7aa');
  b.add('plaster', box(L, wallH, W), m(0, base + wallH / 2, 0), paint);
  b.add('plaster', box(L + 0.04, 0.85, W + 0.04), m(0, base + 0.42, 0), shade(paint, 0.85)); // dado
  // Front: door in the middle, windows either side.
  const doorX = -L * 0.12;
  b.add('trim', box(1.7, 2.35, 0.08), m(doorX, base + 1.18, W / 2 + 0.03), '#cfcac2');
  b.add('trim', box(1.95, 2.55, 0.06), m(doorX, base + 1.28, W / 2 + 0.01), WHITE_TRIM);
  for (const x of [doorX - 2.6, doorX + 2.4, doorX + 4.6]) if (Math.abs(x) < L / 2 - 1) windowUnit(b, x, base + 1.75, W / 2 + 0.03, 0);
  for (let i = 0; i < Math.max(2, Math.floor(L / 3.6)); i++) windowUnit(b, -L / 2 + 2 + i * 3.6, base + 1.75, -W / 2 - 0.03, Math.PI);
  for (const side of [-1, 1]) windowUnit(b, side * (L / 2 + 0.03), base + 1.75, 0, (side * Math.PI) / 2);
  // Front porch.
  const pw = 3.6;
  b.add('plaster', box(pw, 0.2, 2.4), m(doorX, base - 0.05, W / 2 + 1.2), '#c9c3b5');
  for (const x of [doorX - pw / 2 + 0.2, doorX + pw / 2 - 0.2]) b.add('plaster', box(0.32, wallH, 0.32), m(x, base + wallH / 2, W / 2 + 2.2), WHITE_TRIM);
  b.add('plaster', box(pw + 0.4, 0.2, 2.8), m(doorX, base + wallH - 0.1, W / 2 + 1.35), WHITE_TRIM);
  const roofTop = b.hipRoof(id, L, W, base + wallH, 0.5, 0.7, rand() < 0.75 ? 'tile' : 'zinc');
  // Car porch on the side, with breeze-block screen and (often) a car.
  const cx = L / 2 + 1.9;
  b.add('plaster', box(3.6, 0.18, 6.2), m(cx, 2.95, 0.9), WHITE_TRIM);
  for (const z of [-1.9, 3.7]) b.add('plaster', box(0.3, 2.95, 0.3), m(cx + 1.6, 1.47, z), WHITE_TRIM);
  b.add('plaster', box(3.6, 0.1, 6.2), m(cx, 0.03, 0.9), '#b7b1a5');
  b.add('breeze', box(0.15, 2.0, 2.4), m(cx + 1.65, 1.0, -0.6), '#ffffff');

  compoundWall(b, L + 8.5, W + 12, 1.6, cx, 4.2, rand() < 0.5 ? '#f0ece3' : shade(paint, 0.95));
  return roofTop;
}

/** A row of single-storey terrace houses: party walls above the roof, a porch, gate and car per unit. */
function terraceRow(b: Builder, h: House, rand: () => number) {
  const n = h.units ?? Math.max(2, Math.round(h.w / 6.5));
  const uw = h.w / n;
  const D = Math.min(h.d, 12);
  const wallH = 3.0;
  const base = 0.4;
  const rowPaint = MODERN_PAINT[Math.floor(rand() * MODERN_PAINT.length)];
  const pitch = 0.45;
  const wallTop = base + wallH;
  const rise = (D / 2) * Math.tan(pitch);
  b.add('plaster', box(h.w + 0.2, 0.5, D + 0.2), m(0, base - 0.25, 0), '#bdb7aa');
  for (let i = 0; i < n; i++) {
    const x = -h.w / 2 + uw * (i + 0.5);
    const paint = rand() < 0.3 ? MODERN_PAINT[Math.floor(rand() * MODERN_PAINT.length)] : rowPaint;
    b.add('plaster', box(uw - 0.02, wallH, D), m(x, base + wallH / 2, 0), paint);
    b.add('plaster', box(uw, 0.8, D + 0.04), m(x, base + 0.4, 0), shade(paint, 0.86));
    b.add('trim', box(1.0, 2.2, 0.08), m(x - uw * 0.22, base + 1.1, D / 2 + 0.03), '#cfcac2');
    windowUnit(b, x + uw * 0.18, base + 1.7, D / 2 + 0.03, 0, 1.8, 1.3);
    windowUnit(b, x, base + 1.7, -D / 2 - 0.03, Math.PI, 1.4, 1.2);
    // Porch roof and floor.
    b.add('plaster', box(uw - 0.1, 0.14, 3.0), m(x, base + wallH - 0.3, D / 2 + 1.5), WHITE_TRIM);
    b.add('plaster', box(uw - 0.1, 0.1, 5.4), m(x, 0.05, D / 2 + 2.7), '#bfb9ac');

    // Front wall with gate, side walls between units.
    b.add('plaster', box(uw * 0.28, 1.2, 0.15), m(x - uw * 0.36, 0.5, D / 2 + 5.5), '#f0ece3');
    const gw = uw * 0.68;
    b.add('trim', box(gw, 0.05, 0.05), m(x + uw * 0.14, 1.12, D / 2 + 5.5), '#4a4d4f');
    for (let k = 0; k <= Math.round(gw / 0.15); k++) b.add('trim', box(0.03, 1.0, 0.03), m(x + uw * 0.14 - gw / 2 + k * 0.15, 0.6, D / 2 + 5.5), '#4a4d4f');
  }
  for (let i = 0; i <= n; i++) {
    const x = -h.w / 2 + uw * i;
    b.add('plaster', box(0.15, 1.2, 5.5), m(x, 0.5, D / 2 + 2.75), '#f0ece3');
    // Party wall: rises just above the roof line.
    b.add('plaster', triangle(D + 0.5, rise + 0.32, 0.26), m(x, wallTop - 0.05, 0), '#e7e2d8');
    b.add('plaster', box(0.26, 0.4, D + 0.5), m(x, wallTop - 0.2, 0), '#e7e2d8');
    if (i > 0 && i < n) b.add('plaster', box(0.3, wallH - 0.3, 0.3), m(x, base + (wallH - 0.3) / 2, D / 2 + 2.9), WHITE_TRIM);
  }
  b.gableRoof(new THREE.Matrix4(), h.w, D, wallTop, pitch, 0.5, 'tile', 'plaster', rowPaint, false);
  return wallTop + rise + 0.3;
}

/** Every house merged into one mesh per material; roofs can be tinted per house. */
export function createHouses(houses: House[], groundY: (x: number, z: number) => number, seed: number) {
  const b = new Builder();
  const rand = rng(seed);
  const roofTop: number[] = [];
  houses.forEach((h, i) => {
    b.house = i;
    const base = groundY(h.x, h.z);
    b.houseM.compose(new THREE.Vector3(h.x, base, h.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), h.angle), new THREE.Vector3(1, 1, 1));
    if (h.kind === 'modern') {
      roofTop.push(base + modernHouse(b, h, rand));
    } else if (h.kind === 'terrace') {
      roofTop.push(base + terraceRow(b, h, rand));
    } else {
      kampungHouse(b, h, rand);
      roofTop.push(base + 2 + 2.8 + (h.d / 2) * Math.tan(0.72));
    }
  });

  const matte = (extra: THREE.MeshStandardMaterialParameters = {}) =>
    addUnderwater(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0, ...extra }));
  const roofBase = new THREE.Color(0xe9e6e0);
  const mats: Record<MatKey, THREE.MeshStandardMaterial> = {
    timber: matte(),
    trim: matte(),
    zinc: matte({ color: roofBase, side: THREE.DoubleSide }),
    tile: matte({ color: roofBase, side: THREE.DoubleSide }),
    plaster: matte(),
    louvre: matte({ color: 0xb9b5ae }),
    glazed: matte({ color: 0xbcc0c2, roughness: 0.35 }),
    breeze: matte({ color: 0xdedad3 }),
    car: matte(),
  };
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x9d978e, transparent: true, opacity: 0.55 });

  const group = new THREE.Group();
  const edgeGeos: THREE.BufferGeometry[] = [];
  const merged = new Map<MatKey, THREE.BufferGeometry>();
  for (const [key, geos] of b.buckets) {
    const g = mergeGeometries(geos, false);
    geos.forEach((x) => x.dispose());
    if (!g) continue;
    merged.set(key, g);
    const mesh = new THREE.Mesh(g, mats[key]);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
    // Model-maker's edge lines.
    const edges = new THREE.EdgesGeometry(g, 28);
    edgeGeos.push(edges);
    group.add(new THREE.LineSegments(edges, edgeMat));
  }

  const white = new THREE.Color(1, 1, 1);
  const tint = new THREE.Color();
  return {
    group,
    roofTop,
    /** Tint a house's roof (null = natural material). */
    setRoofTint(house: number, color: THREE.Color | null, amount = 0.9) {
      tint.copy(white);
      if (color) tint.lerp(color, amount);
      for (const r of b.roofRanges) {
        if (r.house !== house) continue;
        const attr = merged.get(r.key)!.attributes.color as THREE.BufferAttribute;
        for (let i = r.start; i < r.start + r.count; i++) attr.setXYZ(i, tint.r, tint.g, tint.b);
        attr.needsUpdate = true;
      }
    },
    dispose() {
      merged.forEach((g) => g.dispose());
      Object.values(mats).forEach((mt) => mt.dispose());
      edgeGeos.forEach((g) => g.dispose());
      edgeMat.dispose();
    },
  };
}
