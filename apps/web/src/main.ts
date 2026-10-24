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
import { fetchOsmHouses, illustrativeTown, type House, type Lane } from './data/buildings';
import { t } from './ui/copy';
import { createEventHub } from './api/stream';
import { decideAlert, runAgent, setApiLive } from './api/client';
import { createMockAgent } from './mock/agentScript';
import { createControlUi } from './ui/control';
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
// Illustrative trigger (rise above normal, m) until C's Stream Processing emits real risk events.
const AGENT_TRIGGER_STAGE_M = 4;

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
    // Neutral, low-contrast photo: colour is reserved for risk.
    // (copy first: drawing a canvas onto itself with a filter is unreliable)
    const copy = document.createElement('canvas');
    copy.width = imageryCanvas.width;
    copy.height = imageryCanvas.height;
    copy.getContext('2d')!.drawImage(imageryCanvas, 0, 0);
    ictx.filter = 'grayscale(1) contrast(0.45) brightness(1.9)';
    ictx.drawImage(copy, 0, 0);
    ictx.filter = 'none';
    imagery = new THREE.CanvasTexture(imageryCanvas);
    imagery.colorSpace = THREE.SRGBColorSpace;
    imagery.anisotropy = stage.renderer.capabilities.getMaxAnisotropy();
  }
  const SLAB_DEPTH = 2.2;
  const valley = createValley(hm, hy, frame, stage.fogColor);
  // Valley-wide landslide hotspots: always shown, amber until enough rain has fallen.
  const hotspotSources = findSlideSources(hm, hy, { minSlopeDeg: 26, minElevM: 150, spacingKm: 7, max: 28 });
  const stack = createStack(hm, hy, frame, imagery, -SLAB_DEPTH, hotspotSources.map((h) => h.path));
  scene.add(stack.group);
  const hotspots = createLandslides(
    hotspotSources,
    hm,
    frame,
    stage.fogColor,
    { tubeRadiusKm: 0.09, labelled: 3, labelText: 'Landslide risk', labelSpacingKm: 35 },
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
  let housesFor: Promise<{ houses: House[]; lanes: Lane[] }> | null = null;
  let localSlides: SlideSource[] = [];
  let street: ReturnType<typeof createStreet> | null = null;
  let streetRain: ReturnType<typeof createRain> | null = null;
  let inStreet = false;
  let valleyCam: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
  let streetShot: Shot | null = null;
  let lastBuried = 0;
  let lastWet = 0;
  let lastTotal = 0;
  let viewShot: Shot | null = null;
  const focus: Focus = { centre: new THREE.Vector3(), radiusKm: FOCUS_KM, amount: 0 };
  let focusTarget = 0;

  // Landing: the exploded layer stack seen from a front corner, like a product shot.
  const overview: Shot = { position: new THREE.Vector3(150, 95, 165), target: new THREE.Vector3(0, -6, -8) };

  const layoutShift = () => {
    const view = document.body.dataset.view;
    if (isPhone) stage.setShift(0, view === 'result' ? window.innerHeight * 0.22 : window.innerHeight * 0.18);
    else stage.setShift(view === 'control' ? -40 : 210, 0);
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
    // Start fetching houses now so "See my street" opens fast.
    housesFor = fetchOsmHouses(lngLat, 450, 5000).then((osm) => {
      const k = illustrativeTown(cell, osm);
      return { houses: [...osm, ...k.houses], lanes: k.lanes };
    });
    const local: SlideSource[] = findSlideSources(hm, hy, { minSlopeDeg: 24, minElevM: 80, spacingKm: 1.2, max: 8, near: { cell, radiusKm: FOCUS_KM } });
    // Valley hotspots whose runout passes near the home count too.
    for (const h of hotspotSources) {
      if (local.includes(h)) continue;
      if (h.path.some((c) => cellWorld(c).distanceTo(cellWorld(cell)) < FOCUS_KM)) local.push(h);
    }
    localSlides = local;
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
    // Valley-wide flagged slopes within 30 km and higher than the home: debris can reach its river.
    const upstreamSlopes = hotspotSources.filter((h) => hm.elevM[h.cell] > hm.elevM[cell] + 50 && cellWorld(h.cell).distanceTo(cellWorld(cell)) < 30).length;
    ui!.showResult({ place, risk, nowHour: NOW_HOUR, route, upstreamSlopes });
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
    const { houses, lanes } = await housesFor;
    if (!homeLngLat) return;
    if (!street) {
      street = createStreet({
        renderer: stage.renderer,
        hm,
        hy,
        home: homeLngLat,
        homeCell,
        houses,
        lanes,
        slides: localSlides,
        homeLabel: t('yourHome'),
        slideLabels: { warn: t('slopeWarn'), active: t('slopeActive') },
      });
      streetRain = createRain();
      street.scene.add(streetRain.object);
      // Compile its shaders now, so the switch doesn't stall mid camera move.
      stage.renderer.compile(street.scene, camera);
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
    // Frame the home; if a landslide threatens it, put the hillside behind the home in view.
    let target = f.clone();
    // From across the road, slightly to one side, at roughly first-floor height.
    const side = new THREE.Vector3(street.homeFront.z, 0, -street.homeFront.x);
    let pos = f.clone().addScaledVector(street.homeFront, 34).addScaledVector(side, 16).add(new THREE.Vector3(0, 7, 0));
    if (street.slideMid) {
      // Stand behind the home, looking up the hillside: houses in front, the slope above them.
      const toSlide = street.slideMid.clone().sub(f).setY(0).normalize();
      target = f.clone().lerp(street.slideMid, 0.55);
      pos = f.clone().addScaledVector(toSlide, -70).add(new THREE.Vector3(toSlide.z * 18, 24, -toSlide.x * 18));
    }
    streetShot = { target: target.clone(), position: pos.clone() };
    controls.target.copy(target);
    camera.position.copy(pos).add(new THREE.Vector3(0, 60, 0));
    stage.setScene(street.scene);
    director.flyTo({ target, position: pos }, 2400);
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
  let downAt = 0;
  stage.pointerTarget.addEventListener('pointerdown', (e) => {
    down.set(e.clientX, e.clientY);
    downAt = performance.now();
    director.cancel();
  });
  stage.pointerTarget.addEventListener('pointerup', (e) => {
    // Only a quick, deliberate tap on the map picks a place (not drags, not the control room).
    if (inStreet || document.body.dataset.mode === 'control' || e.target !== stage.pointerTarget || performance.now() - downAt > 450) return;
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

  // Places where both hazards meet: the valley floor at the foot of a flagged slope's runout,
  // for the steepest flagged slope near each of these towns.
  const hillPlaces = ['Gua Musang', 'Dabong', 'Kuala Krai'].flatMap((name) => {
    const tw = frame.lngLatToWorld(KELANTAN.towns.find((t) => t.name === name)!.lngLat);
    const near = hotspotSources
      .map((h) => ({ h, d: cellWorld(h.cell).setY(0).distanceTo(tw.setY(0)) }))
      .filter((x) => x.d < 25)
      .sort((a, b) => b.h.slopeDeg - a.h.slopeDeg)[0];
    if (!near) return [];
    const path = near.h.path;
    let foot = path[path.length - 1];
    for (let k = path.length - 1; k >= 0 && hy.riverMask[path[k]]; k--) foot = path[Math.max(0, k - 1)];
    const r = Math.floor(foot / hm.cols);
    return [{ name: `Below the hills near ${name}`, lngLat: cellLngLat(hm, foot - r * hm.cols, r) }];
  });
  // Lead with one flood place and one landslide place; everything else is searchable.
  const byName = (n: string) => KELANTAN.towns.find((t) => t.name === n)!;
  const ordered = [byName('Kuala Krai'), ...hillPlaces.slice(0, 1), byName('Dabong'), byName('Tanah Merah'), byName('Kota Bharu')];
  const allPlaces = [...ordered, ...KELANTAN.towns.filter((t) => !ordered.includes(t)), ...hillPlaces.slice(1)];
  ui.setPlaces(allPlaces);

  // Workstream C's data, when the API is up. Until then: local stand-ins.
  let centres: EvacCentre[] | null = null;
  const loadApiData = () => {
    void fetchVillages(KELANTAN.id).then((v) => v && ui!.setPlaces([...allPlaces, ...v]));
    void fetchEvacCentres(KELANTAN.id).then((c) => (centres = c));
  };

  // ---- Control room: live events (or the scripted mock), Tech HUD, human approval ----------
  const control = createControlUi({
    onReplay: () => {
      hour = 0;
      targetHour = REPLAY_HOURS;
      agentTriggered = false;
    },
    onRun: () => startAgent(),
    onDecide: (d) => void decide(d),
  });
  const hub = createEventHub({
    forceMock: params.has('mock'),
    onMode: (m) => {
      control.setMode(m);
      setApiLive(m === 'live');
      if (m === 'live') loadApiData();
    },
  });
  const mockAgent = createMockAgent(hub.emit);
  let agentTriggered = false;
  let alertShown = false;
  let usingMock = false;
  const AGENT_VILLAGE = 'Kuala Krai';
  let agentVillageCell = -1;

  hub.on('agent.step', ({ step }) => control.step(step));
  hub.on('risk.event', ({ riskEvent }) => control.risk(riskEvent));
  hub.on('saint.task', ({ task }) => control.task(task));
  hub.on('alert.updated', ({ alert }) => {
    control.alert(alert);
    if (document.body.dataset.mode !== 'control') return;
    // Draw the alert's route and fly to the village the first time we see it.
    const pts = alert.route.coordinates.map((ll) => frame.lngLatToWorld(ll, sampleElev(ll)).add(new THREE.Vector3(0, 0.05, 0)));
    if (pts.length >= 1 && !alertShown) {
      alertShown = true;
      home.setLabels(alert.villageId, t('higherGround'));
      home.set(pts[0], pts.length > 1 ? pts : null, 0, timer.getElapsed());
      focus.centre.copy(pts[0]);
      focusTarget = 1;
      const span = Math.max(14, pts[0].distanceTo(pts[pts.length - 1]) * 3);
      director.flyTo({ target: pts[0].clone(), position: pts[0].clone().add(new THREE.Vector3(0.35, 0.62, 0.7).normalize().multiplyScalar(span)) }, 2600);
    }
  });

  const sampleElev = (ll: LngLat) => {
    const c = nearestCell(hm, ll);
    return c === null ? 0 : Math.max(hm.elevM[c], 0);
  };

  const startAgent = async () => {
    agentTriggered = true;
    alertShown = false;
    control.reset();
    home.set(null, null, 0, timer.getElapsed());
    const ll = KELANTAN.towns.find((x) => x.name === AGENT_VILLAGE)!.lngLat;
    agentVillageCell = nearestCell(hm, ll)!;
    if (hub.mode === 'live' && !usingMock) {
      try {
        const r = await runAgent(KELANTAN.id);
        control.note(`Agent run ${r.runId} started`);
        return;
      } catch (err) {
        control.note(`API: ${err instanceof Error ? err.message : String(err)} — showing the scripted demo run instead`);
        usingMock = true;
      }
    }
    // Scripted run: route and ETA come from the terrain model so the 3D matches the card.
    const risk = assessHome(hm, hy, agentVillageCell, []);
    // Same rule as the resident view: the destination must be outside the village's own area.
    const avoid = new Uint8Array(hm.cols * hm.rows);
    for (const i of neighbourhood(hm, agentVillageCell, 2)) avoid[i] = 1;
    const route = routeToSafeGround(hm, hy, agentVillageCell, avoid);
    const routeLL = (route?.cells ?? [agentVillageCell]).filter((_, k, a) => k % 2 === 0 || k === a.length - 1).map((c) => {
      const r = Math.floor(c / hm.cols);
      return cellLngLat(hm, c - r * hm.cols, r);
    });
    mockAgent.start({
      regionId: KELANTAN.id,
      village: { id: AGENT_VILLAGE, name: AGENT_VILLAGE },
      route: routeLL,
      etaHours: Math.max(1, (risk.floodWetHour ?? hour + 6) - hour),
    });
  };

  const decide = async (d: 'approve' | 'reject') => {
    if (hub.mode === 'live' && !usingMock) {
      const id = document.getElementById('alert-box')?.dataset.alertId;
      if (id) {
        try {
          control.alert(await decideAlert(id, d, 'Duty officer'));
          return;
        } catch (err) {
          control.note(`API: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    mockAgent.decide(d, 'Duty officer');
  };

  // ---- Modes ---------------------------------------------------------------------------
  const setMode = (m: 'resident' | 'control') => {
    document.body.dataset.mode = m;
    document.getElementById('mode-resident')!.classList.toggle('on', m === 'resident');
    document.getElementById('mode-control')!.classList.toggle('on', m === 'control');
    if (m === 'control') {
      leaveStreet();
      ui!.showLanding();
      document.body.dataset.view = 'control';
      controls.autoRotate = false;
      explodeTarget = 0;
      focusTarget = 0;
      home.set(null, null, 0, timer.getElapsed());
      homePos = null;
      layoutShift();
      director.flyTo({ position: new THREE.Vector3(-30, 95, 120), target: new THREE.Vector3(-6, 0, -20) }, 2200);
    } else {
      mockAgent.stop();
      backToLanding();
    }
  };
  document.getElementById('mode-resident')!.addEventListener('click', () => setMode('resident'));
  document.getElementById('mode-control')!.addEventListener('click', () => setMode('control'));

  // ---- Recording presets (?demo=1, keys 1–6) -------------------------------------------
  const pick = (name: string) => {
    const p = allPlaces.find((x) => x.name === name || x.name.includes(name));
    if (p) selectHome(p.lngLat, p.name);
  };
  window.addEventListener('keydown', (e) => {
    if (!params.has('demo') || e.target instanceof HTMLInputElement) return;
    const k = e.key;
    if (k === '1') setMode('resident');
    if (k === '2') (setMode('resident'), pick('Kuala Krai'));
    if (k === '3') (setMode('resident'), pick('Kuala Krai'), window.setTimeout(() => void enterStreet().then(() => document.getElementById('btn-whatif')!.click()), 2800));
    if (k === '4') (setMode('resident'), pick('hills near Gua Musang'), window.setTimeout(() => void enterStreet().then(() => document.getElementById('btn-whatif')!.click()), 2800));
    if (k === '5') (setMode('control'), window.setTimeout(() => void startAgent(), 2400));
    if (k === '6') void decide('approve');
  });
  director.flyTo(overview, 4000, () => (controls.autoRotate = !homePos));

  // ---- Frame loop --------------------------------------------------------
  stage.renderer.setAnimationLoop((now) => {
    timer.update(now);
    const dt = Math.min(timer.getDelta(), 0.1);
    const time = timer.getElapsed();
    director.update(performance.now());
    controls.update();

    // Replay time eases towards its target: forward slowly, back quickly.
    // Slow the replay right down while a landslide surges, so it can be seen.
    const rate = targetHour > hour ? (inStreet && street?.slideSurging ? 0.15 : 4) : 14;
    hour = targetHour > hour ? Math.min(targetHour, hour + dt * rate) : Math.max(targetHour, hour - dt * rate);
    focus.amount += (focusTarget - focus.amount) * Math.min(1, dt * 2.5);
    // Control room replay: when the main river passes the Warning rise, Stream Processing → agent.
    if (document.body.dataset.mode === 'control' && !agentTriggered && hour > 0.5 && stageM(hour) >= AGENT_TRIGGER_STAGE_M) void startAgent();
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
      street.animate(hour, time);
      const stats = street.update(Math.round(hour * 20) / 20) ?? (street.buried !== lastBuried ? { wet: lastWet, total: lastTotal, buried: street.buried } : null);
      if (stats) {
        lastBuried = stats.buried ?? 0;
        lastWet = stats.wet;
        lastTotal = stats.total;
      }
      // Keep the camera in the neighbourhood and out of hillsides.
      if (!director.busy && streetShot && camera.position.distanceTo(street.homeFocus) > 650) {
        camera.position.copy(streetShot.position);
        controls.target.copy(streetShot.target);
      }
      const gY = street.groundAt(camera.position.x, camera.position.z) + 3;
      if (camera.position.y < gY) camera.position.y = gY;
      // Never let the camera sink under the water surface.
      const minY = street.level + 4;
      if (camera.position.y < minY) {
        const lift = minY - camera.position.y;
        camera.position.y += lift;
        controls.target.y = Math.max(controls.target.y, street.level + 1);
      }
      if (stats) ui!.setStreet('on', { ...stats, buried: street.buried, ...street.counts });
      streetRain?.update(controls.target, camDist, Math.min(1, rainIntensity(hour) * 1.8 + 0.25), time);
    }
    ui!.setClock(hour, NOW_HOUR);
    stage.render();
  });

  // Dev handle for quick checks in the console.
  Object.assign(window, { __mw: { hm, hy, depthAt, camera, controls, getStreet: () => street } });
}

main().catch((err) => {
  console.error(err);
  const el = document.getElementById('loading-msg');
  if (el) el.textContent = `Could not load the valley: ${err instanceof Error ? err.message : String(err)}`;
  document.body.classList.add('failed');
});
