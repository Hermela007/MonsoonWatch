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
import { createStack } from './layers/stack';
import { loadImagery } from './terrain/imagery';
import { createFlood } from './layers/flood';
import { createRain } from './layers/rain';
import { createLandslides } from './layers/landslides';
import { createHomeLayer } from './layers/home';
import { createResidentUi } from './ui/resident';
import { createStreet } from './layers/street';
import { fetchOsmHouses, illustrativeHouses, type House } from './data/buildings';
import { t } from './ui/copy';
import { connectStream } from './api/stream';
import { fetchEvacCentres, fetchVillages } from './api/client';
import type { EvacCentre } from '@monsoonwatch/shared';
import { NOW_HOUR, REPLAY_HOURS, rainAccumulated, rainIntensity, stageM } from './mock/replay2014';

const params = new URLSearchParams(location.search);
const isPhone = matchMedia('(max-width: 767px), (pointer: coarse)').matches;
const EXAG = Number(params.get('exag')) || 2;
const COLS = Number(params.get('res')) || (isPhone ? 300 : 480);
const FOCUS_KM = 6;
// Closer than this the 150 m terrain looks blocky; the street view covers close-ups.
const VALLEY_MIN_KM = 7;
const WHATIF_HOURS = 40;

async function main() {
  const frame = new GeoFrame(KELANTAN.bbox, EXAG);
  const rows = Math.round((COLS * frame.heightKm) / frame.widthKm);

  let ui: ReturnType<typeof createResidentUi> | null = null;
  const loadingBar = (f: number) => {
    const el = document.getElementById('loading-bar');
    if (el) el.style.width = `${Math.round(f * 100)}%`;
  };

  const imageryW = isPhone ? 768 : 1536;
  const imageryP = loadImagery(KELANTAN.bbox, isPhone ? 10 : 11, imageryW, Math.round((imageryW * frame.heightKm) / frame.widthKm));
  const hm = await loadTerrariumGrid(KELANTAN.bbox, 10, COLS, rows, (d, n) => loadingBar(0.05 + 0.7 * (d / n)));
  loadingBar(0.8);
  await new Promise((r) => setTimeout(r, 20));
  const hy = analyseHydrology(hm, 150);
  loadingBar(0.95);
  await new Promise((r) => setTimeout(r, 20));

  const imageryCanvas = await imageryP;
  const stage = createStage(document.getElementById('app')!, { bloom: false, maxPixelRatio: isPhone ? 1.5 : 2 });
  const { scene, camera, controls } = stage;
  const director = createCameraDirector(camera, controls);
  controls.minDistance = VALLEY_MIN_KM;

  let imagery: THREE.CanvasTexture | null = null;
  if (imageryCanvas) {
    // Satellite sea is navy; paint it a soft sea-green to keep the palette natural.
    const mask = document.createElement('canvas');
    mask.width = hm.cols;
    mask.height = hm.rows;
    const mctx = mask.getContext('2d')!;
    const md = mctx.createImageData(hm.cols, hm.rows);
    for (let i = 0; i < hm.cols * hm.rows; i++) if (hy.seaMask[i]) md.data.set([169, 198, 191, 255], i * 4);
    mctx.putImageData(md, 0, 0);
    const ictx = imageryCanvas.getContext('2d')!;
    ictx.imageSmoothingEnabled = true;
    ictx.filter = 'blur(3px)';
    ictx.drawImage(mask, 0, 0, imageryCanvas.width, imageryCanvas.height);
    ictx.filter = 'none';
    imagery = new THREE.CanvasTexture(imageryCanvas);
    imagery.colorSpace = THREE.SRGBColorSpace;
    imagery.anisotropy = stage.renderer.capabilities.getMaxAnisotropy();
  }
  const SLAB_DEPTH = 2.2;
  const valley = createValley(hm, hy, frame, stage.fogColor, imagery);
  // Valley-wide landslide hotspots: always shown, amber until enough rain has fallen.
  const hotspotSources = findSlideSources(hm, hy, { minSlopeDeg: 26, minElevM: 150, spacingKm: 7, max: 28 });
  const stack = createStack(hm, hy, frame, imagery, -SLAB_DEPTH, hotspotSources.map((h) => h.path));
  scene.add(stack.group);
  const hotspots = createLandslides(
    hotspotSources,
    hm,
    frame,
    stage.fogColor,
    { tubeRadiusKm: 0.22, labelled: 3, labelText: 'Landslide risk', labelSpacingKm: 35 },
  );
  scene.add(hotspots.group);
  let explode = 1;
  let explodeTarget = 1;
  const flood = createFlood(hm, hy, frame, stage.fogColor);
  const rain = createRain();
  const home = createHomeLayer();
  home.setLabels(t('yourHome'), t('higherGround'));
  scene.add(valley.mesh, flood.mesh, rain.object, home.group);
  let slides: ReturnType<typeof createLandslides> | null = null;

  const timer = new THREE.Timer();

  // ---- State -------------------------------------------------------------
  let hour = NOW_HOUR;
  let targetHour = NOW_HOUR;
  let whatIf = false;
  let homePos: THREE.Vector3 | null = null;
  let homeLngLat: LngLat | null = null;
  let homeCell = -1;
  let housesFor: Promise<House[]> | null = null;
  let street: ReturnType<typeof createStreet> | null = null;
  let streetRain: ReturnType<typeof createRain> | null = null;
  let inStreet = false;
  let valleyCam: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
  let viewShot: Shot | null = null;
  const focus: Focus = { centre: new THREE.Vector3(), radiusKm: FOCUS_KM, amount: 0 };
  let focusTarget = 0;

  // Landing: the exploded layer stack seen from a front corner, like a product shot.
  const overview: Shot = { position: new THREE.Vector3(150, 95, 165), target: new THREE.Vector3(0, -6, -8) };

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
    leaveStreet();
    disposeStreet();
    homeLngLat = lngLat;
    homeCell = cell;
    // Sharper imagery (~10 m/px) for the area around the home.
    valley.setDetail(null);
    const DETAIL_KM = 4;
    const dLon = DETAIL_KM / frame.kmPerDegLon;
    const dLat = DETAIL_KM / frame.kmPerDegLat;
    const dBox: [number, number, number, number] = [lngLat[0] - dLon, lngLat[1] - dLat, lngLat[0] + dLon, lngLat[1] + dLat];
    const forCell = cell;
    void loadImagery(dBox, isPhone ? 13 : 14, isPhone ? 512 : 1024, isPhone ? 512 : 1024).then((cv) => {
      if (!cv || homeCell !== forCell) return;
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = stage.renderer.capabilities.getMaxAnisotropy();
      const [minLon, minLat, maxLon, maxLat] = KELANTAN.bbox;
      valley.setDetail(
        tex,
        new THREE.Vector4(
          (dBox[0] - minLon) / (maxLon - minLon),
          (dBox[1] - minLat) / (maxLat - minLat),
          (dBox[2] - minLon) / (maxLon - minLon),
          (dBox[3] - minLat) / (maxLat - minLat),
        ),
      );
    });
    // Start fetching houses now so "See my street" opens fast.
    housesFor = fetchOsmHouses(lngLat).then((osm) => [...osm, ...illustrativeHouses(cell, osm)]);
    const local: SlideSource[] = findSlideSources(hm, hy, { minSlopeDeg: 24, minElevM: 80, spacingKm: 1.2, max: 8, near: { cell, radiusKm: FOCUS_KM } });
    const risk = assessHome(hm, hy, cell, local);
    const avoid = new Uint8Array(hm.cols * hm.rows);
    for (const s of local) for (const c of s.path) for (const i of neighbourhood(hm, c, 1)) avoid[i] = 1;
    // If the home area is at risk, "higher ground" must be outside it.
    if (risk.level !== 'low') for (const i of neighbourhood(hm, cell, 2)) avoid[i] = 1;
    const named = new Map<number, string>();
    for (const c of centres ?? []) {
      const ci = nearestCell(hm, c.location.coordinates);
      if (ci !== null) named.set(ci, c.name);
    }
    // Prefer a named evacuation centre; otherwise any safe higher ground.
    const route = (named.size ? routeToSafeGround(hm, hy, cell, avoid, 25, named) : null) ?? routeToSafeGround(hm, hy, cell, avoid);
    home.setLabels(t('yourHome'), route?.targetName ?? t('higherGround'));

    homePos = cellWorld(cell);
    const routePts = route && route.cells.length > 1
      ? route.cells.filter((_, k) => k % 2 === 0 || k === route.cells.length - 1).map((c) => cellWorld(c, 0.05))
      : null;
    home.set(homePos, routePts, route?.distanceKm ?? 0, timer.getElapsed());

    if (slides) {
      scene.remove(slides.group);
      slides.dispose();
    }
    slides = createLandslides(local, hm, frame, stage.fogColor);
    scene.add(slides.group);

    focus.centre.copy(homePos);
    focusTarget = 1;
    explodeTarget = 0;
    hour = targetHour = NOW_HOUR;
    whatIf = false;
    ui!.setWhatIf(false);
    ui!.showResult({ place, risk, nowHour: NOW_HOUR, route });
    layoutShift();

    // Frame the home and its safe ground together.
    const safe = routePts ? routePts[routePts.length - 1] : homePos;
    const target = homePos.clone().lerp(safe, 0.35);
    const span = Math.max(14, homePos.distanceTo(safe) * 3);
    viewShot = { target, position: target.clone().add(new THREE.Vector3(0.35, 0.62, 0.7).normalize().multiplyScalar(span)) };
    director.flyTo(viewShot, 2600);
  };

  const disposeStreet = () => {
    street?.dispose();
    streetRain?.dispose();
    street = null;
    streetRain = null;
  };

  const enterStreet = async () => {
    if (!homeLngLat || !housesFor || inStreet) return;
    ui!.setStreet('loading');
    const houses = await housesFor;
    if (!homeLngLat) return;
    if (!street) {
      street = createStreet({ renderer: stage.renderer, hm, hy, home: homeLngLat, homeCell, houses, homeLabel: t('yourHome') });
      streetRain = createRain();
      street.scene.add(streetRain.object);
    }
    director.cancel();
    valleyCam = { position: camera.position.clone(), target: controls.target.clone() };
    inStreet = true;
    camera.near = 0.5;
    camera.far = 6000;
    camera.updateProjectionMatrix();
    controls.minDistance = 12;
    controls.maxDistance = 700;
    const f = street.homeFocus;
    controls.target.copy(f);
    camera.position.copy(f).add(new THREE.Vector3(70, 34, 80));
    stage.setScene(street.scene);
    director.flyTo({ target: f.clone(), position: f.clone().add(new THREE.Vector3(38, 16, 44)) }, 2200);
    ui!.setStreet('on');
  };

  const leaveStreet = () => {
    if (!inStreet) return;
    inStreet = false;
    director.cancel();
    camera.near = 0.05;
    camera.far = 2000;
    camera.updateProjectionMatrix();
    controls.minDistance = VALLEY_MIN_KM;
    controls.maxDistance = 420;
    if (valleyCam) {
      camera.position.copy(valleyCam.position);
      controls.target.copy(valleyCam.target);
    }
    stage.setScene(scene);
    ui!.setStreet('off');
  };

  const backToLanding = () => {
    leaveStreet();
    disposeStreet();
    homeLngLat = null;
    homeCell = -1;
    housesFor = null;
    valley.setDetail(null);
    home.set(null, null, 0, timer.getElapsed());
    if (slides) {
      scene.remove(slides.group);
      slides.dispose();
      slides = null;
    }
    homePos = null;
    focusTarget = 0;
    explodeTarget = 1;
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
      leaveStreet();
      const curve = home.curve;
      if (!curve) return;
      const shots: Shot[] = [0.15, 0.5, 0.85, 1].map((u) => {
        const p = curve.getPointAt(u);
        const ahead = curve.getPointAt(Math.min(1, u + 0.15));
        const back = p.clone().sub(ahead).setY(0).normalize();
        return { target: ahead, position: p.clone().addScaledVector(back, 6).add(new THREE.Vector3(0, 4.5, 0)) };
      });
      director.tour(shots, 7000, () => viewShot && director.flyTo(viewShot, 2000));
    },
    onWhatIf: () => {
      whatIf = !whatIf;
      targetHour = whatIf ? Math.min(REPLAY_HOURS, NOW_HOUR + WHATIF_HOURS) : NOW_HOUR;
      ui!.setWhatIf(whatIf);
    },
    onChange: backToLanding,
    onStreet: () => (inStreet ? leaveStreet() : void enterStreet()),
  });

  // Tap the map to choose a home.
  const down = new THREE.Vector2();
  stage.pointerTarget.addEventListener('pointerdown', (e) => {
    down.set(e.clientX, e.clientY);
    director.cancel();
  });
  stage.pointerTarget.addEventListener('pointerup', (e) => {
    if (inStreet) return;
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

  // Workstream C's data, when the API is up. Until then: local stand-ins.
  let centres: EvacCentre[] | null = null;
  void fetchVillages(KELANTAN.id).then((v) => v && ui!.setPlaces(v));
  void fetchEvacCentres(KELANTAN.id).then((c) => (centres = c));
  director.flyTo(overview, 4000, () => (controls.autoRotate = !homePos));

  // ---- Frame loop --------------------------------------------------------
  stage.renderer.setAnimationLoop((now) => {
    timer.update(now);
    const dt = Math.min(timer.getDelta(), 0.1);
    const time = timer.getElapsed();
    director.update(performance.now());
    controls.update();

    // Replay time eases towards its target: forward slowly, back quickly.
    const rate = targetHour > hour ? 4 : 14;
    hour = targetHour > hour ? Math.min(targetHour, hour + dt * rate) : Math.max(targetHour, hour - dt * rate);
    focus.amount += (focusTarget - focus.amount) * Math.min(1, dt * 2.5);
    explode += (explodeTarget - explode) * Math.min(1, dt * 2.2);
    stack.setExplode(explode);

    const camDist = camera.position.distanceTo(controls.target);
    const s = stageM(hour);
    valley.update(rainAccumulated(hour), time, focus);
    flood.update(s, time, focus);
    rain.update(controls.target, camDist, rainIntensity(hour) * (1 - explode * 0.8), time);
    home.update(camDist, time);
    slides?.update(hour, camDist, time);
    hotspots.update(hour, camDist, time);
    hotspots.setLabelsVisible(explode < 0.3);
    if (inStreet && street) {
      const stats = street.update(Math.round(hour * 4) / 4);
      if (stats) ui!.setStreet('on', { ...stats, ...street.counts });
      streetRain?.update(controls.target, camDist, rainIntensity(hour), time);
    }
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
