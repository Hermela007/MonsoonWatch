import type { EvacCentre, SaintTask } from '@monsoonwatch/shared';
import type { ConnectionMode } from '../api/stream';
import { fetchSaintHandoff, markSaintHandedOff, submitSaintReport, type SaintHandoff } from '../api/client';

const LABEL: Record<SaintTask['type'], string> = {
  send_alert: 'Send alert', chase_reply: 'Confirm receipt', log_checkin: 'Centre check-ins',
  supply_order: 'Supply draft', sitrep: 'Situation report',
};

/** Human handoff to Thea over WhatsApp; a queued task never means a delivered alert. */
export function createSaintUi(root: HTMLElement) {
  const list = root.querySelector<HTMLElement>('#saint-list')!;
  const report = root.querySelector<HTMLTextAreaElement>('#saint-report')!;
  const officer = root.querySelector<HTMLInputElement>('#saint-by')!;
  const submit = root.querySelector<HTMLButtonElement>('#saint-submit')!;
  const result = root.querySelector<HTMLElement>('#saint-result')!;
  const capacity = root.querySelector<HTMLElement>('#saint-capacity')!;
  const tasks = new Map<string, SaintTask>();
  const rows = new Map<string, HTMLElement>();
  const handoffs = new Map<string, SaintHandoff>();
  const busy = new Set<string>();
  let mode: ConnectionMode = 'connecting';
  let readOnly = false;
  let reporting = false;
  const writable = () => mode === 'live' && !readOnly;
  const errorMessage = (err: unknown) => err instanceof Error ? err.message : String(err);
  const by = () => {
    const value = officer.value.trim();
    if (!value) throw new Error('Enter the duty officer’s name.');
    return value;
  };
  const button = (label: string, action: () => void, disabled = false) => {
    const el = document.createElement('button');
    el.type = 'button'; el.className = 'btn'; el.textContent = label; el.disabled = disabled;
    el.addEventListener('click', action);
    return el;
  };
  const renderTask = (task: SaintTask) => {
    let row = rows.get(task._id);
    if (!row) { row = document.createElement('li'); rows.set(task._id, row); list.append(row); }
    row.className = `task ${task.status}`;
    row.replaceChildren();
    for (const [tag, text] of [['b', LABEL[task.type]], ['span', task.detail], ['em', task.status.replaceAll('_', ' ')]]) {
      const el = document.createElement(tag); el.textContent = text; row.append(el);
    }
    if (task.type !== 'send_alert' || task.status !== 'queued') return;
    const actions = document.createElement('div'); actions.className = 'saint-actions';
    const note = document.createElement('p'); note.className = 'note'; note.setAttribute('role', 'status');
    const handedOff = async () => {
      if (!writable() || busy.has(task._id)) return;
      try {
        const who = by(); busy.add(task._id); renderAll();
        const updated = await markSaintHandedOff(task._id, who);
        tasks.set(updated._id, updated);
      } catch (err) { result.textContent = `Handoff not recorded: ${errorMessage(err)}`; }
      finally { busy.delete(task._id); renderAll(); }
    };
    actions.append(button(busy.has(task._id) ? 'Preparing…' : 'Send to Saint', () => {
      if (!writable() || busy.has(task._id)) return;
      let who: string;
      try { who = by(); } catch (err) { note.textContent = errorMessage(err); return; }
      // Reserve the tab during the click so asynchronous GETs do not trigger popup blocking.
      const popup = window.open('about:blank', '_blank');
      if (popup) popup.opener = null;
      busy.add(task._id); renderAll();
      let navigated = false;
      void (async () => {
        try {
          const handoff = await fetchSaintHandoff(task._id);
          handoffs.set(task._id, handoff);
          if (!handoff.whatsappUrl) { popup?.close(); return; }
          const url = new URL(handoff.whatsappUrl);
          if (url.protocol !== 'https:' || url.hostname !== 'wa.me') throw new Error('Unexpected WhatsApp handoff URL. Copy the brief instead.');
          if (!popup || popup.closed) throw new Error('The new tab was blocked. Allow popups or copy the brief below.');
          popup.location.href = url.href;
          navigated = true;
          result.textContent = 'WhatsApp opened. Send the prefilled brief to Thea there; delivery is not confirmed here.';
          const updated = await markSaintHandedOff(task._id, who);
          tasks.set(updated._id, updated);
        } catch (err) {
          if (popup && !navigated) popup.close();
          result.textContent = `Handoff: ${errorMessage(err)}`;
        } finally { busy.delete(task._id); renderAll(); }
      })();
    }, !writable() || busy.has(task._id)));
    const handoff = handoffs.get(task._id);
    if (handoff) {
      const brief = document.createElement('textarea'); brief.readOnly = true; brief.rows = 7;
      brief.className = 'saint-brief'; brief.value = handoff.brief; brief.setAttribute('aria-label', 'Saint handoff brief');
      actions.append(brief);
      actions.append(button('Copy brief', () => {
        void (navigator.clipboard ? navigator.clipboard.writeText(handoff.brief) : Promise.reject(new Error('Clipboard unavailable'))).then(() => { note.textContent = 'Brief copied. Paste and send it to Thea on WhatsApp.'; })
          .catch(() => { brief.focus(); brief.select(); note.textContent = 'Select and copy the brief manually.'; });
      }));
      actions.append(button('I sent the brief on WhatsApp', () => void handedOff(), !writable() || busy.has(task._id)));
      if (!handoff.whatsappUrl) note.textContent = 'WhatsApp link unavailable. Copy the brief and send it to Thea manually.';
    }
    actions.append(note); row.append(actions);
  };
  const renderAll = () => {
    tasks.forEach(renderTask);
    submit.disabled = !writable() || reporting || !report.value.trim();
    report.disabled = !writable();
    officer.disabled = !writable();
  };
  report.addEventListener('input', () => { submit.disabled = !writable() || reporting || !report.value.trim(); });
  submit.addEventListener('click', () => {
    if (!writable() || reporting) return;
    let who: string;
    try { who = by(); } catch (err) { result.textContent = errorMessage(err); return; }
    const text = report.value;
    if (!text.trim()) return;
    reporting = true; result.textContent = 'Applying Saint’s report…'; renderAll();
    void submitSaintReport(text, who).then((response) => {
      result.replaceChildren();
      const summary = document.createElement('p');
      summary.textContent = `Applied: ${response.applied.length} · Skipped: ${response.skipped.length} · Errors: ${response.errors.length}`;
      result.append(summary);
      for (const item of response.applied) {
        const p = document.createElement('p'); p.textContent = item.people === null ? `Applied: acknowledged → ${item.centre}` : `Applied: ${item.people} people ${item.status} → ${item.centre}`; result.append(p);
      }
      for (const [label, entries] of [['Skipped', response.skipped], ['Error', response.errors]] as const) {
        for (const item of entries) { const p = document.createElement('p'); p.textContent = `${label}: ${item.reason} — ${item.line}`; result.append(p); }
      }
    }).catch((err) => { result.textContent = `Report not applied: ${errorMessage(err)}`; })
      .finally(() => { reporting = false; renderAll(); });
  });
  renderAll();
  return {
    setMode(value: ConnectionMode) { mode = value; if (value === 'live') root.hidden = false; renderAll(); },
    setReadOnly(value: boolean) { readOnly = value; renderAll(); },
    task(task: SaintTask) { root.hidden = false; tasks.set(task._id, task); renderTask(task); },
    evac(centre: EvacCentre) {
      root.hidden = false;
      capacity.textContent = `${centre.name}: ${centre.headcount.toLocaleString()} / ${centre.capacity.toLocaleString()} places occupied`;
    },
    reset() { tasks.clear(); rows.clear(); handoffs.clear(); list.replaceChildren(); result.replaceChildren(); report.value = ''; capacity.textContent = ''; root.hidden = true; },
  };
}
