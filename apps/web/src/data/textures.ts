import * as THREE from 'three';
import { rng } from './buildings';

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

/** Horizontal timber planks, light grain; tinted per house by vertex colour (paint/varnish). 1 tile = 1 m. */
export function plankTexture() {
  const { c, g } = canvas(256, 256);
  const rand = rng(7);
  const boards = 7; // ~14 cm boards
  for (let b = 0; b < boards; b++) {
    const y = (b * 256) / boards;
    const shade = 225 + rand() * 30;
    g.fillStyle = `rgb(${shade},${shade},${shade})`;
    g.fillRect(0, y, 256, 256 / boards);
    for (let k = 0; k < 40; k++) {
      g.strokeStyle = `rgba(90,70,50,${0.04 + rand() * 0.05})`;
      g.beginPath();
      const yy = y + rand() * (256 / boards);
      g.moveTo(0, yy);
      g.bezierCurveTo(80, yy + rand() * 3 - 1.5, 170, yy + rand() * 3 - 1.5, 256, yy);
      g.stroke();
    }
    g.fillStyle = 'rgba(40,28,18,0.55)'; // shadow line under each board's lap
    g.fillRect(0, y + 256 / boards - 3, 256, 3);
  }
  return finish(c);
}

/** Corrugated zinc with weathering and rust streaks. u runs across the ridges. 1 tile = 1 m. */
export function zincTexture() {
  const { c, g } = canvas(256, 512);
  const rand = rng(11);
  for (let x = 0; x < 256; x++) {
    const v = 0.5 + 0.5 * Math.sin((x / 256) * Math.PI * 2 * 13); // ~7.6 cm pitch
    const l = Math.round(150 + v * 70);
    g.fillStyle = `rgb(${l},${l + 3},${l + 6})`;
    g.fillRect(x, 0, 1, 512);
  }
  for (let k = 0; k < 26; k++) {
    const x = rand() * 256;
    const len = 80 + rand() * 300;
    const grad = g.createLinearGradient(0, 0, 0, len);
    grad.addColorStop(0, `rgba(140,72,30,${0.25 + rand() * 0.3})`);
    grad.addColorStop(1, 'rgba(140,72,30,0)');
    g.fillStyle = grad;
    g.fillRect(x, rand() * 100, 3 + rand() * 10, len);
  }
  for (let k = 0; k < 1500; k++) {
    g.fillStyle = `rgba(80,70,60,${rand() * 0.08})`;
    g.fillRect(rand() * 256, rand() * 512, 2, 2);
  }
  return finish(c);
}

/** Terracotta clay roof tiles (Marseille-style rows). 1 tile = 1 m. */
export function clayTileTexture() {
  const { c, g } = canvas(256, 256);
  const rand = rng(13);
  const rows = 6;
  const cols = 5;
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) {
      const x = (k + (r % 2) * 0.5) * (256 / cols);
      const y = r * (256 / rows);
      const hue = 14 + rand() * 8;
      g.fillStyle = `hsl(${hue}, ${48 + rand() * 12}%, ${44 + rand() * 10}%)`;
      g.fillRect(x - 256 / cols, y, 256 / cols - 2, 256 / rows - 3);
      g.fillRect(x, y, 256 / cols - 2, 256 / rows - 3);
    }
    g.fillStyle = 'rgba(50,20,10,0.45)';
    g.fillRect(0, r * (256 / rows) + 256 / rows - 4, 256, 4);
  }
  return finish(c);
}

/** Smooth rendered plaster with faint staining near the bottom. */
export function plasterTexture() {
  const { c, g } = canvas(128, 128);
  const rand = rng(17);
  g.fillStyle = '#f2f0ea';
  g.fillRect(0, 0, 128, 128);
  for (let k = 0; k < 600; k++) {
    g.fillStyle = `rgba(120,110,95,${rand() * 0.05})`;
    g.fillRect(rand() * 128, rand() * 128, 2, 2);
  }
  return finish(c);
}

/** Louvred timber window shutters. */
export function louvreTexture() {
  const { c, g } = canvas(64, 128);
  g.fillStyle = '#4a3322';
  g.fillRect(0, 0, 64, 128);
  g.fillStyle = '#5f4430';
  for (let y = 8; y < 120; y += 7) g.fillRect(6, y, 52, 4);
  g.strokeStyle = '#2c1e14';
  g.lineWidth = 4;
  g.strokeRect(2, 2, 60, 124);
  g.beginPath();
  g.moveTo(32, 2);
  g.lineTo(32, 126);
  g.stroke();
  return finish(c, true, false);
}

/** Glazed window with white frame (modern houses). */
export function glazedWindowTexture() {
  const { c, g } = canvas(64, 64);
  g.fillStyle = '#f4f2ec';
  g.fillRect(0, 0, 64, 64);
  const grad = g.createLinearGradient(0, 0, 64, 64);
  grad.addColorStop(0, '#5d6a6b');
  grad.addColorStop(1, '#2e3536');
  g.fillStyle = grad;
  g.fillRect(6, 6, 24, 52);
  g.fillRect(34, 6, 24, 52);
  return finish(c, true, false);
}

/** Coconut frond: a central rib with drooping leaflets (alpha). */
export function frondTexture() {
  const { c, g } = canvas(128, 512);
  g.clearRect(0, 0, 128, 512);
  g.strokeStyle = '#7a8a3c';
  g.lineWidth = 4;
  g.beginPath();
  g.moveTo(64, 0);
  g.lineTo(64, 512);
  g.stroke();
  for (let y = 10; y < 500; y += 9) {
    const len = 58 * Math.sin((y / 512) * Math.PI) + 6;
    for (const side of [-1, 1]) {
      g.strokeStyle = `hsl(${85 + (y % 7)}, 45%, ${30 + (y % 11)}%)`;
      g.lineWidth = 3.5;
      g.beginPath();
      g.moveTo(64, y);
      g.quadraticCurveTo(64 + side * len * 0.6, y + 6, 64 + side * len, y + 22);
      g.stroke();
    }
  }
  return finish(c, true, false);
}

/** Broad banana leaf with a few tears (alpha). */
export function bananaLeafTexture() {
  const { c, g } = canvas(128, 512);
  g.clearRect(0, 0, 128, 512);
  g.fillStyle = '#6e9a3a';
  g.beginPath();
  g.moveTo(64, 0);
  g.bezierCurveTo(130, 120, 130, 400, 64, 512);
  g.bezierCurveTo(-2, 400, -2, 120, 64, 0);
  g.fill();
  g.strokeStyle = 'rgba(40,60,20,0.5)';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(64, 0);
  g.lineTo(64, 512);
  g.stroke();
  g.globalCompositeOperation = 'destination-out';
  const rand = rng(3);
  for (let k = 0; k < 7; k++) {
    const y = 80 + rand() * 360;
    const side = rand() < 0.5 ? -1 : 1;
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(64 + side * 6, y);
    g.lineTo(64 + side * 70, y + 30);
    g.stroke();
  }
  return finish(c, true, false);
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

/** Casement window behind a white security grille, as on most Malaysian houses. */
export function grilleWindowTexture() {
  const { c, g } = canvas(128, 128);
  g.fillStyle = '#f5f3ee';
  g.fillRect(0, 0, 128, 128);
  const glass = g.createLinearGradient(0, 0, 128, 128);
  glass.addColorStop(0, '#7b8a88');
  glass.addColorStop(0.5, '#4d5958');
  glass.addColorStop(1, '#5f6c6b');
  g.fillStyle = glass;
  g.fillRect(10, 10, 52, 108);
  g.fillRect(66, 10, 52, 108);
  g.fillStyle = 'rgba(255,255,255,0.18)';
  g.fillRect(14, 14, 10, 100);
  g.fillRect(70, 14, 10, 100);
  // Grille: vertical bars with a decorative band.
  g.strokeStyle = '#e9e7e1';
  g.lineWidth = 3;
  for (let x = 16; x < 120; x += 12) {
    g.beginPath();
    g.moveTo(x, 8);
    g.lineTo(x, 120);
    g.stroke();
  }
  for (const y of [40, 88]) {
    g.beginPath();
    g.moveTo(8, y);
    g.lineTo(120, y);
    g.stroke();
    for (let x = 16; x < 116; x += 24) {
      g.beginPath();
      g.arc(x + 6, y, 6, 0, Math.PI * 2);
      g.stroke();
    }
  }
  return finish(c, true, false);
}

/** Decorative concrete breeze blocks (ventilation wall). 1 tile = 1 m. */
export function breezeBlockTexture() {
  const { c, g } = canvas(128, 128);
  g.fillStyle = '#e4e0d6';
  g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const x = i * 32 + 16;
      const y = j * 32 + 16;
      g.fillStyle = '#5c5a55';
      g.beginPath();
      g.arc(x, y, 10, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#cfcabe';
      g.lineWidth = 2;
      g.strokeRect(i * 32 + 1, j * 32 + 1, 30, 30);
    }
  }
  return finish(c);
}
