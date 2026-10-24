import * as THREE from 'three';

/** Procedural canvas textures for the street scene (no external assets). */

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, g: c.getContext('2d')! };
}

function finish(c: HTMLCanvasElement, srgb = true, repeat = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

/** JPS-style staff gauge board: white with black "E" marks every 10 cm and metre numbers. 0–5 m. */
export function staffGaugeTexture() {
  const { c, g } = canvas(64, 640);
  g.fillStyle = '#f7f5ef';
  g.fillRect(0, 0, 64, 640);
  const pxPerM = 640 / 5;
  g.fillStyle = '#1b1b1b';
  g.font = 'bold 26px system-ui, sans-serif';
  for (let cm = 0; cm < 500; cm += 10) {
    const y = 640 - (cm / 100) * pxPerM;
    if ((cm / 10) % 2 === 0) g.fillRect(4, y - pxPerM / 10, 20, pxPerM / 10);
    if (cm % 50 === 0) g.fillRect(4, y - 3, 40, 3);
  }
  for (let m = 1; m < 5; m++) {
    g.fillStyle = m >= 3 ? '#c4372a' : '#1b1b1b';
    g.fillText(String(m), 34, 640 - m * pxPerM + 26);
  }
  return finish(c, true, false);
}

