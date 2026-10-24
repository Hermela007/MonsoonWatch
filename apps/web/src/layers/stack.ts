import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import type { GeoFrame } from '../geo/region';
import type { Heightmap } from '../terrain/heightmap';
import { depthAt, type Hydrology } from '../terrain/hydrology';
import { REPLAY_HOURS, worstStageM } from '../data/replay2014';
import { THEME } from '../theme';

const GAP = 24; // world km between layers when fully exploded

/** Flat "flood risk map": paper, soft relief, worst-case flood extent in green, rivers. */
function floodMapTexture(hm: Heightmap, hy: Hydrology, slidePaths: number[][]) {
  const { cols, rows } = hm;
  const canvas = document.createElement('canvas');
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(cols, rows);
  const worst = worstStageM(REPLAY_HOURS);
  for (let i = 0; i < cols * rows; i++) {
    const relief = 1 - Math.min(1, hy.slopeDeg[i] / 45) * 0.1;
    let rgb: [number, number, number] = [246 * relief, 244 * relief, 240 * relief];
    if (hy.seaMask[i]) rgb = [228, 236, 240];
    else if (hy.riverMask[i]) rgb = [47, 140, 204];
    else if (depthAt(hm, hy, i, worst) > 0.3) rgb = [169, 216, 240];
    img.data.set([rgb[0], rgb[1], rgb[2], 255], i * 4);
  }
  ctx.putImageData(img, 0, 0);
  // Upscale with smoothing so the map reads as a drawing, not grid cells.
  const S = 4;
  const big = document.createElement('canvas');
  big.width = cols * S;
  big.height = rows * S;
  const bctx = big.getContext('2d')!;
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';
  bctx.filter = 'blur(2px)';
  bctx.drawImage(canvas, 0, 0, big.width, big.height);
  bctx.filter = 'none';
  // Fine grid, like drafting paper: every ~1 km.
  bctx.strokeStyle = 'rgba(160,152,140,0.35)';
  bctx.lineWidth = 1;
  const step = big.width / 80;
  for (let x = 0; x < big.width; x += step) { bctx.beginPath(); bctx.moveTo(x, 0); bctx.lineTo(x, big.height); bctx.stroke(); }
  for (let y = 0; y < big.height; y += step) { bctx.beginPath(); bctx.moveTo(0, y); bctx.lineTo(big.width, y); bctx.stroke(); }
  // Landslide hotspots: orange runouts with a dot at the source.
  bctx.strokeStyle = '#d4542b';
  bctx.fillStyle = '#d4542b';
  bctx.lineWidth = 2 * S;
  bctx.lineJoin = bctx.lineCap = 'round';
  for (const path of slidePaths) {
    bctx.beginPath();
    path.forEach((cell, k) => {
      const x = ((cell % cols) + 0.5) * S;
      const y = (Math.floor(cell / cols) + 0.5) * S;
      if (k === 0) bctx.moveTo(x, y);
      else bctx.lineTo(x, y);
    });
    bctx.stroke();
    bctx.beginPath();
    bctx.arc(((path[0] % cols) + 0.5) * S, (Math.floor(path[0] / cols) + 0.5) * S, 4 * S, 0, Math.PI * 2);
    bctx.fill();
  }
  const tex = new THREE.CanvasTexture(big);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function softShadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 10, 64, 64, 64);
  grad.addColorStop(0, 'rgba(40,36,30,0.22)');
  grad.addColorStop(1, 'rgba(40,36,30,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function layerLabel(text: string) {
  const el = document.createElement('div');
  el.className = 'layer-label';
  el.textContent = text;
  const obj = new CSS2DObject(el);
  obj.center.set(0, 0.5);
  return { obj, el };
}

/**
 * The exploded "layer cake" for the landing view: satellite photo (bottom), the 3D terrain slab
 * (owned by valley.ts, middle) and a flat flood-risk map (top). `setExplode(0)` collapses it.
 */
export function createStack(hm: Heightmap, hy: Hydrology, frame: GeoFrame, imagery: THREE.Texture | null, slabBaseY: number, slidePaths: number[][]) {
  const group = new THREE.Group();
  const w = frame.widthKm;
  const h = frame.heightKm;
  const owned: { dispose(): void }[] = [];

  const plane = new THREE.PlaneGeometry(w, h).rotateX(-Math.PI / 2);
  const edge = new THREE.BoxGeometry(w, 0.8, h).translate(0, -0.4, 0);
  const edgeMat = new THREE.MeshBasicMaterial({ color: THEME.paperDark, transparent: true });
  owned.push(plane, edge, edgeMat);

  const mapTex = floodMapTexture(hm, hy, slidePaths);
  const topMat = new THREE.MeshBasicMaterial({ map: mapTex, transparent: true });
  const top = new THREE.Group();
  top.add(new THREE.Mesh(plane, topMat), new THREE.Mesh(edge, edgeMat));
  owned.push(mapTex, topMat);

  const bottomMat = new THREE.MeshBasicMaterial({ map: imagery ?? null, color: imagery ? 0xffffff : 0xdcd8d1, transparent: true });
  const bottom = new THREE.Group();
  bottom.add(new THREE.Mesh(plane, bottomMat), new THREE.Mesh(edge, edgeMat));
  owned.push(bottomMat);

  const shadowTex = softShadowTexture();
  const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false });
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(w * 1.7, h * 1.35).rotateX(-Math.PI / 2), shadowMat);
  owned.push(shadowTex, shadowMat, shadow.geometry);

  const labels = [layerLabel('Flood risk map'), layerLabel('3D terrain'), layerLabel('Satellite view')];
  const corner = new THREE.Vector3(w / 2 + 2, 0, h / 2 - 6);
  top.add(labels[0].obj);
  bottom.add(labels[2].obj);
  labels[0].obj.position.copy(corner);
  labels[2].obj.position.copy(corner);
  labels[1].obj.position.copy(corner).setY(0.5);
  group.add(top, bottom, shadow, labels[1].obj);

  let explode = -1;
  const api = {
    group,
    setExplode(e: number) {
      if (Math.abs(e - explode) < 1e-4) return;
      explode = e;
      top.position.y = 4 + e * GAP;
      bottom.position.y = slabBaseY - 0.2 - e * GAP;
      shadow.position.y = slabBaseY - 0.6 - GAP * 1.1;
      top.visible = bottom.visible = e > 0.02;
      topMat.opacity = bottomMat.opacity = edgeMat.opacity = Math.min(1, e * 1.5);
      shadowMat.opacity = 0.35 + 0.65 * e;
      for (const l of labels) {
        l.obj.visible = e > 0.5;
        l.el.style.opacity = String(Math.max(0, (e - 0.5) * 2));
      }
    },
    dispose() {
      owned.forEach((o) => o.dispose());
    },
  };
  api.setExplode(1);
  return api;
}
