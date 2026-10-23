// Illustrative Dec 2014 curves until Workstream C's replay (JPS + GloFAS) feeds /hazards.
// Shape only: rain builds over the hills, the river responds with a lag, peaks around 24 Dec.

export const REPLAY_START_MS = Date.UTC(2014, 11, 21, 16); // 22 Dec 2014 00:00 MYT
export const REPLAY_HOURS = 72;
export const PEAK_STAGE_M = 18; // order of the 2014 rise at Kuala Krai; VERIFY against JPS replay

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Rain intensity 0..1. */
export function rainIntensity(h: number): number {
  const base = smooth(1, 16, h) * (1 - 0.8 * smooth(44, 62, h));
  return Math.min(1, base * (0.86 + 0.14 * Math.sin(h * 0.85)));
}

const ACC_STEPS = 720;
const accTable = (() => {
  const t = new Float32Array(ACC_STEPS + 1);
  const dh = REPLAY_HOURS / ACC_STEPS;
  for (let i = 1; i <= ACC_STEPS; i++) t[i] = t[i - 1] + rainIntensity(i * dh) * dh;
  const total = t[ACC_STEPS];
  for (let i = 0; i <= ACC_STEPS; i++) t[i] /= total;
  return t;
})();

/** Accumulated rain 0..1 over the replay window. */
export function rainAccumulated(h: number): number {
  const x = Math.min(1, Math.max(0, h / REPLAY_HOURS)) * ACC_STEPS;
  const i = Math.floor(x);
  return i >= ACC_STEPS ? accTable[ACC_STEPS] : accTable[i] + (accTable[i + 1] - accTable[i]) * (x - i);
}

/** Main-river stage rise above normal (m), "likely" scenario. */
export function stageM(h: number): number {
  return PEAK_STAGE_M * Math.pow(smooth(8, 62, h), 1.25);
}

/** "Worst case" stage rise (m). */
export function worstStageM(h: number): number {
  return stageM(h) * 1.3 + 2 * smooth(4, 30, h);
}

export function replayDate(h: number): Date {
  return new Date(REPLAY_START_MS + h * 3600_000);
}

/** First replay hour at which a point with the given depth function becomes wet, or null. */
export function firstWetHour(depthForStage: (stage: number) => number, worst = false): number | null {
  for (let h = 0; h <= REPLAY_HOURS; h += 0.5) {
    if (depthForStage(worst ? worstStageM(h) : stageM(h)) > 0.05) return h;
  }
  return null;
}
