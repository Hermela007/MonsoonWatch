import type { AreaWarning, VulnerableCategory } from '@monsoonwatch/shared';

const LEVEL: Record<AreaWarning['level'], string> = { alert: 'ALERT', warning: 'WARNING', danger: 'DANGER' };
const CATEGORY: Record<VulnerableCategory, [string, string]> = {
  bedridden: ['bedridden', 'bedridden'],
  disabled: ['disabled', 'disabled'],
  elderly: ['elderly', 'elderly'],
  noTransport: ['without transport', 'without transport'],
};
const n = (x: number) => x.toLocaleString('en-GB');

/** What a district-warning card shows. Pure: tested against the shared fixtures. */
export interface AreaWarningView {
  id: string;
  title: string; // "Flood · Kuala Krai district"
  level: string; // "DANGER"
  kind: 'evacuate' | 'advisory';
  kindLabel: string; // "Evacuate" | "Advisory · be ready"
  stats: string; // "2 villages · 2,000 people"
  vulnerable: string | null; // "250 vulnerable: 5 bedridden · 20 disabled · 160 elderly · 65 without transport"
  pickups: string | null; // evacuate only
  basis: string;
  evidence: string[];
  message: string | null; // English text if present
  status: string;
  decided: boolean;
  label: string;
}

export function areaWarningView(a: AreaWarning): AreaWarningView {
  const cats = (Object.keys(CATEGORY) as VulnerableCategory[])
    .filter((c) => (a.vulnerableByCategory?.[c] ?? 0) > 0)
    .map((c) => `${n(a.vulnerableByCategory[c])} ${CATEGORY[c][0]}`);
  const decided = a.status !== 'needs_approval';
  const when = a.approvedAt ? ` · ${new Date(a.approvedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : '';
  return {
    id: a._id,
    title: `${a.hazard === 'flood' ? 'Flood' : 'Landslide'} · ${a.district} district`,
    level: LEVEL[a.level] ?? a.level.toUpperCase(),
    kind: a.kind,
    kindLabel: a.kind === 'evacuate' ? 'Evacuate' : 'Advisory · be ready',
    stats: `${n(a.villageIds.length)} ${a.villageIds.length === 1 ? 'village' : 'villages'} · ${n(a.people)} people`,
    vulnerable: a.vulnerable > 0 ? `${n(a.vulnerable)} vulnerable${cats.length ? `: ${cats.join(' · ')}` : ''}` : null,
    pickups: a.kind === 'evacuate' ? 'Pickups not planned — officials arrange transport.' : null,
    basis: a.basis,
    evidence: a.evidence,
    message: (a.messages.find((m) => m.lang.startsWith('en')) ?? a.messages[0])?.text ?? null,
    status:
      a.status === 'needs_approval'
        ? 'Needs your decision. Nothing is sent until you approve.'
        : a.status === 'rejected'
          ? 'Rejected — nothing was sent.'
          : `Approved by ${a.approvedBy ?? 'operator'}${when}`,
    decided,
    label: a.label,
  };
}

/**
 * District warnings in the control room: one card per warning, each approved or rejected on its own.
 * Deliberately no "approve all" — every approval makes two spoken-version (TTS) calls.
 */
export function createAreaWarningsUi(root: HTMLElement, h: { onDecide: (id: string, d: 'approve' | 'reject') => void }) {
  const items = new Map<string, AreaWarning>();
  const busy = new Set<string>();
  let enabled = false;
  let scripted = false;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  const render = () => {
    root.hidden = items.size === 0;
    root.replaceChildren();
    if (!items.size) return;
    const list = [...items.values()].sort((a, b) => (a.kind === b.kind ? b.people - a.people : a.kind === 'evacuate' ? -1 : 1));
    const pending = list.filter((a) => a.status === 'needs_approval').length;
    const head = el('div', 'aw-head');
    head.append(el('h3', undefined, 'District warnings'), el('span', 'aw-count', pending ? `${pending} need a decision` : 'all decided'));
    root.append(head, el('p', 'aw-intro', 'For villages without an individual plan. Approve each one separately.'));
    for (const a of list) {
      const v = areaWarningView(a);
      const card = el('article', `aw-card aw-${v.kind} aw-${a.status}`);
      const top = el('div', 'aw-top');
      top.append(el('span', `aw-level aw-level-${a.level}`, v.level), el('span', 'aw-kind', v.kindLabel));
      card.append(top, el('div', 'aw-title', v.title), el('div', 'aw-stats', v.stats));
      if (v.vulnerable) card.append(el('div', 'aw-vuln', v.vulnerable));
      if (v.pickups) card.append(el('div', 'aw-pickups', v.pickups));
      const more = el('details', 'aw-more');
      more.append(el('summary', undefined, 'Why, evidence and message'));
      more.append(el('p', undefined, v.basis));
      for (const ev of v.evidence) more.append(el('p', 'aw-evidence', ev));
      if (v.message) more.append(el('blockquote', undefined, v.message));
      more.append(el('p', 'aw-label', v.label));
      card.append(more);
      card.append(el('p', 'aw-status', v.status));
      if (!v.decided) {
        const row = el('div', 'actions two');
        const ok = el('button', 'btn btn-primary', busy.has(a._id) ? 'Sending…' : 'Approve and send');
        const no = el('button', 'btn', 'Reject');
        for (const b of [ok, no]) {
          b.type = 'button';
          b.disabled = !enabled || busy.has(a._id);
        }
        ok.addEventListener('click', () => h.onDecide(a._id, 'approve'));
        no.addEventListener('click', () => h.onDecide(a._id, 'reject'));
        row.append(ok, no);
        card.append(row);
      } else if (!scripted && (a.status === 'approved' || a.status === 'sent')) {
        // Spoken versions use the alert audio URL (B): one player per language.
        const audio = el('div', 'aw-audio');
        for (const m of a.messages) {
          const lab = el('label', undefined, m.lang.toUpperCase());
          const player = el('audio');
          player.controls = true;
          player.preload = 'none';
          player.src = `/api/alerts/${encodeURIComponent(a._id)}/audio/${encodeURIComponent(m.lang)}`;
          lab.append(player);
          audio.append(lab);
        }
        card.append(audio);
      }
      root.append(card);
    }
  };

  return {
    upsert(a: AreaWarning) {
      items.set(a._id, a);
      render();
    },
    get(id: string) {
      return items.get(id) ?? null;
    },
    setBusy(id: string, on: boolean) {
      if (on) busy.add(id);
      else busy.delete(id);
      render();
    },
    setEnabled(on: boolean, isScripted: boolean) {
      enabled = on;
      scripted = isScripted;
      render();
    },
    reset() {
      items.clear();
      busy.clear();
      render();
    },
    get size() {
      return items.size;
    },
  };
}
