import './styles.css';
import * as THREE from 'three';
import { GeoFrame, KELANTAN, type LngLat } from './geo/region';
import { loadTerrariumGrid } from './terrain/terrarium';
import { analyseHydrology, depthAt, landslideRisk } from './terrain/hydrology';
import { createStage } from './scene/stage';
import { createCameraDirector, type Shot } from './scene/camera';
import { createValley } from './layers/valley';
import { createRain } from './layers/rain';
import { createTowns } from './layers/towns';
import { createInspector } from './layers/inspect';
import { createHud } from './ui/hud';
import { rainAccumulated, rainIntensity, stageM, worstStageM } from './mock/replay2014';

const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => {
  const v = Number(params.get(k));
  return Number.isFinite(v) && v > 0 ? v : d;
};

const EXAG = num('exag', 2);
const COLS = Math.round(num('res', 480));
const TERRAIN_ZOOM = 10; // ≈150 m/px here
const RIVER_THRESHOLD_KM2 = 150;

async function main() {
  const frame = new GeoFrame(KELANTAN.bbox, EXAG);
  const rows = Math.round((COLS * frame.heightKm) / frame.widthKm);

  let director: ReturnType<typeof createCameraDirector> | null = null;
  const shots: Record<string, Shot> = {};
  const hud = createHud({
    onTour: () => runTour(),
    onPreset: (i) => {
      const s = Object.values(shots)[i];
      if (s && director) director.flyTo(s);
    },
  });

  hud.loading('Fetching Kelantan terrain…', 0.05);
  const hm = await loadTerrariumGrid(KELANTAN.bbox, TERRAIN_ZOOM, COLS, rows, (d, t) =>
    hud.loading(`Fetching Kelantan terrain… ${d}/${t} tiles`, 0.05 + 0.6 * (d / t)),
  );
  hud.loading('Tracing rivers and drainage…', 0.7);
  await new Promise((r) => setTimeout(r, 30));
  const hy = analyseHydrology(hm, RIVER_THRESHOLD_KM2);
  hud.loading('Building the valley…', 0.9);
  await new Promise((r) => setTimeout(r, 30));

  const stage = createStage(document.getElementById('app')!);
  const { scene, camera, controls } = stage;
  director = createCameraDirector(camera, controls);

  const valley = createValley(hm, hy, frame, stage.fogColor);
  scene.add(valley.mesh);
  const rain = createRain();
  scene.add(rain.object);
  const towns = createTowns(KELANTAN.towns, hm, hy, frame);
  scene.add(towns.group);
  const inspector = createInspector(hm, hy, frame, camera);
  scene.add(inspector.object);

  // Camera shots, all derived from lon/lat through the shared frame.
  const at = (lngLat: LngLat, elevM: number, offset: [number, number, number]): Shot => {
    const target = frame.lngLatToWorld(lngLat, elevM);
    return { target, position: target.clone().add(new THREE.Vector3(...offset)) };
  };
  const town = (name: string) => KELANTAN.towns.find((t) => t.name === name)!.lngLat;
  shots.overview = { position: new THREE.Vector3(62, 70, 118), target: new THREE.Vector3(0, 0, -18) };
  shots.kualaKrai = at(town('Kuala Krai'), 40, [7, 6, 11]);
  shots.kotaBharu = at(town('Kota Bharu'), 5, [6, 11, 20]);
  shots.hills = at([101.9, 5.05], 600, [-14, 12, 18]);
  const tourShots: Shot[] = [
    at(town('Gua Musang'), 100, [-6, 10, 18]),
    at(town('Dabong'), 60, [-9, 8, 14]),
    shots.kualaKrai,
    at(town('Tanah Merah'), 20, [-8, 7, 12]),
    shots.kotaBharu,
    shots.overview,
  ];

  const runTour = () => {
    inspector.hide();
    hud.play(true, 72 / 34);
    director!.tour(tourShots, 36000);
  };

  // Click (not drag) → inspect a point.
  const down = new THREE.Vector2();
  stage.pointerTarget.addEventListener('pointerdown', (e) => {
    down.set(e.clientX, e.clientY);
    director!.cancel();
  });
  stage.pointerTarget.addEventListener('pointerup', (e) => {
    if (down.distanceTo(new THREE.Vector2(e.clientX, e.clientY)) > 5) return;
    const rect = stage.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    inspector.pick(ndc, stageM(hud.hour));
  });

  // Readouts mirror the shader formulas on the CPU.
  const n = hm.cols * hm.rows;
  let lastReadHour = -1;
  const updateReadouts = (h: number, s: number, rainAcc: number) => {
    if (Math.abs(h - lastReadHour) < 0.25) return;
    lastReadHour = h;
    let wet = 0;
    let slope = 0;
    for (let i = 0; i < n; i++) {
      if (hy.seaMask[i]) continue;
      if (depthAt(hm, hy, i, s) > 0.05) wet++;
      else if (landslideRisk(hy.slopeDeg[i], hm.elevM[i], rainAcc) > 0.5) slope++;
    }
    hud.setReadouts({ rain: rainIntensity(h), stageM: s, floodedKm2: wet * hy.cellAreaKm2, slopeKm2: slope * hy.cellAreaKm2 });
  };

  hud.ready();
  director.flyTo(shots.overview, 4200, () => hud.play(true));

  const clock = new THREE.Clock();
  stage.renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    const t = clock.elapsedTime;
    hud.tick(dt);
    director!.update(performance.now());
    controls.update();

    const h = hud.hour;
    const s = stageM(h);
    const worst = worstStageM(h);
    const rainAcc = rainAccumulated(h);
    valley.setState({ stageM: s, worstStageM: worst, rainAcc, timeS: t });
    rain.update(controls.target, camera.position.distanceTo(controls.target), rainIntensity(h), t);
    towns.update(s);
    inspector.update(s, worst, rainAcc);
    updateReadouts(h, s, rainAcc);
    stage.render();
  });
}

main().catch((err) => {
  console.error(err);
  const el = document.getElementById('loading-msg');
  if (el) el.textContent = `Could not load terrain: ${err instanceof Error ? err.message : String(err)}`;
  document.body.classList.add('failed');
});
