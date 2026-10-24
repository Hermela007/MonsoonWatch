import { createResidentAudio } from './residentAudio';
import { createAlertAudio } from './alertAudio';
import type { Town } from '../geo/region';
import { searchPlaces } from '../api/client';
import type { HomeRisk } from '../terrain/homeRisk';
import type { SafeRoute } from '../terrain/route';
import { peakHour, replayDate } from '../data/replay2014';
import { matchPlaces } from './places';
import { t } from './copy';
import { renderJourney, renderJourneySummary, type JourneyView } from './journey';
import type { AddressSuggestion } from '../maps/addressSearch';
import type { LngLat } from '../geo/region';
import type { TravelMode } from '@monsoonwatch/shared';

export interface ResultView {
  place: string;
  risk: HomeRisk;
  nowHour: number;
  route: SafeRoute | null;
  /** Flagged slopes in the hills upstream of the home (valley-wide screening). */
  upstreamSlopes: number;
  /** True when the landslide part comes from the agent's screening (GET /hazards), false for the local estimate. */
  screening?: boolean;
  /** Demo fallback (?landslide=terrain): the terrain estimate stands in for the screening, said so on the card. */
  illustrative?: boolean;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

const fmtDistance = (km: number) => (km < 1 ? `${Math.max(50, Math.round((km * 1000) / 50) * 50)} m` : `${km.toFixed(1)} km`);
const fmtDepth = (m: number) => m.toFixed(0);
const fmtTime = (h: number) =>
  replayDate(h).toLocaleString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const levelText = (l: 'high' | 'medium' | 'low') => (l === 'high' ? t('levelHigh') : l === 'medium' ? t('levelMedium') : t('levelLow'));

/** Pure: the plain-language message for a home — flood and landslide, side by side. */
export function describe(v: ResultView) {
  const { risk, nowHour, route } = v;
  const flood: string[] = [];
  if (risk.floodWetHour !== null) {
    const h = Math.round(risk.floodWetHour - nowHour);
    flood.push(h <= 0 ? t('floodNow') : h > 36 ? t('floodInDays', { d: Math.round(h / 24) }) : t('floodIn', { h }));
    const ph = peakHour();
    if (ph > nowHour) flood.push(t('floodPeak', { when: replayDate(ph).toLocaleDateString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', weekday: 'short', day: 'numeric', month: 'short' }) }));
    const d = risk.peakDepthM;
    if (d >= 4) flood.push(t('floodDepthHouse', { d: fmtDepth(d) }));
    else if (d >= 1.8) flood.push(t('floodDepthHead'));
    else if (d >= 0.3) flood.push(t('floodDepthKnee'));
  } else if (risk.worstWetHour !== null) {
    const wh = Math.max(1, Math.round(risk.worstWetHour - nowHour));
    flood.push(wh > 36 ? t('worstOnlyDays', { d: Math.round(wh / 24) }) : t('worstOnly', { h: wh }));
  } else flood.push(t('floodLow'));

  const slide: string[] = [];
  if (risk.slideLevel === 'high') {
    slide.push(t('slideHigh', { d: fmtDistance(risk.slideDistM / 1000) }));
    if (risk.slideHour !== null && risk.slideHour > nowHour) {
      const sh = Math.round(risk.slideHour - nowHour);
      slide.push(sh > 36 ? t('slideHighWhenDays', { d: Math.round(sh / 24) }) : t('slideHighWhen', { h: sh }));
    }
  } else if (risk.slideLevel === 'medium') slide.push(t('slideMedium', { d: fmtDistance(risk.slideDistM / 1000) }));
  else slide.push(t('slideLow'));
  // Say which landslide model this is (the agent's screening, or the offline terrain estimate).
  if (v.screening !== undefined && risk.slideLevel !== 'low') slide.push(v.illustrative ? t('slideIllustrative') : v.screening ? t('slideScreen') : t('slideEstimate'));
  if (v.upstreamSlopes > 0) slide.push(v.upstreamSlopes === 1 ? t('slideUpstreamOne') : t('slideUpstream', { n: v.upstreamSlopes }));

  const action =
    route && route.cells.length > 1
      ? route.targetName
        ? t('goToCentre', { name: route.targetName, d: fmtDistance(route.distanceKm) })
        : t('goTo', { d: fmtDistance(route.distanceKm) })
      : route
        ? t('stay')
        : t('noRoute');
  const level = risk.level === 'high' ? t('riskHigh') : risk.level === 'medium' ? t('riskMedium') : t('riskLow');
  return {
    level,
    when: leaveBy(v),
    hazards: [
      { key: 'flood', name: t('hazardFlood'), level: risk.floodLevel, levelText: levelText(risk.floodLevel), lines: flood },
      { key: 'slide', name: t('hazardSlide'), level: risk.slideLevel, levelText: levelText(risk.slideLevel), lines: slide },
    ],
    lines: [...flood, ...slide],
    action,
    canRoute: !!route && route.cells.length > 1,
  };
}

/**
 * When to leave, as a clock time rather than "in N hours": a margin before the water arrives, and a
 * longer one before a slope may fail (landslides give little warning). Null when no departure is needed.
 */
export function leaveBy(v: ResultView): string | null {
  const { risk, nowHour } = v;
  const times: number[] = [];
  if (risk.floodWetHour !== null) times.push(risk.floodWetHour - 6);
  if (risk.slideLevel === 'high' && risk.slideHour !== null) times.push(risk.slideHour - 12);
  if (!times.length) return risk.worstWetHour !== null ? t('beReady') : null;
  const h = Math.min(...times);
  if (h <= nowHour + 1) return t('leaveNow');
  // Round down to the hour: a deadline should never be later than the estimate.
  return t('leaveBy', { when: fmtTime(Math.floor(h)) });
}

/** An approved alert as the resident sees it: who approved it, where to go, what it says. */
export interface OfficialAlertView {
  id: string;
  languages: string[];
  status: 'approved' | 'sent';
  heading?: string;
  approvedAt: string | null;
  approvedBy: string | null;
  centre: string;
  people: number;
  message: string;
}

export function createResidentUi(
  initialPlaces: Town[],
  h: {
    onPick: (town: Town) => void;
    /** A geocoded starting point; the person confirms its pin before routing. */
    onAddress: (a: { lngLat: LngLat; label: string; precision?: AddressSuggestion['precision'] }) => void;
    /** Address search (OpenStreetMap via Photon, limited to Kelantan). */
    searchAddresses?: (q: string) => Promise<AddressSuggestion[]>;
    onLocate: () => void;
    onShowWay: () => void;
    onWhatIf: () => void;
    onChange: () => void;
    onStreet: () => void;
    onRouteBack: () => void;
  },
) {
  const input = $<HTMLInputElement>('place-input');
  const suggestions = $('suggestions');
  const note = $('landing-note');
  const listen = $<HTMLButtonElement>('btn-listen');
  let current: ReturnType<typeof describe> | null = null;
  let places = initialPlaces;
  let remote: Town[] = [];
  let addresses: AddressSuggestion[] = [];
  let searchTimer = 0;
  let searchRevision = 0;
  const chooseAddress = async (a: AddressSuggestion) => {
    const mine = ++searchRevision;
    note.textContent = t('findingAddress');
    try {
      const result = await a.resolve();
      if (mine !== searchRevision) return;
      if (result) h.onAddress({ ...result, precision: a.precision }); else note.textContent = t('addressFailed');
    } catch { if (mine === searchRevision) note.textContent = t('addressFailed'); }
  };

  // Choose on press, not on click: a click needs press and release on the same element, and late search
  // results re-rendering the list between the two used to drop the click through to the map. Keyboard
  // activation (Enter/Space) still arrives as a click with detail 0.
  const onChoose = (b: HTMLButtonElement, fn: () => void) => {
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      input.blur(); // done typing: close the phone keyboard, and let shortcuts reach the page again
      fn();
    });
    b.addEventListener('click', (e) => e.detail === 0 && (input.blur(), fn()));
  };
  // Results that arrive while the pointer is over the list wait until it leaves, so options don't move under it.
  let pointerOverList = false;
  let pendingRender = false;
  suggestions.addEventListener('pointerenter', () => (pointerOverList = true));
  suggestions.addEventListener('pointerleave', () => {
    pointerOverList = false;
    if (pendingRender) {
      pendingRender = false;
      renderSuggestions();
    }
  });
  const refreshSuggestions = () => {
    if (pointerOverList) pendingRender = true;
    else renderSuggestions();
  };
  const renderSuggestions = () => {
    const q = input.value.trim();
    const local = q ? matchPlaces(q, places) : places.slice(0, 5);
    const seen = new Set(local.map((p) => p.name.toLowerCase()));
    const matches = [...local, ...remote.filter((p) => !seen.has(p.name.toLowerCase()))].slice(0, addresses.length ? 4 : 10);
    suggestions.innerHTML = '';
    // Address results precede broad place matches.
    for (const a of addresses.slice(0, 5)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'suggestion address';
      b.textContent = a.text;
      const n = document.createElement('small');
      n.textContent = a.precision === 'place' ? 'place' : a.precision === 'street' ? 'street' : t('addressNote');
      b.appendChild(n);
      onChoose(b, () => void chooseAddress(a));
      suggestions.appendChild(b);
    }
    for (const town of matches) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'suggestion';
      b.textContent = town.name;
      {
        // Hazard tags ("landslide", "landslide + flood") say which places show what; otherwise just "village".
        const n = document.createElement('small');
        n.textContent = town.note ?? 'village';
        if (town.note) n.classList.add('hazard-tag');
        b.appendChild(n);
      }
      onChoose(b, () => h.onPick(town));
      suggestions.appendChild(b);
    }
    note.textContent = q && !matches.length && !addresses.length ? t('noMatch') : '';
  };
  input.addEventListener('input', () => {
    searchRevision++;
    remote = [];
    addresses = [];
    renderSuggestions();
    // Atlas Search (via the API) adds villages we don't have locally; silently skipped if the API is down.
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (q.length < 2) return;
    searchTimer = window.setTimeout(async () => {
      const [hits, found] = await Promise.all([searchPlaces(q), h.searchAddresses ? h.searchAddresses(q) : Promise.resolve([])]);
      if (input.value.trim() !== q) return;
      remote = hits;
      addresses = found;
      if (hits.length || found.length) refreshSuggestions();
    }, 250);
  });
  $('place-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (!q) return;
    const mine = ++searchRevision;
    note.textContent = 'Finding starting points…';
    const [hits, found] = await Promise.all([searchPlaces(q), h.searchAddresses?.(q) ?? Promise.resolve([])]);
    if (mine !== searchRevision) return;
    remote = hits; addresses = found; renderSuggestions();
    note.textContent = found.length || matchPlaces(q, places).length || hits.length ? 'Choose a matching address or village below.' : t('noMatch');
  });
  $('btn-locate').addEventListener('click', h.onLocate);
  $('btn-way').addEventListener('click', h.onShowWay);
  $('btn-whatif').addEventListener('click', h.onWhatIf);
  $('btn-change').addEventListener('click', h.onChange);
  $('btn-street').addEventListener('click', h.onStreet);
  $('btn-route-back').addEventListener('click', h.onRouteBack);

  const officialAudio = createAlertAudio($('official-audio'));
  const audioStatus = document.createElement('p');
  audioStatus.className = 'note'; audioStatus.id = 'resident-audio-status'; audioStatus.setAttribute('role', 'status');
  listen.insertAdjacentElement('afterend', audioStatus);
  listen.hidden = true;
  const residentAudio = createResidentAudio(state => {
    listen.hidden = !state.visible;
    listen.textContent = state.phase === 'playing' ? '■ Stop' : state.phase === 'loading' ? '■ Cancel audio' : `🔊 Listen · Gemini${state.language ? ` (${state.language.toUpperCase()})` : ''}`;
    listen.setAttribute('aria-pressed', String(state.phase === 'playing' || state.phase === 'loading'));
    audioStatus.textContent = state.message;
    audioStatus.hidden = !state.message;
  });
  const stopSpeaking = () => {
    residentAudio.stop();
    document.querySelectorAll<HTMLAudioElement>('#official-audio audio').forEach(audio => audio.pause());
  };
  listen.addEventListener('click', () => {
    document.querySelectorAll<HTMLAudioElement>('#official-audio audio').forEach(audio => audio.pause());
    void residentAudio.toggle();
  });
  $('official-audio').addEventListener('play', () => residentAudio.stop(), true);

  // Static copy.
  for (const el of document.querySelectorAll<HTMLElement>('[data-copy]')) el.textContent = t(el.dataset.copy as never);
  input.placeholder = t('placeholder');
  listen.textContent = `🔊 ${t('listen')}`;
  renderSuggestions();

  return {
    suspendSearch() { searchRevision++; clearTimeout(searchTimer); },
    setPlaces(list: Town[]) {
      const seen = new Set<string>();
      places = list.filter((p) => !seen.has(p.name) && seen.add(p.name));
      renderSuggestions();
    },
    showLanding() {
      searchRevision++; clearTimeout(searchTimer); remote = []; addresses = [];
      stopSpeaking(); residentAudio.set(null);
      document.body.dataset.view = 'landing';
      input.value = '';
      note.textContent = '';
      renderSuggestions();
    },
    showResult(v: ResultView) {
      stopSpeaking(); residentAudio.set(null);
      current = describe(v);
      // A new place: the previous place's journey no longer applies (the new one arrives separately).
      $('journey').hidden = true;
      $('journey').replaceChildren();
      $('risk-action').hidden = false;
      $('btn-way').textContent = t('showWay');
      document.body.dataset.view = 'result';
      document.body.dataset.risk = v.risk.level;
      $('place-name').textContent = v.place;
      $('risk-level').textContent = current.level;
      $('risk-lines').innerHTML = current.hazards
        .map(
          (hz) =>
            `<div class="hazard hz-${hz.key}-row hz-${hz.level}"><div class="hz-head"><span class="hz-icon hz-${hz.key}"></span><span class="hz-name">${hz.name}</span><span class="hz-level">${hz.levelText}</span></div>${hz.lines.map((l) => `<p>${l}</p>`).join('')}</div>`,
        )
        .join('');
      $('risk-action').textContent = current.action;
      $('risk-when').textContent = current.when ?? '';
      $('risk-when').hidden = !current.when;
      $<HTMLButtonElement>('btn-way').disabled = !current.canRoute;
    },
    /** Landing loop: show the replay date/time rather than "Now / +h". */
    setReplayClock(hour: number) {
      $('clock-tag').textContent = 'Dec 2014 replay';
      $('clock-time').textContent = fmtTime(hour);
      document.body.classList.remove('future');
    },
    setClock(hour: number, nowHour: number) {
      const ahead = Math.round(hour - nowHour);
      $('clock-tag').textContent = ahead > 48 ? t('laterDays', { d: Math.round(ahead / 24) }) : ahead > 0 ? t('later', { h: ahead }) : t('now');
      $('clock-time').textContent = fmtTime(hour);
      document.body.classList.toggle('future', ahead > 0);
    },
    /**
     * The road journey from the evacuation-route API, or null to fall back to the terrain estimate
     * (the "Go to higher ground" line) while the endpoint is unavailable.
     */
    setJourneyStatus(message: string) { $('journey-status').textContent = message; },
    setJourney(v: JourneyView | null) {
      const el = $('journey');
      el.hidden = !v;
      $('risk-action').hidden = !!v;
      if (!v) return el.replaceChildren();
      renderJourneySummary(el, v);
      // "Show me the way" opens the route screen: the route, or the alternatives when there is none.
      $<HTMLButtonElement>('btn-way').disabled = false;
      $('btn-way').textContent = v.ok ? t('showWay') : t('routeOptions');
    },
    /** Where the route starts, how exact that is, and how to make it exact (instead of a confirm step). */
    setOrigin(o: { text: string; hint: string | null; snap: string | null } | null) {
      for (const id of ['origin-line', 'route-origin']) {
        const el = $(id);
        el.hidden = !o;
        el.replaceChildren();
        if (!o) continue;
        const main = document.createElement('div');
        main.className = 'origin-main';
        main.textContent = o.text;
        el.append(main);
        const hints = [o.hint, o.snap, id === 'route-origin' ? t('originDrag') : null].filter(Boolean) as string[];
        for (const hint of hints) {
          const p = document.createElement('div');
          p.className = 'origin-hint';
          p.textContent = hint;
          el.append(p);
        }
      }
    },
    /** The route screen: map focused on the journey, this panel in place of the result card. */
    showRoute(v: JourneyView, h: { onTravel: (t: TravelMode) => void; onCentre: (centreId: string) => void; onStep: (i: number) => void }) {
      stopSpeaking();
      renderJourney($('route-body'), v, h);
      document.body.dataset.view = 'route';
    },
    selectStep(i: number | null) {
      for (const b of document.querySelectorAll<HTMLElement>('#route-body .j-turn')) b.classList.toggle('on', Number(b.dataset.step) === i);
    },
    hideRoute() {
      if (document.body.dataset.view === 'route') document.body.dataset.view = 'result';
    },
    /** The loop closed: an alert a duty officer approved for this place, shown above the model estimate. */
    setOfficial(a: OfficialAlertView | null) {
      const box = $('official');
      box.hidden = !a;
      residentAudio.set(a ? { id: a.id, languages: a.languages, status: a.status } : null);
      officialAudio.set(a?.languages.length ? { id: a.id, languages: a.languages } : null);
      if (!a) return;
      const when = a.approvedAt
        ? // Wall-clock time of the decision, as the control room shows it.
          new Date(a.approvedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
        : '';
      $('official-kicker').textContent = t('officialKicker', { when, by: a.approvedBy ?? 'the duty officer' });
      $('official-go').textContent = a.heading ?? t('officialGo', { centre: a.centre });
      $('official-msg').textContent = a.message;
      $('official-people').textContent = a.people > 0 ? t('officialPeople', { n: a.people.toLocaleString('en-GB') }) : '';
    },
    setWhatIf(active: boolean) {
      $('btn-whatif').textContent = active ? t('backNow') : t('whatIf');
    },
    setStreet(state: 'off' | 'loading' | 'on', stats?: { wet: number; total: number; osm: number; illustrative: number; buried?: number }) {
      const btn = $<HTMLButtonElement>('btn-street');
      btn.disabled = state === 'loading';
      btn.textContent = state === 'loading' ? t('loadingStreet') : state === 'on' ? t('backValley') : t('seeStreet');
      document.body.classList.toggle('street', state === 'on');
      if (stats) {
        const parts = [stats.wet ? t('homesWet', { n: stats.wet, total: stats.total }) : t('homesDry')];
        if (stats.buried) parts.unshift(t('homesBuried', { n: stats.buried }));
        $('street-stats').innerHTML = parts.map((p, i) => `<div class="${i === 0 && stats.buried ? 'buried' : ''}">${p}</div>`).join('');
        $('street-source').textContent = stats.osm ? t('housesSource', { osm: stats.osm }) : t('noBuildings');
      }
    },
    note(text: string) {
      note.textContent = text;
    },
    loading(frac: number) {
      $('loading-bar').style.width = `${Math.round(frac * 100)}%`;
    },
    ready() {
      document.body.classList.add('ready');
    },
    fail(msg: string) {
      $('loading-msg').textContent = msg;
      document.body.classList.add('failed');
    },
  };
}
