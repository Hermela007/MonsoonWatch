import type { EvacuationRoute, EvacuationRouteFailure, TravelMode } from '@monsoonwatch/shared';

/** What the resident card shows for one evacuation-route response. Pure: easy to test against the fixtures. */
export interface JourneyView {
  ok: boolean;
  travel: TravelMode;
  /** "SK Manik Urai" — or the plain no-route sentence. */
  headline: string;
  /** "2.4 km · about 5 min by car" */
  meta: string | null;
  /** "assumed average 30 km/h by car" */
  basis: string | null;
  centre: { places: string; status: string | null; provenance: string | null } | null;
  hazard: { text: string; tone: 'checked' | 'partial' | 'unknown' | 'warning' };
  /** Extra hazard lines: flood crossings, landslide paths, closures, server notes. */
  hazardLines: string[];
  steps: { text: string; distance: string | null }[];
  alternatives: { centreId: string; name: string; text: string; canRoute: boolean }[];
  limitations: string[];
  sources: string[];
}

const TRAVEL_WORD: Record<TravelMode, string> = { car: 'by car', walk: 'on foot', boat: 'by boat' };

const REASON: Record<EvacuationRouteFailure, string> = {
  off_network: 'too far from a mapped road',
  no_routing_data: 'no road data here',
  disconnected: 'no road connection',
  all_routes_flooded: 'all routes flooded',
  no_centre_with_space: 'no space',
  centre_unavailable: 'unavailable',
  unsupported_mode: 'not supported',
};

// The contract's agreed wording (packages/shared/src/routing.ts). No status ever earns a "safe" badge.
const HAZARD_TEXT = {
  assessed: 'Checked against available hazard data',
  partial: 'Some sections lack hazard information',
  unknown: 'Hazard conditions unavailable — not checked for flooding or landslides',
} as const;

export const fmtDistanceM = (m: number) => (m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`);

export function fmtDuration(seconds: number) {
  const min = Math.max(1, Math.round(seconds / 60));
  if (min < 60) return `about ${min} min`;
  const h = Math.floor(min / 60);
  const rest = min - h * 60;
  return rest ? `about ${h} h ${rest} min` : `about ${h} h`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const placesText = (free: number, estimated: boolean) =>
  free <= 0 ? 'No free places reported' : `${plural(free, 'place', 'places')} free${estimated ? ' (capacity estimated)' : ''}`;

export function journeyView(r: EvacuationRoute): JourneyView {
  const ok = r.status === 'ok' && !!r.centre && !!r.geometry;
  const travel = r.query.travel;

  const metaParts: string[] = [];
  if (ok && r.distanceM !== null) metaParts.push(fmtDistanceM(r.distanceM));
  if (ok && r.durationSeconds !== null) metaParts.push(`${fmtDuration(r.durationSeconds)} ${TRAVEL_WORD[travel]}`);
  else if (ok) metaParts.push(TRAVEL_WORD[travel]);

  const centre = ok && r.centre
    ? {
        places: placesText(r.centre.freePlaces, r.centre.capacityEstimated),
        status: r.centre.status === 'at_risk' ? 'This centre may be at risk at this time' : r.centre.status === 'unknown' ? 'Conditions at this centre are unknown' : null,
        provenance: r.centre.source === 'osm-candidate' ? 'Candidate site from OpenStreetMap — not a confirmed relief centre' : null,
      }
    : null;

  const h = r.hazards;
  const hazardLines: string[] = [];
  if (ok) {
    if (h.crossesFlood === true) hazardLines.push('This route crosses a flooded road');
    if (h.floodedSegmentsAvoided) hazardLines.push(`Avoids ${plural(h.floodedSegmentsAvoided, 'flooded road section', 'flooded road sections')}${h.detourM ? ` (${fmtDistanceM(h.detourM)} longer)` : ''}`);
    if (h.landslideRunoutsCrossed) hazardLines.push(`Crosses ${plural(h.landslideRunoutsCrossed, 'possible landslide path', 'possible landslide paths')}`);
    if (!h.confirmedClosures.available) hazardLines.push('No official road-closure data');
  }
  hazardLines.push(...h.notes);

  return {
    ok,
    travel,
    headline: ok && r.centre ? r.centre.name : r.message,
    meta: metaParts.length ? metaParts.join(' · ') : null,
    basis: ok ? r.durationBasis : null,
    centre,
    hazard: {
      text: HAZARD_TEXT[h.status],
      tone: ok && h.crossesFlood === true ? 'warning' : h.status === 'assessed' ? 'checked' : h.status,
    },
    hazardLines: ok || h.notes.length ? hazardLines : [],
    steps: ok ? r.steps.map((s) => ({ text: s.instruction, distance: s.distanceM > 0 ? fmtDistanceM(s.distanceM) : null })) : [],
    // The nearest few are enough to choose from on a phone.
    alternatives: r.alternatives.slice(0, 4).map((a) => ({
      centreId: a.centreId,
      name: a.name,
      canRoute: a.status === 'ok',
      text: a.status === 'ok'
        ? [a.distanceM !== null ? fmtDistanceM(a.distanceM) : null, `${a.freePlaces.toLocaleString('en-GB')} places`].filter(Boolean).join(' · ')
        : REASON[a.reason ?? 'disconnected'],
    })),
    limitations: r.limitations,
    sources: r.sources,
  };
}

/** One line on the resident card: where to go and how long, or why there's no route. */
export function renderJourneySummary(el: HTMLElement, v: JourneyView) {
  el.replaceChildren();
  el.className = `journey-summary ${v.ok ? 'ok' : 'none'}`;
  const k = document.createElement('div');
  k.className = 'js-kicker';
  k.textContent = v.ok ? 'Evacuation route' : 'No evacuation route';
  const head = document.createElement('div');
  head.className = 'js-head';
  head.textContent = v.headline;
  el.append(k, head);
  if (v.ok && v.meta) {
    const m = document.createElement('div');
    m.className = 'js-meta';
    m.textContent = v.meta;
    el.append(m);
  }
}

/** The route screen's panel. Handlers re-request with another travel mode or centre, or select a turn. */
export function renderJourney(
  el: HTMLElement,
  v: JourneyView,
  h: { onTravel: (t: TravelMode) => void; onCentre: (centreId: string) => void; onStep?: (i: number) => void },
) {
  el.replaceChildren();
  el.className = `journey ${v.ok ? 'ok' : 'none'}`;
  const add = <K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, cls?: string, text?: string) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    parent.append(e);
    return e;
  };

  const modes = add(el, 'div', 'travel-modes');
  modes.setAttribute('role', 'group');
  modes.setAttribute('aria-label', 'How you will travel');
  // No Boat option: there is no navigable-water data, so the routing service never has a boat route
  // (rescue boats are coordinated by officials — boat alerts show "boat pickup → centre" in the console).
  for (const [t, label] of [['car', 'Car'], ['walk', 'Walk']] as const) {
    const b = add(modes, 'button', t === v.travel ? 'on' : '', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(t === v.travel));
    b.addEventListener('click', () => t !== v.travel && h.onTravel(t));
  }

  add(el, 'div', 'j-headline', v.headline);
  if (v.meta) add(el, 'div', 'j-meta', v.meta);
  if (v.centre) {
    add(el, 'div', 'j-places', v.centre.places);
    if (v.centre.status) add(el, 'div', 'j-warn', v.centre.status);
  }

  const hz = add(el, 'div', `j-hazard ${v.hazard.tone}`);
  add(hz, 'div', 'j-hazard-head', v.hazard.text);
  for (const line of v.hazardLines) add(hz, 'div', 'j-hazard-line', line);

  if (v.steps.length) {
    add(el, 'div', 'j-checkpoint-head', 'Route checkpoints');
    add(el, 'p', 'j-checkpoint-help', 'Select a step to highlight it on the map.');
    const ol = add(el, 'ol', 'j-turns');
    v.steps.forEach((s, i) => {
      const li = add(ol, 'li');
      const b = add(li, 'button', 'j-turn');
      b.type = 'button';
      b.dataset.step = String(i);
      add(b, 'span', 'j-turn-n', String(i + 1));
      const txt = add(b, 'span', 'j-turn-text', s.text);
      if (s.distance) add(txt, 'small', undefined, s.distance);
      b.addEventListener('click', () => h.onStep?.(i));
    });
  }

  if (v.alternatives.length) {
    add(el, 'div', 'j-alt-head', v.ok ? 'Other centres' : 'Centres nearby');
    const ul = add(el, 'ul', 'j-alts');
    for (const a of v.alternatives) {
      const li = add(ul, 'li');
      if (a.canRoute) {
        const b = add(li, 'button', 'link', a.name);
        b.type = 'button';
        b.addEventListener('click', () => h.onCentre(a.centreId));
      } else add(li, 'span', 'j-alt-name', a.name);
      add(li, 'small', a.canRoute ? '' : 'muted', a.text);
    }
  }

  if (v.limitations.length || v.sources.length || v.centre?.provenance || v.basis) {
    const d = add(el, 'details', 'j-about');
    add(d, 'summary', undefined, 'About this route');
    if (v.basis) add(d, 'p', undefined, `Travel time ${v.basis}.`);
    if (v.centre?.provenance) add(d, 'p', undefined, v.centre.provenance);
    for (const l of v.limitations) add(d, 'p', undefined, l);
    if (v.sources.length) add(d, 'p', 'j-sources', `Sources: ${v.sources.join(' · ')}`);
  }
}
