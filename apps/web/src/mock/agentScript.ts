import type { AgentStep, Alert, LngLat, RiskEvent, SaintTask, StreamEventName, StreamEvents, VerificationResult } from '@monsoonwatch/shared';

/**
 * Scripted agent run for when the API isn't running (or ?mock=1). Publishes the same typed events
 * the server would (agent.step, alert.updated, risk.event, saint.task), including one real-looking
 * verification failure → replan → pass. Clearly labelled MOCK in the UI. Numbers are illustrative.
 */
export function createMockAgent(emit: <K extends StreamEventName>(name: K, data: StreamEvents[K]) => void) {
  const timers: number[] = [];
  let seq = 0;
  let runId = '';
  let alert: Alert | null = null;

  const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));
  const step = (s: Omit<AgentStep, '_id' | 'runId' | 'ts'>) => {
    const full: AgentStep = { _id: `${runId}-${++seq}`, runId, ts: new Date().toISOString(), ...s };
    emit('agent.step', { step: full });
    return full;
  };
  /** A step that shows as running, then resolves. */
  const work = (t0: number, dur: number, s: Omit<AgentStep, '_id' | 'runId' | 'ts' | 'status'>, status: AgentStep['status'] = 'ok', then?: () => void) => {
    let id = '';
    at(t0, () => (id = step({ ...s, status: 'running' })._id));
    at(t0 + dur, () => {
      emit('agent.step', { step: { _id: id, runId, ts: new Date().toISOString(), ...s, status, latencyMs: s.latencyMs ?? dur } });
      then?.();
    });
    return t0 + dur;
  };
  const checks = (route: boolean): VerificationResult[] => [
    { check: 'threshold', passed: true, detail: 'River at Kuala Krai 2.1 m above Warning level (JPS)' },
    {
      check: 'route',
      passed: route,
      detail: route ? 'Route stays on roads predicted dry at ETA' : 'Route crosses a road predicted under 0.8 m of water at ETA',
    },
    { check: 'capacity', passed: true, detail: '1,240 people → centre with 1,500 places' },
    { check: 'freshness', passed: true, detail: 'Newest reading 6 min old' },
    { check: 'language', passed: true, detail: 'Illustrative English message, under 60 words' },
    { check: 'vulnerable', passed: true, detail: 'Scripted example only — no real pickup assessment' },
  ];

  return {
    get runId() {
      return runId;
    },
    start(opts: { regionId: string; village: { id: string; name: string }; route: LngLat[]; etaHours: number }) {
      timers.splice(0).forEach((t) => clearTimeout(t));
      runId = `mock-run-${Date.now().toString(36)}`;
      seq = 0;
      const risk: RiskEvent = {
        _id: `${runId}-risk`,
        regionId: opts.regionId,
        ts: new Date().toISOString(),
        type: 'river_threshold',
        level: 'warning',
        value: 2.1,
        threshold: 0,
        message: `${opts.village.name}: river above Warning level`,
        source: 'stream_processing',
      };
      let t = work(0, 700, { actor: 'MongoDB Stream Processing', kind: 'db', summary: `Tumbling 1 h window: ${opts.village.name} river crossed Warning → risk_event` }, 'ok', () =>
        emit('risk.event', { riskEvent: risk }),
      );
      t = work(t + 200, 2600, { actor: 'Gemini 4 Argon', kind: 'plan', summary: `Plan response for ${opts.village.name} (thinking: high)`, tokens: 3840 });
      t = work(t + 150, 400, { actor: 'MongoDB Atlas', kind: 'tool', summary: '$geoNear: 6 evacuation centres within 15 km' });
      t = work(t + 150, 900, { actor: 'MongoDB Hybrid Search + Voyage', kind: 'tool', summary: 'Retrieved Dec 2014 after-action notes on road closures (reranked)' });
      const sub = t + 200;
      work(sub, 1500, { actor: 'Gemini 3.8 Flash', kind: 'subagent', summary: 'Route subagent: evacuation route to nearest safe centre', tokens: 910 });
      work(sub + 120, 1300, { actor: 'Gemini 3.8 Flash', kind: 'subagent', summary: 'Capacity subagent: match 1,240 people to centre places', tokens: 640 });
      t = work(sub + 240, 1700, { actor: 'Gemini 3.8 Flash', kind: 'subagent', summary: 'Drafted resident alert (English)', tokens: 520 });
      at(t + 100, () => {
        alert = {
          _id: `${runId}-alert`,
          regionId: opts.regionId,
          runId,
          villageId: opts.village.id,
          level: 'warning',
          hazard: 'flood',
          etaHours: opts.etaHours,
          evacCentreId: 'mock-centre',
          people: 1240,
          route: { type: 'LineString', coordinates: opts.route },
          messages: [
            {
              lang: 'en',
              text: `Flood warning for ${opts.village.name}. River water may reach homes in about ${Math.round(opts.etaHours)} hours. Move to higher ground now using the marked route. Help elderly neighbours.`,
            },
          ],
          verification: [],
          status: 'draft',
        };
        emit('alert.updated', { alert });
      });
      // Verification: the route check fails first.
      const v0 = t + 300;
      const names: VerificationResult['check'][] = ['threshold', 'route', 'capacity', 'freshness', 'language'];
      names.forEach((name, i) => {
        const r = checks(false)[i];
        work(v0 + i * 220, 300, { actor: 'Verification', kind: 'verify', summary: `${name}: ${r.detail}` }, r.passed ? 'ok' : 'fail', () => {
          if (!alert) return;
          alert = { ...alert, verification: [...alert.verification.filter((c) => c.check !== name), r] };
          emit('alert.updated', { alert });
        });
      });
      t = v0 + names.length * 220 + 500;
      t = work(t, 2200, { actor: 'Gemini 4 Argon', kind: 'replan', summary: 'Replan: route check failed → avoid the flooded road segment', tokens: 1210 });
      t = work(t + 100, 1200, { actor: 'Gemini 3.8 Flash', kind: 'subagent', summary: 'Route subagent: detour via higher ground', tokens: 700 });
      t = work(t + 150, 350, { actor: 'Verification', kind: 'verify', summary: 'route: Route stays on roads predicted dry at ETA' }, 'ok', () => {
        if (!alert) return;
        alert = { ...alert, verification: checks(true), status: 'verified' };
        emit('alert.updated', { alert });
      });
      at(t + 300, () => step({ actor: 'MonsoonWatch', kind: 'info', summary: 'All checks passed. Waiting for a human to approve.', status: 'ok' }));
    },
    decide(decision: 'approve' | 'reject', by: string) {
      if (!alert) return;
      alert = { ...alert, status: decision === 'approve' ? 'approved' : 'rejected', approvedBy: by, approvedAt: new Date().toISOString() };
      emit('alert.updated', { alert });
      step({ actor: 'Human', kind: 'info', summary: `${by} ${decision === 'approve' ? 'approved' : 'rejected'} the alert`, status: decision === 'approve' ? 'ok' : 'fail' });
      if (decision !== 'approve') return;
      const task = (id: string, type: SaintTask['type'], detail: string, status: SaintTask['status']) =>
        emit('saint.task', { task: { _id: id, alertId: alert!._id, ts: new Date().toISOString(), type, status, detail } });
      let t = 300;
      const saint = (type: SaintTask['type'], running: string, done: string, dur: number, final: SaintTask['status'] = 'done') => {
        const id = `${runId}-saint-${type}`;
        at(t, () => {
          task(id, type, running, 'in_progress');
          step({ actor: 'Saint', kind: 'saint', summary: running, status: 'running' });
        });
        at(t + dur, () => {
          task(id, type, done, final);
          step({ actor: 'Saint', kind: 'saint', summary: done, status: 'ok', latencyMs: dur });
        });
        t += dur + 250;
      };
      saint('send_alert', 'Preparing the approved alert for one leader via WhatsApp', 'Scripted demo: one leader contacted via WhatsApp', 1600);
      saint('chase_reply', 'Waiting for the leader’s WhatsApp reply', 'Scripted demo: the leader replied on WhatsApp', 1800);
      saint('log_checkin', 'Logging arrivals at the evacuation centre', '140 people checked in so far', 1500);
      saint('supply_order', 'Drafting supply order: water, blankets', 'Supply order drafted — awaiting human approval; nothing ordered or paid', 1400, 'awaiting_approval');
    },
    stop() {
      timers.splice(0).forEach((t) => clearTimeout(t));
    },
  };
}
