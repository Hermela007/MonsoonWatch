import { createSaintUi } from './saint';
import { createAreaWarningsUi } from './areaWarnings';
import type { ConnectionMode } from '../api/stream';
import type { AgentStep, Alert, AreaWarning, RiskEvent, SaintTask } from '@monsoonwatch/shared';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const CHECK_LABEL: Record<string, string> = {
  threshold: 'River level confirmed',
  route: 'Route is passable',
  capacity: 'Centre has room',
  freshness: 'Data is recent',
  language: 'Message is clear',
  vulnerable: 'Vulnerable people covered',
};
/** Control-room panels: the alert under review (with checks and approval) and the Tech HUD. */
export function createControlUi(h: {
  onReplay: () => void;
  onRun: () => void;
  onDecide: (id: string, d: 'approve' | 'reject') => void;
  onSelectAlert: (a: Alert) => void;
  onDecideArea: (id: string, d: 'approve' | 'reject') => void;
}) {
  const steps = new Map<string, HTMLElement>();
  const saint = createSaintUi($('saint-box'));
  const areas = createAreaWarningsUi($('area-warnings'), { onDecide: (id, d) => h.onDecideArea(id, d) });
  const list = $('hud-list');
  let t0 = 0;
  let current: Alert | null = null;
  const alerts = new Map<string, Alert>();
  let deciding = false;
  let connected = false;
  let readOnly = false;
  let runBusy = false;
  let replayBusy = false;
  // Which step of the flow we're on (1 replay → 2 agent → 3 approve → 4 after approval): drives the panel's
  // highlighting, so an operator always sees where things are and what comes next.
  let stage = 1;
  const setStage = (n: number) => {
    stage = Math.max(stage, n);
    $('control').dataset.stage = String(stage);
  };
  const updateActions = () => {
    $<HTMLButtonElement>('btn-run').disabled = !connected || readOnly || runBusy;
    $<HTMLButtonElement>('btn-replay').disabled = !connected || readOnly || replayBusy;
    areas.setEnabled(connected && !readOnly);
  };
  $('alert-picker').addEventListener('change', () => {
    current = alerts.get($<HTMLSelectElement>('alert-picker').value) ?? null;
    renderAlert();
    if (current) h.onSelectAlert(current);
  });

  $('btn-replay').addEventListener('click', h.onReplay);
  $('btn-run').addEventListener('click', h.onRun);
  $('btn-approve').addEventListener('click', () => current && h.onDecide(current._id, 'approve'));
  $('btn-reject').addEventListener('click', () => current && h.onDecide(current._id, 'reject'));

  const renderAlert = () => {
    const a = current;
    $('alert-box').hidden = !a;
    $('control-idle').hidden = !!a;
    if (!a) return;
    $('alert-box').dataset.alertId = a._id;
    const picker = $<HTMLSelectElement>('alert-picker');
    picker.innerHTML = [...alerts.values()].map((x) => `<option value="${esc(x._id)}">${esc(x.villageId)} · ${esc(x.status)} · ${x.people} people</option>`).join('');
    picker.value = a._id;
    $('alert-picker-row').hidden = alerts.size < 2;
    const checks = a.verification;
    const pending = ['threshold', 'route', 'capacity', 'freshness', 'language', 'vulnerable'].filter((c) => !checks.some((v) => v.check === c));
    $('alert-title').textContent = `${a.hazard === 'flood' ? 'Flood' : 'Landslide'} alert · ${a.villageId}`;
    // Who planned it: the deterministic rules planner or Gemini.
    if (a.plannedBy) {
      const badge = document.createElement('span');
      badge.className = `planned-by planned-${a.plannedBy}`;
      badge.textContent = a.plannedBy === 'gemini' ? 'Gemini' : 'Rules';
      badge.title = a.plannedBy === 'gemini' ? 'Planned by Gemini, checked by code' : 'Planned by the deterministic rules planner';
      $('alert-title').append(' ', badge);
    }
    $('alert-meta').textContent = [
      a.level.toUpperCase(),
      a.etaHours != null ? `water in ~${Math.round(a.etaHours)} h` : null,
      `${a.people.toLocaleString('en-GB')} people`,
      // Boat evacuations have no navigable-water path: name the pickup, draw no line.
      a.routeMode === 'boat' ? `boat pickup → ${a.evacCentreId}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    $('alert-msg').textContent = a.messages.map((m) => `[${m.lang}] ${m.text}`).join('\n\n');
    $('alert-pickups').textContent = a.pickups?.length
      ? 'Priority pickups: ' + [...a.pickups].sort((a, b) => a.order - b.order).map((p) => `${p.order}. ${p.people} ${p.category} by ${p.vehicle}`).join(' · ')
      : '';
    $('alert-checks').innerHTML =
      checks
        .map((c) => `<li class="${c.passed ? 'pass' : 'fail'}"><span class="mark">${c.passed ? '✓' : '✕'}</span><b>${esc(CHECK_LABEL[c.check] ?? c.check)}</b><small>${esc(c.detail)}</small></li>`)
        .join('') + pending.map((c) => `<li class="pending"><span class="mark">·</span><b>${CHECK_LABEL[c]}</b><small>Checking…</small></li>`).join('');
    const canDecide = connected && !readOnly && !deciding && a.status === 'verified' && checks.length > 0 && checks.every((c) => c.passed);
    $<HTMLButtonElement>('btn-approve').disabled = !canDecide;
    $<HTMLButtonElement>('btn-reject').disabled = !connected || readOnly || deciding || (a.status !== 'verified' && a.status !== 'draft');
    const status = $('alert-status');
    status.dataset.status = a.status;
    status.textContent =
      a.status === 'draft'
        ? 'Checking the draft…'
        : a.status === 'verified'
          ? 'All checks passed — needs a human decision. Nothing is sent until you approve.'
          : a.status === 'approved' || a.status === 'sent'
            ? `Approved by ${a.approvedBy ?? 'operator'}${a.approvedAt ? ' · ' + new Date(a.approvedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : ''}`
            : 'Rejected — nothing was sent.';
    $('decide-row').hidden = a.status === 'approved' || a.status === 'sent' || a.status === 'rejected';
  };

  return {
    setReadOnly(value: boolean) {
      readOnly = value;
      saint.setReadOnly(value);
      $('public-demo-note').hidden = !value;
      updateActions();
      renderAlert();
    },
    setMode(mode: ConnectionMode) {
      saint.setMode(mode);
      connected = mode === 'live' || mode === 'mock';
      updateActions();
      renderAlert();
      const chip = $('hud-mode');
      chip.textContent = mode === 'live' ? 'Live' : mode === 'mock' ? 'Scripted demo data' : mode === 'offline' ? 'API disconnected · retrying' : 'Connecting…';
      chip.dataset.mode = mode;
    },
    step(s: AgentStep) {
      if (s.actor !== 'MonsoonWatch') setStage(2);
      if (!t0) t0 = Date.parse(s.ts) || Date.now();
      let row = steps.get(s._id);
      if (!row) {
        row = document.createElement('li');
        steps.set(s._id, row);
        list.appendChild(row);
        requestAnimationFrame(() => row!.classList.add('in'));
      }
      const sec = Math.max(0, ((Date.parse(s.ts) || Date.now()) - t0) / 1000);
      row.className = `step ${s.status} kind-${s.kind} in`;
      row.innerHTML = `
        <span class="t">${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}</span>
        <span class="actor">${esc(s.actor)}</span>
        <span class="sum">${esc(s.summary)}</span>
        <span class="meta">${s.status === 'running' ? '<i class="spin"></i>' : s.latencyMs != null ? `${(s.latencyMs / 1000).toFixed(s.latencyMs < 1000 ? 2 : 1)} s` : ''}${s.tokens ? ` · ${s.tokens.toLocaleString('en-GB')} tok` : ''}</span>`;
      list.scrollTop = list.scrollHeight;
      $('hud-empty').hidden = true;
    },
    alert(a: Alert) {
      setStage(a.status === 'approved' || a.status === 'sent' ? 4 : 3);
      alerts.set(a._id, a);
      if (!current || current._id === a._id) current = a;
      renderAlert();
    },
    get currentAlert() { return current; },
    /** A district warning (B): villages without an individual plan, decided one by one. */
    areaWarning(w: AreaWarning) {
      setStage(w.status === 'approved' || w.status === 'sent' ? 4 : 3);
      areas.upsert(w);
    },
    getAreaWarning(id: string) { return areas.get(id); },
    setAreaBusy(id: string, on: boolean) { areas.setBusy(id, on); },
    setDeciding(value: boolean) { deciding = value; renderAlert(); },
    setRunBusy(value: boolean) { runBusy = value; updateActions(); },
    setReplay(running: boolean, text: string, busy = false) {
      replayBusy = busy;
      $('btn-replay').textContent = running ? 'Stop the replay' : 'Play the replay';
      $('replay-status').textContent = text;
      updateActions();
    },
    risk(e: RiskEvent) {
      setStage(2);
      $('control-risk').textContent = `Detected: ${e.message}`;
    },
    task(t: SaintTask) {
      setStage(4);
      saint.task(t);
    },
    evac(c: import('@monsoonwatch/shared').EvacCentre) { saint.evac(c); },
    note(text: string) {
      this.step({ _id: `note-${Date.now()}`, runId: '', ts: new Date().toISOString(), actor: 'MonsoonWatch', kind: 'info', summary: text, status: 'ok' });
    },
    reset() {
      alerts.clear();
      deciding = false;
      steps.clear();
      saint.reset();
      list.innerHTML = '';
      $('saint-list').innerHTML = '';
      $('saint-box').hidden = true;
      $('hud-empty').hidden = false;
      $('control-risk').textContent = '';
      areas.reset();
      t0 = 0;
      current = null;
      stage = 1;
      $('control').dataset.stage = '1';
      renderAlert();
    },
  };
}
