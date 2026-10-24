import './styles.css';
import * as THREE from 'three';
import { findSlideShots, visibleBounds, type SlideShot } from './scene/slideShot';
import { GeoFrame, KELANTAN, type LngLat, type Town } from './geo/region';
import { loadBakedTerrain } from './terrain/baked';
import { createApiHazards } from './layers/apiHazards';
import { createScenarioLoader } from './api/hazards';
import { createKnowledgeSearch } from './ui/knowledge';
import { cellLngLat, gridCoords, nearestCell, sampleField } from './terrain/heightmap';
import { analyseHydrology, depthAt } from './terrain/hydrology';
import { findSlideSources, type SlideSource } from './terrain/landslide';
import { assessHome, neighbourhood } from './terrain/homeRisk';
import { routeToSafeGround } from './terrain/route';
import { createStage } from './scene/stage';
import { createCameraDirector, type Shot } from './scene/camera';
import { pickTerrain } from './scene/pick';
import { boundaryMask, createValley, type Focus } from './layers/valley';
import { createFlood } from './layers/flood';
import { createRain } from './layers/rain';
import { createLandslides } from './layers/landslides';
import { createHomeLayer } from './layers/home';
import { createResidentUi } from './ui/resident';
import { createStreet } from './layers/street';
import { loadAreaFor, type AreaData } from './data/areas';
import { t } from './ui/copy';
import { matchPlaces } from './ui/places';
import { createEventHub } from './api/stream';
import { decideAlert, fetchAgentRun, fetchSaintTasks, fetchReplayStatus, fetchStations, runAgent, setApiLive, startReplay, stopReplay, type ReplayStatus } from './api/client';
import { createMockAgent } from './mock/agentScript';
import { createControlUi } from './ui/control';
import { fetchEvacCentres, fetchVillages } from './api/client';
import type { Alert, EvacCentre } from '@monsoonwatch/shared';
import { NOW_HOUR, PEAK_STAGE_M, REPLAY_HOURS, REPLAY_START_MS, peakHour, rainAccumulated, rainIntensity, replayDate, setRealSeries, stageM } from './data/replay2014';
import { fetchEvacuationRoute, parseEvacuationRoute, type RouteResult } from './api/evacuationRoute';
import { journeyView, type JourneyView } from './ui/journey';
import { relocateRoute } from './ui/relocateRoute';
import { createRouteMarkers } from './layers/routeMarkers';
import { searchAddresses } from './maps/addressSearch';
import type { Padding, RouteMap2d } from './maps/routeMap2d';
import type { EvacuationRoute, TravelMode } from '@monsoonwatch/shared';
import { loadMalaysia, loadRealData } from './data/realData';
import { createGeoContext } from './layers/geoContext';
import { createStations } from './layers/stations';
import { FOG } from './theme';

const params = new URLSearchParams(location.search);
const isPhone = matchMedia('(max-width: 767px), (pointer: coarse)').matches;
const EXAG = Number(params.get('exag')) || 3;
// Same analysis grid on every device: a safety answer must not depend on screen size.
const COLS = Math.max(160, Math.min(900, Math.round(Number(params.get('res')) || 600)));
const FOCUS_KM = 6;
// Closer than this the 150 m terrain looks blocky; the street view covers close-ups.
const VALLEY_MIN_KM = 7;
// The route screen may come closer: from overhead the terrain stays smooth, and the roads carry the view.
const ROUTE_MIN_KM = 1.2;
// Illustrative trigger (rise above normal, m) until C's Stream Processing emits real risk events.
const AGENT_TRIGGER_STAGE_M = PEAK_STAGE_M * 0.45;

async function main() {
  const frame = new GeoFrame(KELANTAN.bbox, EXAG);
  const rows = Math.round((COLS * frame.heightKm) / frame.widthKm);

  let ui: ReturnType<typeof createResidentUi> | null = null;
  const loadingBar = (f: number) => {
    const el = document.getElementById('loading-bar');
    if (el) el.style.width = `${Math.round(f * 100)}%`;
  };

  // Real data (Workstream C's committed files): places, Dec 2014 rain and river discharge.
  const realP = loadRealData();
  const malaysiaP = loadMalaysia().catch(() => null);
  const hm = await loadBakedTerrain(KELANTAN.bbox, COLS, rows);
  loadingBar(0.8);
  await new Promise((r) => setTimeout(r, 20));
  const real = await realP;
  setRealSeries(real);
  const realTowns: Town[] = real.villages.map((v) => ({ name: v.name, lngLat: v.lngLat }));
  const realByName = (n: string) => realTowns.find((t) => t.name === n);
  const hy = analyseHydrology(hm, 150);
  loadingBar(0.95);
  await new Promise((r) => setTimeout(r, 20));

  const stage = createStage(document.getElementById('app')!, { bloom: false, maxPixelRatio: isPhone ? 1.5 : 2 });
  const { scene, camera, controls } = stage;
  const director = createCameraDirector(camera, controls);
  controls.minDistance = VALLEY_MIN_KM;

  // The model is Kelantan itself: terrain and water are cut to the real state boundary.
  const malaysia = await malaysiaP;
  const kelRing = (malaysia?.states.find((s) => s.name === 'Kelantan')?.polygons ?? [])
    .sort((a, b) => b.length - a.length)[0] ?? [
    [KELANTAN.bbox[0], KELANTAN.bbox[1]], [KELANTAN.bbox[2], KELANTAN.bbox[1]], [KELANTAN.bbox[2], KELANTAN.bbox[3]], [KELANTAN.bbox[0], KELANTAN.bbox[3]],
  ] as LngLat[];
  const boundary = boundaryMask(hm, kelRing);
  const SLAB_DEPTH = 2.2;
  const valley = createValley(hm, hy, frame, stage.fogColor, boundary.texture, kelRing);
  // State-wide landslide hotspots (inside Kelantan only).
  const hotspotSources = findSlideSources(hm, hy, { minSlopeDeg: 26, minElevM: 150, spacingKm: 9, max: 30 }).filter((h) => {
    const r = Math.floor(h.cell / hm.cols);
    return boundary.inside(cellLngLat(hm, h.cell - r * hm.cols, r));
  });
  const hotspots = createLandslides(hotspotSources, hm, frame, stage.fogColor, { mask: boundary.texture, tubeRadiusKm: 0.09, labelled: 1, labelText: 'Landslide risk', labelSpacingKm: 60 });
  scene.add(hotspots.group);
  const apiHazards = createApiHazards(hm, frame, real.rivers, boundary.inside);
  scene.add(apiHazards.group);

  // Atlas: real named rivers and towns inside Kelantan; neighbours named just beyond the border.
  const MAJOR = ['Kota Bharu', 'Pasir Mas', 'Tanah Merah', 'Kuala Krai', 'Dabong', 'Gua Musang', 'Jeli', 'Machang'];
  const geoCtx = createGeoContext({
    hm,
    frame,
    inside: boundary.inside,
    rivers: real.rivers,
    towns: real.villages.filter((v) => MAJOR.includes(v.name) && (v.kind === 'city' || v.kind === 'town' || v.name === 'Dabong')).map((v) => ({ name: v.name, lngLat: v.lngLat, major: true })),
  });
  scene.add(geoCtx.group);
  let stations: ReturnType<typeof createStations> | null = null;
  {
    const peakDate = new Date(`${real.peak.date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
    document.getElementById('caption-fact')!.textContent = `Replaying December 2014: the Kelantan river peaked at ${real.peak.m3s.toLocaleString('en-GB')} m³/s on ${peakDate} (GloFAS), and heavy rain set off landslides in the hills.`;
  }
  let explode = 0;
  const explodeTarget = 0;
  const flood = createFlood(hm, hy, frame, stage.fogColor, boundary.texture);
  const rain = createRain();
  const home = createHomeLayer();
  home.setLabels(t('yourHome'), t('higherGround'));
  const routeMarkers = createRouteMarkers();
  scene.add(valley.mesh, flood.mesh, rain.object, home.group, routeMarkers.group);
  let slides: ReturnType<typeof createLandslides> | null = null;

  const timer = new THREE.Timer();

  /** Flagged slopes around a home: close detailed search + wider one + state-wide hotspots nearby. One
   *  function so the place list, the card and the street always agree. */
  const slopesNear = (cell: number): SlideSource[] => {
    const close = findSlideSources(hm, hy, { minSlopeDeg: 24, minElevM: 80, spacingKm: 0.8, max: 6, near: { cell, radiusKm: 2.5 } });
    const wide = findSlideSources(hm, hy, { minSlopeDeg: 24, minElevM: 80, spacingKm: 1.2, max: 8, near: { cell, radiusKm: FOCUS_KM } });
    const out = [...close];
    for (const s of [...wide, ...hotspotSources]) {
      if (out.some((o) => o.cell === s.cell)) continue;
      if (s.path.some((c) => cellWorld(c).distanceTo(cellWorld(cell)) < FOCUS_KM)) out.push(s);
    }
    return out;
  };

  // ---- State -------------------------------------------------------------
  let hour = NOW_HOUR;
  let targetHour = NOW_HOUR;
  let whatIf = false;
  let homePos: THREE.Vector3 | null = null;
  let homeLngLat: LngLat | null = null;
  let homePlace = '';
  let homeCell = -1;
  let housesFor: Promise<AreaData | null> | null = null;
  let localSlides: SlideSource[] = [];
  let street: ReturnType<typeof createStreet> | null = null;
  let streetRain: ReturnType<typeof createRain> | null = null;
  let inStreet = false;
  let valleyCam: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
  let streetShot: Shot | null = null;
  let shakeUntil = 0;
  let followSlide = true;
  let slideShots: { wide: SlideShot; close: SlideShot } | null = null; // landslide street framing (per street)
  let settledAt = -1;
  const shakeOff = new THREE.Vector3();
  let frameCount = 0, frameSeconds = 0;
  let wasLanding = true;
  let lastBuried = 0;
  let lastWet = 0;
  let lastTotal = 0;
  let viewShot: Shot | null = null;
  const focus: Focus = { centre: new THREE.Vector3(), radiusKm: FOCUS_KM, amount: 0 };
  /** Keep the address shareable: ?place= (or ?at=lon,lat) for a home, #control for the officials' view. */
  const syncUrl = (home: { place: string; lngLat: LngLat; named: boolean } | null) => {
    const u = new URL(location.href);
    u.searchParams.delete('place');
    u.searchParams.delete('at');
    u.searchParams.delete('view');
    if (home && home.named) u.searchParams.set('place', home.place);
    else if (home) u.searchParams.set('at', `${home.lngLat[0].toFixed(5)},${home.lngLat[1].toFixed(5)}`);
    u.hash = document.body.dataset.mode === 'control' ? 'control' : '';
    history.replaceState(null, '', u);
  };
  let focusTarget = 0;

  // Landing: low oblique view up the valley from the south-east — hills, floodplain and slopes in one frame.
  // North-up, tilted like a map, framing the whole state so its real outline reads at once.
  const ovTarget = frame.lngLatToWorld([101.98, 5.42]);
  // On phones the card covers the lower half, so step back to keep the whole outline in view.
  const overview: Shot = { position: ovTarget.clone().add(isPhone ? new THREE.Vector3(0, 380, 210) : new THREE.Vector3(0, 245, 150)), target: ovTarget };

  const layoutShift = () => {
    const view = document.body.dataset.view;
    if (isPhone) stage.setShift(0, view === 'result' || view === 'route' ? window.innerHeight * 0.22 : window.innerHeight * 0.12);
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
    for (const town of realTowns) {
      const a = frame.lngLatToWorld(lngLat);
      const km = a.distanceTo(frame.lngLatToWorld(town.lngLat));
      if (km < bestKm) {
        bestKm = km;
        best = town;
      }
    }
    return best && bestKm < 3 ? t('near', { place: best.name }) : t('pickedPlace');
  };

  // ---- Choosing a home ---------------------------------------------------
  // ---- Evacuation journey (GET /regions/:id/evacuation-route; B's routing on C's road + hazard data) ----
  // The card shows a one-line summary; "Show me the way" opens the route screen (map fitted to the
  // journey, bold road route, numbered turns). Until the endpoint is live the card keeps the terrain
  // estimate. ?routeFixture=ok|all-routes-flooded|boat-unsupported shows the shared sample responses,
  // moved so they start at the chosen home (they are TEST DATA).
  let journeyTravel: TravelMode = 'car';
  let journeySeq = 0;
  let journey: { route: EvacuationRoute; view: JourneyView; pts: THREE.Vector3[]; turnPts: THREE.Vector3[] } | null = null;
  let routeOpen = false;
  const routeFixture = params.get('routeFixture');
  const fixtureRoutes = import.meta.glob('../../../packages/shared/fixtures/evacuation-route.*.json', { eager: true, import: 'default' });
  const routeHandlers = {
    onTravel: (travel: TravelMode) => {
      journeyTravel = travel;
      void requestJourney();
    },
    onCentre: (id: string) => void requestJourney(id),
    onStep: (i: number) => selectTurn(i),
  };
  const requestJourney = async (centreId: string | null = null): Promise<void> => {
    if (!homeLngLat || !homePos) return;
    const seq = ++journeySeq;
    const from = homeLngLat;
    let res: RouteResult;
    if (routeFixture) {
      const key = Object.keys(fixtureRoutes).find((k) => k.endsWith(`evacuation-route.${routeFixture}.json`));
      res = key ? parseEvacuationRoute(fixtureRoutes[key]) : { kind: 'unavailable' };
      if (res.kind === 'route') res = { kind: 'route', route: relocateRoute(res.route, from) };
    } else {
      res = await fetchEvacuationRoute(KELANTAN.id, { lngLat: from, travel: journeyTravel, mode: 'replay', ts: replayDate(NOW_HOUR).toISOString(), centreId });
    }
    if (seq !== journeySeq || homeLngLat !== from || !homePos) return; // the resident moved on
    if (res.kind === 'invalid') console.warn('evacuation-route: response does not match the shared contract —', res.error);
    if (res.kind !== 'route') {
      journey = null;
      return ui!.setJourney(null);
    }
    const route = res.route;
    const view = journeyView(route);
    const lift = (ll: LngLat) => frame.lngLatToWorld(ll, elevAt(ll)).add(new THREE.Vector3(0, 0.03, 0));
    const pts = route.status === 'ok' && route.geometry ? drape(route.geometry.coordinates) : [];
    const turnPts = route.status === 'ok' && route.geometry ? route.steps.map((st) => lift(route.geometry!.coordinates[Math.min(st.startIndex, route.geometry!.coordinates.length - 1)])) : [];
    journey = { route, view, pts, turnPts };
    ui!.setJourney(view);
    // The road route replaces the terrain estimate on the map; with no route, no line is drawn.
    if (pts.length > 1 && route.centre) {
      home.setLabels(t('yourHome'), route.centre.name);
      home.set(homePos, pts, (route.distanceM ?? 0) / 1000, timer.getElapsed());
    } else {
      home.setLabels(t('yourHome'), t('higherGround'));
      home.set(homePos, null, 0, timer.getElapsed());
    }
    if (routeOpen) openRoute();
  };

  /** Smooth (bilinear) ground height, so a draped line doesn't step between terrain cells. */
  const elevAt = (ll: LngLat) => {
    const { gx, gy } = gridCoords(hm, ll);
    const e = sampleField(hm, hm.elevM, gx, gy);
    return Number.isFinite(e) ? Math.max(e, 0) : 0;
  };
  /** A route polyline sampled every ~40 m along the terrain, so the line follows the ground. */
  const drape = (coords: LngLat[]) => {
    const out: THREE.Vector3[] = [];
    for (let i = 0; i < coords.length - 1; i++) {
      const [a, b] = [coords[i], coords[i + 1]];
      const km = frame.lngLatToWorld(a).distanceTo(frame.lngLatToWorld(b));
      const n = Math.max(1, Math.ceil(km / 0.04));
      for (let k = 0; k < n; k++) {
        const ll: LngLat = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
        out.push(frame.lngLatToWorld(ll, elevAt(ll)).add(new THREE.Vector3(0, 0.03, 0)));
      }
    }
    const last = coords[coords.length - 1];
    if (last) out.push(frame.lngLatToWorld(last, elevAt(last)).add(new THREE.Vector3(0, 0.03, 0)));
    return out;
  };
  const syncLineResolution = () => home.setResolution(stage.renderer.domElement.clientWidth, stage.renderer.domElement.clientHeight);
  window.addEventListener('resize', syncLineResolution);

  /** Route screen: the panel, a bold route with numbered turns, the camera fitted to the whole journey. */
  // The route screen is a flat 2D street map (OpenStreetMap, Citymapper-style). If the tiles can't load
  // (offline) it falls back to the 3D route view. ?map=3d forces the 3D view.
  const map2dEnabled = () => params.get('map') !== '3d';
  let map2d: Promise<RouteMap2d | null> | null = null;
  let using2d = false;
  const routePadding = (): Padding => {
    const card = document.getElementById('route-view')!.getBoundingClientRect();
    return isPhone || card.right > window.innerWidth * 0.6
      ? { top: 80, left: 32, right: 32, bottom: Math.round(window.innerHeight - card.top + 24) }
      : { top: 90, left: Math.round(card.right + 48), right: 64, bottom: 64 };
  };
  const openRoute2d = async (): Promise<boolean> => {
    if (!map2dEnabled() || !journey || !homeLngLat) return false;
    map2d ??= import('./maps/routeMap2d').then(({ createRouteMap2d }) => createRouteMap2d(document.getElementById('route-map')!)).catch(() => null);
    const m = await map2d;
    if (!m || !journey || !homeLngLat || !routeOpen) return !!m;
    using2d = true;
    document.body.classList.add('route-2d');
    m.show(journey.route, homeLngLat, routePadding(), selectTurn);
    return true;
  };

  const openRoute = () => {
    if (!journey || !homePos) return;
    routeOpen = true;
    ui!.showRoute(journey.view, routeHandlers);
    if (map2dEnabled()) {
      // Try the 2D map; if it can't load (offline), fall back to the 3D route view.
      void openRoute2d().then((ok) => !ok && routeOpen && openRoute3d());
      return;
    }
    openRoute3d();
  };
  const openRoute3d = () => {
    if (!journey || !homePos) return;
    syncLineResolution();
    home.setBold(true, timer.getElapsed());
    routeMarkers.set(journey.turnPts, selectTurn);
    layoutShift();
    const all = [homePos, ...journey.pts];
    const box = new THREE.Box3().setFromPoints(all);
    const target = box.getCenter(new THREE.Vector3());
    // Zoom to the journey itself: a 500 m route in town needs a close view, not the valley's 7 km.
    controls.minDistance = ROUTE_MIN_KM;
    const span = Math.max(ROUTE_MIN_KM + 0.3, box.getSize(new THREE.Vector3()).length() * 2.4);
    // Near-overhead, north-up: reads like a navigation map.
    director.flyTo({ target, position: target.clone().add(new THREE.Vector3(0.02, 0.96, 0.28).normalize().multiplyScalar(span)) }, 1800);
  };
  const closeRoute = (fly = true) => {
    if (!routeOpen) return;
    routeOpen = false;
    ui!.hideRoute();
    if (using2d) {
      using2d = false;
      document.body.classList.remove('route-2d');
      void map2d?.then((m) => m?.clear());
      return;
    }
    home.setBold(false, timer.getElapsed());
    routeMarkers.clear();
    controls.minDistance = VALLEY_MIN_KM;
    layoutShift();
    if (fly && viewShot) director.flyTo(viewShot, 1600);
  };
  const selectTurn = (i: number) => {
    if (!journey) return;
    ui!.selectStep(i);
    if (using2d) return void map2d?.then((m) => m?.selectTurn(i));
    const p = journey.turnPts[i];
    if (!p) return;
    routeMarkers.select(i);
    director.flyTo({ target: p.clone(), position: p.clone().add(new THREE.Vector3(0.02, 0.96, 0.28).normalize().multiplyScalar(ROUTE_MIN_KM + 0.4)) }, 1200);
  };

  const selectHome = (lngLat: LngLat, place: string, namedPlace = true) => {
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
    // Real buildings and roads for this place (pre-extracted; see apps/web/scripts/fetch-areas.py).
    housesFor = loadAreaFor(lngLat).catch(() => null);
    const local = slopesNear(cell);
    localSlides = local;
    const risk = assessHome(hm, hy, cell, local);
    const avoid = new Uint8Array(hm.cols * hm.rows);
    for (const s of local) for (const c of s.path) for (const i of neighbourhood(hm, c, 1)) avoid[i] = 1;
    // If the home area is at risk, "higher ground" must be outside it.
    if (risk.level !== 'low') for (const i of neighbourhood(hm, cell, 2)) avoid[i] = 1;
    const named = new Map<number, string>();
    for (const c of centres) {
      const ci = nearestCell(hm, c.lngLat);
      if (ci !== null && !named.has(ci)) named.set(ci, c.name);
    }
    // Prefer a named evacuation centre; otherwise any safe higher ground.
    // Prefer a named centre only if it is reasonably close; otherwise the nearest higher ground.
    const plain = routeToSafeGround(hm, hy, cell, avoid);
    const viaCentre = named.size ? routeToSafeGround(hm, hy, cell, avoid, 20, named) : null;
    const route =
      viaCentre && (!plain || viaCentre.distanceKm <= Math.max(3, plain.distanceKm * 2.5)) ? viaCentre : plain;
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
    slides = createLandslides(local, hm, frame, stage.fogColor, { mask: boundary.texture });
    scene.add(slides.group);

    focus.centre.copy(homePos);
    focusTarget = 1;
    hour = targetHour = NOW_HOUR;
    whatIf = false;
    ui!.setWhatIf(false);
    // Valley-wide flagged slopes within 30 km and higher than the home: debris can reach its river.
    const upstreamSlopes = hotspotSources.filter((h) => hm.elevM[h.cell] > hm.elevM[cell] + 50 && cellWorld(h.cell).distanceTo(cellWorld(cell)) < 30).length;
    closeRoute(false);
    journey = null;
    ui!.showResult({ place, risk, nowHour: NOW_HOUR, route, upstreamSlopes });
    homePlace = place;
    refreshOfficial();
    syncUrl({ place, lngLat, named: namedPlace });
    void requestJourney();
    layoutShift();

    // Frame the home and its safe ground together.
    const safe = routePts ? routePts[routePts.length - 1] : homePos;
    const target = homePos.clone().lerp(safe, 0.35);
    const span = Math.max(10, homePos.distanceTo(safe) * 3.2);
    // Higher, map-like angle so the route and the expected flood area read at a glance.
    viewShot = { target, position: target.clone().add(new THREE.Vector3(0.22, 0.9, 0.42).normalize().multiplyScalar(span)) };
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
    slideShots = null;
    ui!.setStreet('loading');
    const area = await housesFor;
    if (!homeLngLat) return;
    if (!street) {
      street = createStreet({
        renderer: stage.renderer,
        hm,
        hy,
        home: homeLngLat,
        homeCell,
        area,
        slides: localSlides,
        homeLabel: t('yourHome'),
        slideLabels: { watch: t('slopeWatch'), warn: t('slopeWarn'), active: t('slopeActive') },
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
    controls.maxDistance = 1100;
    const f = street.homeFocus;
    // Frame the home; if a landslide threatens it, put the hillside behind the home in view.
    let target = f.clone();
    // From across the road, slightly to one side, at roughly first-floor height.
    const side = new THREE.Vector3(street.homeFront.z, 0, -street.homeFront.x);
    // Real neighbourhoods are irregular: a higher oblique view shows the street pattern and the water.
    let pos = f.clone().addScaledVector(street.homeFront, 95).addScaledVector(side, 45).add(new THREE.Vector3(0, 65, 0));
    if (street.slideMid) {
      // One wide shot that holds the crown, the runout and the home — kept for the whole landslide.
      slideShots = findSlideShots(street, f, camera, visibleBounds(document.getElementById('result')));
      if (slideShots) {
        target = slideShots.wide.target.clone();
        pos = slideShots.wide.position.clone();
      } else {
        const toSlide = street.slideMid.clone().sub(f).setY(0).normalize();
        target = street.slideMid.clone().lerp(f, 0.3);
        const span = Math.max(260, street.slideMid.clone().setY(0).distanceTo(f.clone().setY(0)) * 0.9);
        pos = target.clone().addScaledVector(toSlide, -span).add(new THREE.Vector3(toSlide.z * span * 0.35, span * 0.55, -toSlide.x * span * 0.35));
      }
    }
    streetShot = { target: target.clone(), position: pos.clone() };
    controls.maxDistance = Math.max(1100, pos.distanceTo(target) * 1.2);
    controls.target.copy(target);
    camera.position.copy(pos).add(new THREE.Vector3(0, 60, 0));
    stage.setScene(street.scene);
    director.flyTo({ target, position: pos }, 2400);
    ui!.setStreet('on');
    // The street opens at "now" — before the water — and waits for "See what could happen".
    hour = targetHour = NOW_HOUR;
    whatIf = false;
    ui!.setWhatIf(false);
  };

  const leaveStreet = () => {
    if (!inStreet) return;
    inStreet = false;
    hour = targetHour = NOW_HOUR;
    whatIf = false;
    ui!.setWhatIf(false);
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
    homePlace = '';
    journeySeq++;
    closeRoute(false);
    journey = null;
    ui!.setJourney(null);
    ui!.setOfficial(null);
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
    hour = targetHour = NOW_HOUR;
    whatIf = false;
    ui!.showLanding();
    layoutShift();
    director.flyTo(overview, 2400);
    syncUrl(null);
  };

  ui = createResidentUi(realTowns.slice(0, 20), {
    onPick: (town) => selectHome(town.lngLat, town.name),
    onAddress: ({ lngLat, label }) => (boundary.inside(lngLat) ? selectHome(lngLat, label, false) : ui!.note(t('outside'))),
    searchAddresses: (q) => searchAddresses(q, KELANTAN.bbox),
    onLocate: () => {
      if (!navigator.geolocation) return ui!.note(t('noLocation'));
      ui!.note(t('locating'));
      navigator.geolocation.getCurrentPosition(
        (p) => {
          const lngLat: LngLat = [p.coords.longitude, p.coords.latitude];
          const [minLon, minLat, maxLon, maxLat] = KELANTAN.bbox;
          if (lngLat[0] < minLon || lngLat[0] > maxLon || lngLat[1] < minLat || lngLat[1] > maxLat) ui!.note(t('outside'));
          else selectHome(lngLat, t('myLocation'), false);
        },
        () => ui!.note(t('noLocation')),
        { timeout: 10000 },
      );
    },
    onShowWay: () => {
      leaveStreet();
      // A road route from the routing API: open the route screen.
      if (journey) return openRoute();
      // Otherwise (endpoint not live): fly along the terrain estimate.
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
      followSlide = true;
      // Play the future from "now" to just after the real peak.
      targetHour = whatIf ? Math.min(REPLAY_HOURS, peakHour() + 12) : NOW_HOUR;
      ui!.setWhatIf(whatIf);
    },
    onChange: backToLanding,
    onStreet: () => (inStreet ? leaveStreet() : void enterStreet()),
    onRouteBack: () => closeRoute(),
  });

  // Tap the map to choose a home.
  const down = new THREE.Vector2();
  let downAt = 0;
  stage.pointerTarget.addEventListener('pointerdown', (e) => {
    followSlide = false;
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
    selectHome(lngLat, nearestTownName(lngLat), false);
  });

  ui.showLanding();
  layoutShift();
  ui.ready();

  // Places where both hazards meet: REAL villages that a flagged slope's runout reaches
  // (the same test the resident view runs), preferring ones that also face flooding.
  const hillPlaces: Town[] = [];
  {
    const scored: { town: Town; score: number }[] = [];
    for (const v of real.villages) {
      if (v.kind === 'city') continue;
      const cell = nearestCell(hm, v.lngLat);
      if (cell === null || hy.seaMask[cell] || hy.slopeDeg[cell] > 25) continue;
      // Quick pre-check (close search only), then the shared search used by the card.
      const quick = findSlideSources(hm, hy, { minSlopeDeg: 24, minElevM: 80, spacingKm: 0.8, max: 6, near: { cell, radiusKm: 2.5 } });
      if (!quick.length || assessHome(hm, hy, cell, quick).slideLevel !== 'high') continue;
      const local = slopesNear(cell);
      const r = assessHome(hm, hy, cell, local);
      if (r.slideLevel !== 'high' || !r.slide) continue;
      // Feature only slopes inside Kelantan: the model has no ground beyond the border to show them on.
      const sr = Math.floor(r.slide.cell / hm.cols);
      if (!boundary.inside(cellLngLat(hm, r.slide.cell - sr * hm.cols, sr))) continue;
      const both = r.floodLevel !== 'low';
      scored.push({ town: { name: v.name, lngLat: v.lngLat, note: both ? 'landslide + flood' : 'landslide' }, score: r.slide.slopeDeg + (both ? 100 : 0) });
    }
    // One landslide-only village (the clearest demo of a slope failing), then the steepest
    // landslide + flood village (the cascade), then the next landslide-only one.
    const slideOnly = scored.filter((s) => s.score < 100).sort((a, b) => b.score - a.score);
    const both = scored.filter((s) => s.score >= 100).sort((a, b) => b.score - a.score);
    for (const s of [slideOnly[0], both[0], slideOnly[1], both[1]]) if (s && hillPlaces.length < 3 && !hillPlaces.some((p) => p.name === s.town.name)) hillPlaces.push(s.town);
  }
  // Lead with one flood place and one landslide place; everything else is searchable.
  const ordered = [realByName('Kuala Krai'), ...hillPlaces.slice(0, 2), realByName('Dabong'), realByName('Kota Bharu')].filter(
    (x): x is Town => !!x,
  );
  const allPlaces = [...ordered, ...hillPlaces.slice(2), ...realTowns.filter((t) => !ordered.some((o) => o.name === t.name))];
  ui.setPlaces(allPlaces);

  // Workstream C's data, when the API is up. Until then: local stand-ins.
  // Real candidate evacuation centres (schools, community halls) from C's data.
  let centres: { name: string; lngLat: LngLat }[] = real.centres;
  const loadApiData = () => {
    void fetchStations(KELANTAN.id).then((list) => {
      if (!list?.length) return;
      if (stations) { scene.remove(stations.mesh); stations.dispose(); }
      stations = createStations(list, hm, frame);
      scene.add(stations.mesh);
      updateGaugeCaption();
    });
    // Prefer the API's copies (same source, maintained by C) when it's running.
    void fetchVillages(KELANTAN.id).then((v) => v && ui!.setPlaces([...allPlaces, ...v]));
    void fetchEvacCentres(KELANTAN.id).then((c: EvacCentre[] | null) => {
      if (c?.length) centres = c.map((x) => ({ name: x.name, lngLat: x.location.coordinates }));
    });
  };
  const updateGaugeCaption = () => {
      if (!stations) return;
      const c = stations.counts;
      const above = c.alert + c.warning + c.danger;
      const when = new Date(stations.newest).toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const el = document.getElementById('live-gauges')!;
      el.textContent = `Live now: ${stations.total} JPS river gauges · ${above ? `${above} above Normal` : 'all Normal'} · ${when}`;
      el.hidden = false;
  };

  // ---- Control room: live events (or the scripted mock), Tech HUD, human approval ----------
  let replay: ReplayStatus = { running: false };
  let replayTs: string | undefined;
  let agentTriggered = false;
  let runBusy = false;
  let activeRunId: string | null = null;
  let syncingRun = false;
  let selectedHazardTs: string | undefined;
  let inspectionAnchor: string | undefined;
  let hazardKey = '';
  let hazardTimer = 0;
  let lastScenarioVersion = '';
  const hazardStatus = document.getElementById('hazard-status')!;
  const hazardTime = document.getElementById('hazard-time') as HTMLInputElement;
  const hazardFollow = document.getElementById('hazard-follow') as HTMLInputElement;
  const loader = createScenarioLoader((data, error) => {
    if (!data) { apiHazards.clear(); lastScenarioVersion = ''; if (error) hazardKey = ''; document.getElementById('hazard-limitations')!.textContent = 'Scenario coverage is unknown until the API responds. Unshaded areas are not confirmed clear.'; hazardStatus.textContent = error ?? 'Loading scenario…'; return; }
    apiHazards.set(data);
    lastScenarioVersion = data.version;
    const counts = data.roadStatusCounts;
    hazardStatus.textContent = `${data.mode === 'replay' ? 'Reconstructed replay' : 'Live readings'} · ${new Date(data.assessedAt).toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur' })} MYT · Approximate. Roads: ${counts.flooded} flooded, ${counts.unknown} unknown, ${counts.clear} assessed clear, ${counts.outsideFloodplain} outside floodplain. ${data.gauges.filter(g => g.stale).length + data.gaugesWithoutReading.length} gauges without fresh readings.`;
    document.getElementById('hazard-limitations')!.textContent = [data.landslideLabel, ...data.limitations].join(' ');
  });
  const refreshHazards = (force = false) => {
    if (hub.mode !== 'live') return;
    const mode = selectedHazardTs || replayTs ? 'replay' : 'live';
    const ts = selectedHazardTs ?? replayTs;
    const key = `${mode}:${ts ?? Math.floor(Date.now() / 60000)}`;
    if (!force && key === hazardKey) return;
    hazardKey = key;
    void loader.load(KELANTAN.id, mode, ts);
  };
  const selectScenario = () => {
    if (hazardFollow.checked) { selectedHazardTs = undefined; inspectionAnchor = undefined; }
    else { inspectionAnchor ??= replayTs; if (inspectionAnchor) selectedHazardTs = new Date(Date.parse(inspectionAnchor) + Number(hazardTime.value) * 3600000).toISOString(); }
    hazardTime.disabled = !(inspectionAnchor || replayTs);
    const label = document.getElementById('hazard-time-label')!;
    label.textContent = selectedHazardTs ? new Date(selectedHazardTs).toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur' }) + ' MYT' : 'Following scenario clock';
    loader.clear();
    clearTimeout(hazardTimer);
    hazardTimer = window.setTimeout(() => refreshHazards(), 250);
  };
  document.getElementById('hazard-snapshot')!.addEventListener('click', () => { inspectionAnchor = '2014-12-24T15:59:59.000Z'; hazardFollow.checked = false; hazardTime.value = '0'; selectScenario(); });
  hazardTime.addEventListener('input', () => { hazardFollow.checked = false; selectScenario(); });
  hazardFollow.addEventListener('change', selectScenario);
  const knowledge = createKnowledgeSearch(document.getElementById('knowledge-search')!, ll => {
    const c = nearestCell(hm, ll);
    if (c === null) return control.note('This place is outside the displayed terrain.');
    const target = frame.lngLatToWorld(ll, hm.elevM[c]);
    director.flyTo({ target, position: target.clone().add(new THREE.Vector3(0, 20, 12)) }, 1800);
  });
  knowledge.setEnabled(false);
  const applyReplay = (status: ReplayStatus) => {
    replay = status;
    replayTs = status.ts;
    hazardTime.disabled = !(replayTs || inspectionAnchor);
    refreshHazards();
    if (status.ts && document.body.dataset.mode === 'control') {
      const h = Math.max(0, Math.min(REPLAY_HOURS, (Date.parse(status.ts) - REPLAY_START_MS) / 3600_000));
      hour = targetHour = h;
    }
    control.setReplay(status.running, status.ts
      ? `Reconstructed 2014 replay · ${new Date(status.ts).toLocaleDateString('en-GB', { timeZone: 'Asia/Kuala_Lumpur' })}${status.running ? ' · running' : ' · stopped'}`
      : status.running ? 'Starting reconstructed 2014 replay…' : 'Replay stopped');
  };
  const toggleReplay = async () => {
    if (hub.mode === 'mock') {
      replay.running = !replay.running;
      if (replay.running) { hour = 0; targetHour = REPLAY_HOURS; agentTriggered = false; }
      else targetHour = hour;
      control.setReplay(replay.running, 'Scripted demo · reconstructed 2014 animation');
      return;
    }
    if (hub.mode !== 'live') return control.note('API disconnected — reconnect before starting the replay.');
    control.setReplay(replay.running, 'Updating replay…', true);
    try { applyReplay(replay.running ? await stopReplay() : await startReplay(KELANTAN.id)); }
    catch (err) {
      control.setReplay(replay.running, `Replay: ${err instanceof Error ? err.message : String(err)}`);
      const status = await fetchReplayStatus();
      if (status) applyReplay(status);
    }
  };
  const control = createControlUi({
    onReplay: () => void toggleReplay(),
    onRun: () => void startAgent(),
    onDecide: (id, d) => void decide(id, d),
    onSelectAlert: (alert) => showAlertRoute(alert),
  });
  control.setMode('connecting');
  const hub = createEventHub({
    forceMock: params.get('mock') === '1',
    onReadOnly: (value) => control.setReadOnly(value),
    onMode: (m) => {
      control.setMode(m);
      setApiLive(m === 'live');
      knowledge.setEnabled(m === 'live');
      if (m !== 'live') { loader.clear(); hazardKey = ''; hazardStatus.textContent = m === 'mock' ? 'Scripted walkthrough · local reconstructed visuals' : 'Hazard API disconnected · coverage unknown'; }
      else refreshHazards(true);
      if (m === 'live') {
        loadApiData();
        // A home chosen before the API connected (e.g. opened from a link) gets its route now.
        if (homeLngLat && !journey && !routeFixture) void requestJourney();
        void fetchSaintTasks().then((tasks) => tasks?.forEach((task) => control.task(task)));
        void fetchReplayStatus().then((status) => status && applyReplay(status));
      }
    },
  });
  const mockAgent = createMockAgent(hub.emit);
  const AGENT_VILLAGE = 'Kuala Krai';
  let agentVillageCell = -1;

  let lastAgentPlace = '', lastAgentMove = -Infinity;
  hub.on('hazards.update', ({ hazards }) => { if (hazards.regionId === KELANTAN.id && hazards.mode === (selectedHazardTs || replayTs ? 'replay' : 'live')) refreshHazards(true); });
  hub.on('agent.step', ({ step }) => {
    control.step(step);
    if (document.body.dataset.mode === 'control' && ['subagent', 'verify', 'replan'].includes(step.kind)) {
      // AgentStep has no village ID: match explicit known village names in backend summary formats.
      const place = allPlaces.find(p => step.summary.startsWith(p.name + ':') || ['Quick draft for ', 'Replanning ', 'Refining ', 'Planning '].some(prefix => step.summary === prefix + p.name || step.summary.startsWith(prefix + p.name + ' [TEST')));
      const name = place?.name;
      if (place && name !== lastAgentPlace && performance.now() - lastAgentMove > 3000) {
        const c = nearestCell(hm, place.lngLat);
        if (c !== null) {
          lastAgentPlace = place.name; lastAgentMove = performance.now();
          const target = frame.lngLatToWorld(place.lngLat, hm.elevM[c]);
          director.flyTo({ target, position: target.clone().add(new THREE.Vector3(0, 18, 12)) }, 1600);
        }
      }
      document.getElementById('agent-focus')!.textContent = step.summary;
    }
    if (hub.mode === 'mock' && step.summary.includes('Waiting for a human')) {
      runBusy = false;
      control.setRunBusy(false);
    }
  });
  hub.on('risk.event', ({ riskEvent }) => control.risk(riskEvent));
  hub.on('saint.task', ({ task }) => control.task(task));
  hub.on('evac.updated', ({ evacCentre }) => {
    if (evacCentre.regionId !== KELANTAN.id) return;
    const place = { name: evacCentre.name, lngLat: evacCentre.location.coordinates };
    const i = centres.findIndex((c) => c.name === place.name);
    if (i >= 0) centres[i] = place;
    else centres.push(place);
    control.evac(evacCentre);
  });
  // ---- Closing the loop: an alert a person approved reaches the resident's card ----------------
  const approved = new Map<string, Alert>();
  const kmBetween = (a: LngLat, b: LngLat) => frame.lngLatToWorld(a).distanceTo(frame.lngLatToWorld(b));
  const refreshOfficial = () => {
    if (!homeLngLat) return ui!.setOfficial(null);
    // An alert covers this home if it was drafted for this place, or its village (the route's start) is close.
    const match = [...approved.values()]
      .filter((a) => a.villageId === homePlace || (a.route.coordinates.length > 0 && kmBetween(a.route.coordinates[0], homeLngLat!) < 3))
      .sort((a, b) => (b.approvedAt ?? '').localeCompare(a.approvedAt ?? ''))[0];
    if (!match) return ui!.setOfficial(null);
    const end = match.route.coordinates[match.route.coordinates.length - 1];
    const centre = end && centres.length ? centres.reduce((best, c) => (kmBetween(c.lngLat, end) < kmBetween(best.lngLat, end) ? c : best), centres[0]) : null;
    const message = match.messages.find((m) => m.lang.startsWith('en')) ?? match.messages[0];
    ui!.setOfficial({
      id: match._id,
      languages: hub.mode === 'mock' ? [] : match.messages.map(m => m.lang),
      approvedAt: match.approvedAt ?? null,
      approvedBy: match.approvedBy ?? null,
      centre: centre && end && kmBetween(centre.lngLat, end) < 1 ? centre.name : match.evacCentreId,
      people: match.people,
      message: message?.text ?? '',
    });
  };
  const noteApproved = (alert: Alert) => {
    if (alert.status === 'approved' || alert.status === 'sent') approved.set(alert._id, alert);
    else approved.delete(alert._id);
    refreshOfficial();
  };
  const showAlertRoute = (alert: Alert) => {
    if (document.body.dataset.mode !== 'control') return;
    const pts = alert.route.coordinates.map((ll) => frame.lngLatToWorld(ll, sampleElev(ll)).add(new THREE.Vector3(0, 0.05, 0)));
    if (!pts.length) return;
    home.setLabels(alert.villageId, alert.evacCentreId);
    home.set(pts[0], pts.length > 1 ? pts : null, 0, timer.getElapsed());
    focus.centre.copy(pts[0]);
    focusTarget = 1;
    const span = Math.max(14, pts[0].distanceTo(pts[pts.length - 1]) * 3);
    director.flyTo({ target: pts[0].clone(), position: pts[0].clone().add(new THREE.Vector3(0.35, 0.62, 0.7).normalize().multiplyScalar(span)) }, 2600);
  };
  hub.on('alert.updated', ({ alert }) => {
    if (alert.regionId !== KELANTAN.id) return;
    noteApproved(alert);
    control.alert(alert);
    if (control.currentAlert?._id === alert._id) showAlertRoute(alert);
  });
  hub.on('replay.tick', ({ ts }) => applyReplay({ ...replay, ts }));
  hub.on('reading.new', ({ reading }) => {
    if (reading.meta.mode === 'live') { stations?.reading(reading); updateGaugeCaption(); }
  });

  // Recover persisted steps/alerts missed during a disconnect, and surface asynchronous run failures.
  const syncRun = async () => {
    if (!activeRunId || syncingRun || hub.mode !== 'live') return;
    syncingRun = true;
    try {
      const detail = await fetchAgentRun(activeRunId);
      if (!detail) return;
      detail.steps.forEach((step) => control.step(step));
      detail.alerts.forEach((alert) => { noteApproved(alert); control.alert(alert); });
      if (detail.run.status !== 'running') {
        runBusy = false;
        control.setRunBusy(false);
        if (detail.run.status === 'failed') control.note(`Agent failed: ${detail.run.error ?? 'see the run steps'}`);
        activeRunId = null;
      }
    } finally { syncingRun = false; }
  };
  window.setInterval(() => {
    void syncRun();
    refreshHazards();
    if (hub.mode === 'live') void fetchReplayStatus().then((status) => status && applyReplay(status));
  }, 5000);

  const sampleElev = (ll: LngLat) => {
    const c = nearestCell(hm, ll);
    return c === null ? 0 : Math.max(hm.elevM[c], 0);
  };

  const startAgent = async () => {
    if (runBusy) return;
    if (hub.mode !== 'live' && hub.mode !== 'mock') return control.note('API disconnected — reconnect before running the agent.');
    agentTriggered = true;
    runBusy = true;
    control.setRunBusy(true);
    if (hub.mode === 'mock') control.reset();
    home.set(null, null, 0, timer.getElapsed());
    const ll = realByName(AGENT_VILLAGE)!.lngLat;
    agentVillageCell = nearestCell(hm, ll)!;
    if (hub.mode === 'live') {
      try {
        const r = await runAgent(KELANTAN.id, selectedHazardTs || replayTs ? { mode: 'replay', at: selectedHazardTs ?? replayTs } : { mode: 'live' });
        activeRunId = r.runId;
        control.note(`Agent run ${r.runId} started`);
        return;
      } catch (err) {
        control.note(`API: ${err instanceof Error ? err.message : String(err)}`);
        runBusy = false;
        control.setRunBusy(false);
        return;
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

  const decide = async (id: string, d: 'approve' | 'reject') => {
    if (hub.mode === 'mock') { mockAgent.decide(d, 'Duty officer'); return; }
    if (hub.mode !== 'live') return control.note('API disconnected — no decision was sent.');
    control.setDeciding(true);
    try { const updated = await decideAlert(id, d, 'Duty officer'); noteApproved(updated); control.alert(updated); }
    catch (err) { control.note(`API: ${err instanceof Error ? err.message : String(err)}`); }
    finally { control.setDeciding(false); }
  };

  // ---- Modes ---------------------------------------------------------------------------
  const setMode = (m: 'resident' | 'control') => {
    document.body.dataset.mode = m;
    document.getElementById('mode-resident')!.classList.toggle('on', m === 'resident');
    document.getElementById('mode-control')!.classList.toggle('on', m === 'control');
    if (m === 'control') {
      closeRoute(false);
      leaveStreet();
      ui!.showLanding();
      document.body.dataset.view = 'control';
      controls.autoRotate = false;
        focusTarget = 0;
      home.set(null, null, 0, timer.getElapsed());
      homePos = null;
      layoutShift();
      if (hub.mode === 'live' && replayTs) applyReplay(replay);
      if (control.currentAlert) showAlertRoute(control.currentAlert);
      else director.flyTo(overview, 2200);
      syncUrl(null);
    } else {
      mockAgent.stop();
      if (hub.mode === 'mock') { runBusy = false; control.setRunBusy(false); }
      backToLanding();
    }
  };
  document.getElementById('mode-resident')!.addEventListener('click', () => setMode('resident'));
  document.getElementById('mode-control')!.addEventListener('click', () => setMode('control'));

  document.body.classList.toggle('recording', params.has('demo'));
  // ---- Recording presets (?demo=1, keys 1–6) -------------------------------------------
  const pick = (name: string) => {
    const p = allPlaces.find((x) => x.name === name || x.name.includes(name));
    if (p) selectHome(p.lngLat, p.name);
  };
  window.addEventListener('keydown', (e) => {
    if (!params.has('demo') || (e.target instanceof HTMLElement && (e.target.matches('input, textarea, select, button') || e.target.isContentEditable))) return;
    const k = e.key;
    if (k === '1') setMode('resident');
    if (k === '2') (setMode('resident'), pick('Kuala Krai'));
    if (k === '3') (setMode('resident'), pick('Kuala Krai'), window.setTimeout(() => void enterStreet().then(() => document.getElementById('btn-whatif')!.click()), 2800));
    if (k === '4') (setMode('resident'), pick(hillPlaces[0]?.name ?? 'Kampung Jabir'), window.setTimeout(() => void enterStreet().then(() => document.getElementById('btn-whatif')!.click()), 2800));
    if (k === '5') (setMode('control'), window.setTimeout(() => void startAgent(), 2400));
    if (k === '6' && control.currentAlert?.status === 'verified') void decide(control.currentAlert._id, 'approve');
  });
  // A short settle-in from high above the state.
  controls.target.copy(ovTarget);
  camera.position.copy(ovTarget).add(new THREE.Vector3(0, 330, 40));
  director.flyTo(overview, 3600);

  // Opened from a link (e.g. the page behind an alert): ?place=Kuala%20Krai[&view=street], ?at=lon,lat, #control.
  {
    const linked = params.get('place');
    const at = params.get('at')?.split(',').map(Number);
    const openStreet = () => params.get('view') === 'street' && window.setTimeout(() => void enterStreet(), 2800);
    if (location.hash === '#control') setMode('control');
    else if (linked) {
      const p = allPlaces.find((x) => x.name.toLowerCase() === linked.toLowerCase()) ?? matchPlaces(linked, allPlaces)[0];
      if (p) (selectHome(p.lngLat, p.name), openStreet());
    } else if (at && at.length === 2 && at.every(Number.isFinite)) {
      const lngLat: LngLat = [at[0], at[1]];
      (selectHome(lngLat, nearestTownName(lngLat), false), openStreet());
    }
  }

  // ---- Frame loop --------------------------------------------------------
  stage.renderer.setAnimationLoop((now) => {
    timer.update(now);
    const dt = Math.min(timer.getDelta(), 0.1);
    const time = timer.getElapsed();
    director.update(performance.now());
    controls.update();

    // Landing: loop the Dec 2014 replay so flood and landslides play out on the terrain.
    const landing = document.body.dataset.view === 'landing' && document.body.dataset.mode !== 'control' && !homePos;
    if (landing) {
      targetHour = hour = hour >= REPLAY_HOURS + 24 ? 0 : hour + dt * (REPLAY_HOURS / 26);
    } else if (wasLanding && !(document.body.dataset.mode === 'control' && replayTs)) hour = targetHour = NOW_HOUR;
    wasLanding = landing;
    // Replay time eases towards its target: forward slowly, back quickly.
    // Slow the replay right down while a landslide surges, so it can be seen.
    const rate = targetHour > hour ? (inStreet ? (street?.slideSurging ? 0.15 : 6) : 10) : 40;
    hour = targetHour > hour ? Math.min(targetHour, hour + dt * rate) : Math.max(targetHour, hour - dt * rate);
    focus.amount += (focusTarget - focus.amount) * Math.min(1, dt * 2.5);
    // Scripted demo only. Real runs are triggered by B's backend risk-event listener.
    if (hub.mode === 'mock' && document.body.dataset.mode === 'control' && replay.running && !agentTriggered && hour > 0.5 && stageM(hour) >= AGENT_TRIGGER_STAGE_M) void startAgent();
    explode += (explodeTarget - explode) * Math.min(1, dt * 2.2);

    const camDist = camera.position.distanceTo(controls.target);
    FOG.value = 0.26 / Math.max(camDist, 60);
    geoCtx.update(camera, !!homePos, camDist);
    if (stations) {
      stations.mesh.visible = document.body.dataset.mode === 'control';
      stations.update(camDist);
    }
    const s = stageM(Math.min(hour, REPLAY_HOURS));
    valley.update(rainAccumulated(hour), time, focus);
    // Around a chosen home, outline where the water is expected to reach at the peak.
    const apiControl = document.body.dataset.mode === 'control' && hub.mode !== 'mock';
    flood.mesh.visible = !apiControl;
    hotspots.group.visible = !apiControl;
    if (slides) slides.group.visible = !apiControl;
    apiHazards.group.visible = apiControl && hub.mode === 'live';
    flood.update(s, time, focus, homePos && !inStreet ? stageM(REPLAY_HOURS) : 1000);
    rain.update(controls.target, camDist, rainIntensity(hour) * (homePos ? 0.35 : 1), time);
    home.update(camDist, time);
    slides?.update(hour, camDist, time);
    hotspots.update(hour, camDist, time);
    hotspots.setLabelsVisible(explode < 0.3);
    // Keep the valley camera above the ground: from inside a hill the terrain (drawn from above only)
    // vanishes and only the model's base and the slide overlays remain.
    if (!inStreet) {
      const ll = frame.worldToLngLat(camera.position);
      const { gx, gy } = gridCoords(hm, ll);
      const e = sampleField(hm, hm.elevM, gx, gy);
      if (Number.isFinite(e)) {
        const minY = frame.lngLatToWorld(ll, Math.max(e, 0)).y + 0.4;
        if (camera.position.y < minY) camera.position.y = minY;
      }
    }
    if (inStreet && street) {
      street.animate(hour, time);
      const stats = street.update(Math.round(hour * 20) / 20) ?? (street.buried !== lastBuried ? { wet: lastWet, total: lastTotal, buried: street.buried } : null);
      if (stats) {
        lastBuried = stats.buried ?? 0;
        lastWet = stats.wet;
        lastTotal = stats.total;
      }
      if (street.slideFailedNow()) shakeUntil = time + 1.6;
      // Follow the landslide while it plays: cracks at the head, then the moving front.
      // While the future plays, hold the wide landslide shot (unless the user has taken the camera).
      // Wide while the slope cracks and fails; once the debris has settled, ease in on the homes it reached.
      const slideState = street.slideState;
      if (slideState !== 'settled') settledAt = -1;
      else if (settledAt < 0) settledAt = time;
      if (whatIf && followSlide && !director.busy && slideShots && slideState !== 'quiet') {
        const shot = slideState === 'settled' && time - settledAt > 1.5 ? slideShots.close : slideShots.wide;
        const k = Math.min(1, dt * (shot === slideShots.close ? 0.5 : 1.2));
        controls.target.lerp(shot.target, k);
        camera.position.lerp(shot.position, k);
      }
      if (time < shakeUntil) {
        const k = (shakeUntil - time) / 1.6;
        // Scaled to the viewing distance so the jolt reads from a wide shot too.
        const amp = k * Math.max(1, camera.position.distanceTo(controls.target) / 160);
        shakeOff.set(Math.sin(time * 61) * 0.9 * amp, Math.sin(time * 47) * 0.6 * amp, Math.cos(time * 53) * 0.9 * amp);
      } else shakeOff.set(0, 0, 0);
      // Keep the camera in the neighbourhood and out of hillsides.
      if (!director.busy && streetShot && camera.position.distanceTo(street.homeFocus) > 2400) {
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
    if (document.body.dataset.mode === 'control' && hub.mode === 'live') {
      document.getElementById('clock-tag')!.textContent = selectedHazardTs || replayTs ? 'Replay' : 'Live now';
      document.getElementById('clock-time')!.textContent = new Date(selectedHazardTs ?? replayTs ?? Date.now()).toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' MYT';
    } else if (landing || (document.body.dataset.mode === 'control' && (replayTs || replay.running))) ui!.setReplayClock(Math.min(hour, REPLAY_HOURS));
    else ui!.setClock(hour, NOW_HOUR);
    camera.position.add(shakeOff);
    stage.render();
    frameCount++; frameSeconds += timer.getDelta();
    if (frameSeconds >= 1) {
      document.getElementById('render-performance')!.textContent = `${Math.round(frameCount / frameSeconds)} fps · ${stage.renderer.info.memory.geometries} geometries`;
      frameCount = 0; frameSeconds = 0;
    }
    camera.position.sub(shakeOff);
  });

  // Dev handle for quick checks in the console.
  Object.assign(window, { __mw: { hm, hy, depthAt, camera, controls, getStreet: () => street, hillPlaces, getScenarioVersion: () => lastScenarioVersion, renderer: stage.renderer } });
}

main().catch((err) => {
  console.error(err);
  const el = document.getElementById('loading-msg');
  if (el) el.textContent = `Could not load the valley: ${err instanceof Error ? err.message : String(err)}`;
  document.body.classList.add('failed');
});
