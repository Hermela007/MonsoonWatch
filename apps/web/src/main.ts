import './styles.css';
import * as THREE from 'three';
import { GeoFrame, KELANTAN, type LngLat, type Town } from './geo/region';
import { loadTerrariumGrid } from './terrain/terrarium';
import { cellLngLat, nearestCell } from './terrain/heightmap';
import { analyseHydrology, depthAt } from './terrain/hydrology';
import { findSlideSources, type SlideSource } from './terrain/landslide';
import { assessHome, neighbourhood } from './terrain/homeRisk';
import { routeToSafeGround } from './terrain/route';
import { createStage } from './scene/stage';
import { createCameraDirector, type Shot } from './scene/camera';
import { pickTerrain } from './scene/pick';
import { createValley, type Focus } from './layers/valley';
import { createFlood } from './layers/flood';
import { createRain } from './layers/rain';
import { createLandslides } from './layers/landslides';
import { createHomeLayer } from './layers/home';
import { createResidentUi } from './ui/resident';
import { t } from './ui/copy';
import { connectStream } from './api/stream';
import { NOW_HOUR, REPLAY_HOURS, rainAccumulated, rainIntensity, stageM } from './mock/replay2014';

const params = new URLSearchParams(location.search);
const isPhone = matchMedia('(max-width: 767px), (pointer: coarse)').matches;
const EXAG = Number(params.get('exag')) || 2;
const COLS = Number(params.get('res')) || (isPhone ? 300 : 480);
const FOCUS_KM = 6;
const WHATIF_HOURS = 40;

async function main() {
  const frame = new GeoFrame(KELANTAN.bbox, EXAG);
  const rows = Math.round((COLS * frame.heightKm) / frame.widthKm);

  let ui: ReturnType<typeof createResidentUi> | null = null;
  const loadingBar = (f: number) => {
    const el = document.getElementById('loading-bar');
    if (el) el.style.width = `${Math.round(f * 100)}%`;
  };

  const hm = await loadTerrariumGrid(KELANTAN.bbox, 10, COLS, rows, (d, n) => loadingBar(0.05 + 0.7 * (d / n)));
  loadingBar(0.8);
  await new Promise((r) => setTimeout(r, 20));
  const hy = analyseHydrology(hm, 150);
  loadingBar(0.95);
  await new Promise((r) => setTimeout(r, 20));

  const stage = createStage(document.getElementById('app')!, { bloom: !isPhone, maxPixelRatio: isPhone ? 1.25 : 1.5 });
  const { scene, camera, controls } = stage;
  const director = createCameraDirector(camera, controls);

  const valley = createValley(hm, hy, frame, stage.fogColor);
  const flood = createFlood(hm, hy, frame, stage.fogColor);
  const rain = createRain();
  const home = createHomeLayer();
  home.setLabels(t('yourHome'), t('higherGround'));
  scene.add(valley.mesh, flood.mesh, rain.object, home.group);
  let slides: ReturnType<typeof createLandslides> | null = null;

  // ---- State -------------------------------------------------------------
  let hour = NOW_HOUR;
  let targetHour = NOW_HOUR;
  let whatIf = false;
  let homePos: THREE.Vector3 | null = null;
  let viewShot: Shot | null = null;
  const focus: Focus = { centre: new THREE.Vector3(), radiusKm: FOCUS_KM, amount: 0 };
  let focusTarget = 0;

  const overview: Shot = { position: new THREE.Vector3(58, 72, 112), target: new THREE.Vector3(0, 0, -15) };

  const layoutShift = () => {
    const view = document.body.dataset.view;
    if (isPhone) stage.setShift(0, view === 'result' ? window.innerHeight * 0.22 : window.innerHeight * 0.18);
    else stage.setShift(view === 'result' ? 210 : 0, 0);
  };
  window.addEventListener('resize', layoutShift);

  const cellWorld = (cell: number, liftKm = 0) => {
    const r = Math.floor(cell / hm.cols);
    const p = frame.lngLatToWorld(cellLngLat(hm, cell - r * hm.cols, r), Math.max(hm.elevM[cell], 0));
    p.y += liftKm;
    return p;
  };

  const nearestTownName = (lngLat: LngLat) => {
    let best: Town | null = null;
    let bestKm = Infinity;
    for (const town of KELANTAN.towns) {
      const a = frame.lngLatToWorld(lngLat);
      const km = a.distanceTo(frame.lngLatToWorld(town.lngLat));
      if (km < bestKm) {
        bestKm = km;
        best = town;
      }
    }
    return best && bestKm < 8 ? t('near', { place: best.name }) : t('pickedPlace');
  };

  // ---- Choosing a home ---------------------------------------------------
  const selectHome = (lngLat: LngLat, place: string) => {
    const cell = nearestCell(hm, lngLat);
    if (cell === null || hy.seaMask[cell]) {
      ui!.note(t('outside'));
      return;
    }
    controls.autoRotate = false;
    const local: SlideSource[] = findSlideSources(hm, hy, { minSlopeDeg: 24, minElevM: 80, spacingKm: 1.2, max: 8, near: { cell, radiusKm: FOCUS_KM } });
    const risk = assessHome(hm, hy, cell, local);
    const avoid = new Uint8Array(hm.cols * hm.rows);
    for (const s of local) for (const c of s.path) for (const i of neighbourhood(hm, c, 1)) avoid[i] = 1;
    // If the home area is at risk, "higher ground" must be outside it.
    if (risk.level !== 'low') for (const i of neighbourhood(hm, cell, 2)) avoid[i] = 1;
    const route = routeToSafeGround(hm, hy, cell, avoid);

    homePos = cellWorld(cell);
    const routePts = route && route.cells.length > 1
      ? route.cells.filter((_, k) => k % 2 === 0 || k === route.cells.length - 1).map((c) => cellWorld(c, 0.05))
      : null;
    home.set(homePos, routePts, route?.distanceKm ?? 0, clock.elapsedTime);

    if (slides) {
      scene.remove(slides.group);
      slides.dispose();
    }
    slides = createLandslides(local, hm, frame, stage.fogColor);
    scene.add(slides.group);

    focus.centre.copy(homePos);
    focusTarget = 1;
    hour = targetHour = NOW_HOUR;
    whatIf = false;
    ui!.setWhatIf(false);
    ui!.showResult({ place, risk, nowHour: NOW_HOUR, route });
    layoutShift();

    // Frame the home and its safe ground together.
    const safe = routePts ? routePts[routePts.length - 1] : homePos;
    const target = homePos.clone().lerp(safe, 0.35);
    const span = Math.max(9, homePos.distanceTo(safe) * 2.2);
    viewShot = { target, position: target.clone().add(new THREE.Vector3(0.35, 0.62, 0.7).normalize().multiplyScalar(span)) };
    director.flyTo(viewShot, 2600);
  };

  const backToLanding = () => {
    home.set(null, null, 0, clock.elapsedTime);
    if (slides) {
      scene.remove(slides.group);
      slides.dispose();
      slides = null;
    }
    homePos = null;
    focusTarget = 0;
    hour = targetHour = NOW_HOUR;
    whatIf = false;
    ui!.showLanding();
    layoutShift();
    director.flyTo(overview, 2400, () => (controls.autoRotate = true));
  };

  ui = createResidentUi(KELANTAN.towns, {
    onPick: (town) => selectHome(town.lngLat, town.name),
    onLocate: () => {
      if (!navigator.geolocation) return ui!.note(t('noLocation'));
      ui!.note(t('locating'));
      navigator.geolocation.getCurrentPosition(
        (p) => {
          const lngLat: LngLat = [p.coords.longitude, p.coords.latitude];
          const [minLon, minLat, maxLon, maxLat] = KELANTAN.bbox;
          if (lngLat[0] < minLon || lngLat[0] > maxLon || lngLat[1] < minLat || lngLat[1] > maxLat) ui!.note(t('outside'));
          else selectHome(lngLat, t('myLocation'));
        },
        () => ui!.note(t('noLocation')),
        { timeout: 10000 },
      );
    },
    onShowWay: () => {
      const curve = home.curve;
      if (!curve) return;
      const shots: Shot[] = [0.15, 0.5, 0.85, 1].map((u) => {
        const p = curve.getPointAt(u);
        const ahead = curve.getPointAt(Math.min(1, u + 0.15));
        const back = p.clone().sub(ahead).setY(0).normalize();
        return { target: ahead, position: p.clone().addScaledVector(back, 1.6).add(new THREE.Vector3(0, 1.1, 0)) };
      });
      director.tour(shots, 7000, () => viewShot && director.flyTo(viewShot, 2000));
    },
    onWhatIf: () => {
      whatIf = !whatIf;
      targetHour = whatIf ? Math.min(REPLAY_HOURS, NOW_HOUR + WHATIF_HOURS) : NOW_HOUR;
      ui!.setWhatIf(whatIf);
    },
    onChange: backToLanding,
  });

  // Tap the map to choose a home.
  const down = new THREE.Vector2();
  stage.pointerTarget.addEventListener('pointerdown', (e) => {
    down.set(e.clientX, e.clientY);
    director.cancel();
  });
  stage.pointerTarget.addEventListener('pointerup', (e) => {
    if (down.distanceTo(new THREE.Vector2(e.clientX, e.clientY)) > 6) return;
    const rect = stage.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const hit = pickTerrain(ndc, camera, hm, frame);
    if (!hit) return;
    const lngLat = frame.worldToLngLat(hit);
    selectHome(lngLat, nearestTownName(lngLat));
  });

  ui.showLanding();
  layoutShift();
  ui.ready();
  connectStream();
  director.flyTo(overview, 4000, () => (controls.autoRotate = !homePos));

  // ---- Frame loop --------------------------------------------------------
  const clock = new THREE.Clock();
  stage.renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1);
    const time = clock.elapsedTime;
    director.update(performance.now());
    controls.update();

    // Replay time eases towards its target: forward slowly, back quickly.
    const rate = targetHour > hour ? 4 : 14;
    hour = targetHour > hour ? Math.min(targetHour, hour + dt * rate) : Math.max(targetHour, hour - dt * rate);
    focus.amount += (focusTarget - focus.amount) * Math.min(1, dt * 2.5);

    const camDist = camera.position.distanceTo(controls.target);
    const s = stageM(hour);
    valley.update(rainAccumulated(hour), time, focus);
    flood.update(s, time, focus);
    rain.update(controls.target, camDist, rainIntensity(hour), time);
    home.update(camDist, time);
    slides?.update(hour, camDist, time);
    ui!.setClock(hour, NOW_HOUR);
    stage.render();
  });

  // Dev handle for quick checks in the console.
  Object.assign(window, { __mw: { hm, hy, depthAt } });
}

main().catch((err) => {
  console.error(err);
  const el = document.getElementById('loading-msg');
  if (el) el.textContent = `Could not load the valley: ${err instanceof Error ? err.message : String(err)}`;
  document.body.classList.add('failed');
});
