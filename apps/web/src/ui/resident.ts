import type { Town } from '../geo/region';
import { searchPlaces } from '../api/client';
import type { HomeRisk } from '../terrain/homeRisk';
import type { SafeRoute } from '../terrain/route';
import { peakHour, replayDate } from '../data/replay2014';
import { matchPlaces } from './places';
import { t } from './copy';

export interface ResultView {
  place: string;
  risk: HomeRisk;
  nowHour: number;
  route: SafeRoute | null;
  /** Flagged slopes in the hills upstream of the home (valley-wide screening). */
  upstreamSlopes: number;
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
  if (v.upstreamSlopes > 0) slide.push(t('slideUpstream', { n: v.upstreamSlopes }));

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
    hazards: [
      { key: 'flood', name: t('hazardFlood'), level: risk.floodLevel, levelText: levelText(risk.floodLevel), lines: flood },
      { key: 'slide', name: t('hazardSlide'), level: risk.slideLevel, levelText: levelText(risk.slideLevel), lines: slide },
    ],
    lines: [...flood, ...slide],
    action,
    canRoute: !!route && route.cells.length > 1,
  };
}

export function createResidentUi(
  initialPlaces: Town[],
  h: {
    onPick: (town: Town) => void;
    onLocate: () => void;
    onShowWay: () => void;
    onWhatIf: () => void;
    onChange: () => void;
    onStreet: () => void;
  },
) {
  const input = $<HTMLInputElement>('place-input');
  const suggestions = $('suggestions');
  const note = $('landing-note');
  const listen = $<HTMLButtonElement>('btn-listen');
  let current: ReturnType<typeof describe> | null = null;
  let speaking = false;
  let places = initialPlaces;
  let remote: Town[] = [];
  let searchTimer = 0;

  const renderSuggestions = () => {
    const q = input.value.trim();
    const local = q ? matchPlaces(q, places) : places.slice(0, 5);
    const seen = new Set(local.map((p) => p.name.toLowerCase()));
    const matches = [...local, ...remote.filter((p) => !seen.has(p.name.toLowerCase()))].slice(0, 10);
    suggestions.innerHTML = '';
    for (const town of matches) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'suggestion';
      b.textContent = town.name;
      if (town.note) {
        const n = document.createElement('small');
        n.textContent = town.note;
        b.appendChild(n);
      }
      b.addEventListener('click', () => h.onPick(town));
      suggestions.appendChild(b);
    }
    note.textContent = q && !matches.length ? t('noMatch') : '';
  };
  input.addEventListener('input', () => {
    remote = [];
    renderSuggestions();
    // Atlas Search (via the API) adds villages we don't have locally; silently skipped if the API is down.
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (q.length < 2) return;
    searchTimer = window.setTimeout(async () => {
      const hits = await searchPlaces(q);
      if (input.value.trim() === q && hits.length) {
        remote = hits;
        renderSuggestions();
      }
    }, 200);
  });
  $('place-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const first = matchPlaces(input.value, places)[0] ?? remote[0];
    if (first) h.onPick(first);
    else note.textContent = t('noMatch');
  });
  $('btn-locate').addEventListener('click', h.onLocate);
  $('btn-way').addEventListener('click', h.onShowWay);
  $('btn-whatif').addEventListener('click', h.onWhatIf);
  $('btn-change').addEventListener('click', h.onChange);
  $('btn-street').addEventListener('click', h.onStreet);

  const stopSpeaking = () => {
    window.speechSynthesis?.cancel();
    speaking = false;
    listen.textContent = `🔊 ${t('listen')}`;
  };
  // Browser speech for now; Workstream B's /voice (Gemini TTS) replaces this.
  listen.addEventListener('click', () => {
    if (!current || !('speechSynthesis' in window)) return;
    if (speaking) return stopSpeaking();
    const u = new SpeechSynthesisUtterance([current.level, ...current.lines, current.action].join('. '));
    u.lang = 'en-GB';
    u.onend = stopSpeaking;
    speaking = true;
    listen.textContent = `■ ${t('stop')}`;
    window.speechSynthesis.speak(u);
  });

  // Static copy.
  for (const el of document.querySelectorAll<HTMLElement>('[data-copy]')) el.textContent = t(el.dataset.copy as never);
  input.placeholder = t('placeholder');
  listen.textContent = `🔊 ${t('listen')}`;
  renderSuggestions();

  return {
    setPlaces(list: Town[]) {
      const seen = new Set<string>();
      places = list.filter((p) => !seen.has(p.name) && seen.add(p.name));
      renderSuggestions();
    },
    showLanding() {
      stopSpeaking();
      document.body.dataset.view = 'landing';
      input.value = '';
      note.textContent = '';
      renderSuggestions();
    },
    showResult(v: ResultView) {
      stopSpeaking();
      current = describe(v);
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
