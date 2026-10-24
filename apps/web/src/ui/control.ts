import type { AgentStep, Alert, RiskEvent, SaintTask } from '@monsoonwatch/shared';

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
const SAINT_LABEL: Record<SaintTask['type'], string> = {
  send_alert: 'Send alert',
  chase_reply: 'Confirm receipt',
  log_checkin: 'Centre check-ins',
  supply_order: 'Supplies',
  sitrep: 'Situation report',
};

/** Control-room panels: the alert under review (with checks and approval) and the Tech HUD. */
export function createControlUi(h: { onReplay: () => void; onRun: () => void; onDecide: (d: 'approve' | 'reject') => void }) {
  const steps = new Map<string, HTMLElement>();
  const tasks = new Map<string, HTMLElement>();
  const list = $('hud-list');
  let t0 = 0;
  let current: Alert | null = null;

  $('btn-replay').addEventListener('click', h.onReplay);
  $('btn-run').addEventListener('click', h.onRun);
  $('btn-approve').addEventListener('click', () => h.onDecide('approve'));
  $('btn-reject').addEventListener('click', () => h.onDecide('reject'));

  const renderAlert = () => {
    const a = current;
    $('alert-box').hidden = !a;
    $('control-idle').hidden = !!a;
    if (!a) return;
    $('alert-box').dataset.alertId = a._id;
    const checks = a.verification;
    const pending = ['threshold', 'route', 'capacity', 'freshness', 'language'].filter((c) => !checks.some((v) => v.check === c));
    $('alert-title').textContent = `${a.hazard === 'flood' ? 'Flood' : 'Landslide'} alert · ${a.villageId}`;
    $('alert-meta').textContent = [
      a.level.toUpperCase(),
      a.etaHours != null ? `water in ~${Math.round(a.etaHours)} h` : null,
      `${a.people.toLocaleString('en-GB')} people`,
    ]
      .filter(Boolean)
      .join(' · ');
    $('alert-msg').textContent = a.messages.find((m) => m.lang === 'en')?.text ?? a.messages[0]?.text ?? '';
    $('alert-checks').innerHTML =
      checks
        .map((c) => `<li class="${c.passed ? 'pass' : 'fail'}"><span class="mark">${c.passed ? '✓' : '✕'}</span><b>${esc(CHECK_LABEL[c.check] ?? c.check)}</b><small>${esc(c.detail)}</small></li>`)
        .join('') + pending.map((c) => `<li class="pending"><span class="mark">·</span><b>${CHECK_LABEL[c]}</b><small>Checking…</small></li>`).join('');
    const canDecide = a.status === 'verified';
    $<HTMLButtonElement>('btn-approve').disabled = !canDecide;
    $<HTMLButtonElement>('btn-reject').disabled = !canDecide && a.status !== 'draft';
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
    setMode(mode: 'live' | 'mock' | 'connecting') {
      const chip = $('hud-mode');
      chip.textContent = mode === 'live' ? 'Live' : mode === 'mock' ? 'Scripted demo data' : 'Connecting…';
      chip.dataset.mode = mode;
    },
    step(s: AgentStep) {
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
      current = a;
      renderAlert();
    },
    risk(e: RiskEvent) {
      $('control-risk').textContent = e.message;
    },
    task(t: SaintTask) {
      $('saint-box').hidden = false;
      let row = tasks.get(t._id);
      if (!row) {
        row = document.createElement('li');
        tasks.set(t._id, row);
        $('saint-list').appendChild(row);
      }
      row.className = `task ${t.status}`;
      row.innerHTML = `<b>${SAINT_LABEL[t.type]}</b><span>${esc(t.detail)}</span><em>${t.status.replace('_', ' ')}</em>`;
    },
    note(text: string) {
      this.step({ _id: `note-${Date.now()}`, runId: '', ts: new Date().toISOString(), actor: 'MonsoonWatch', kind: 'info', summary: text, status: 'ok' });
    },
    reset() {
      steps.clear();
      tasks.clear();
      list.innerHTML = '';
      $('saint-list').innerHTML = '';
      $('saint-box').hidden = true;
      $('hud-empty').hidden = false;
      $('control-risk').textContent = '';
      t0 = 0;
      current = null;
      renderAlert();
    },
  };
}
