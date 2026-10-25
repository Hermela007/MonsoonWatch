import '../src/styles.css';
import { createControlUi } from '../src/ui/control';
import approvedWarning from '../../../packages/shared/fixtures/area-warning.evacuate.json';
import type { AreaWarning } from '@monsoonwatch/shared';
import type { Alert } from '@monsoonwatch/shared';
// Real control markup with simulated alerts only. No replay, model calls or messages.
const page = new DOMParser().parseFromString(await (await fetch('/index.html')).text(), 'text/html');
page.querySelectorAll('script').forEach(script => script.remove());
document.body.replaceChildren(...Array.from(page.body.childNodes));
document.body.classList.add('ready'); document.body.dataset.mode = 'control'; document.body.dataset.view = 'control';
const noop = () => {};
const ui = createControlUi({ onReplay: noop, onRun: noop, onDecide: noop, onSelectAlert: noop, onDecideArea: noop });
ui.setMode('live');
const samples: Alert[] = [];
for (const [i, villageId] of ['osm-node-13606016600', 'osm-node-13606016601-long-village-identifier-with-no-spaces'].entries()) {
  const alert: Alert = { _id: `layout-${i}`, runId: 'layout', regionId: 'kelantan', villageId, evacCentreId: 'test-centre', status: 'verified', hazard: 'flood', level: 'warning', people: 150, route: { type: 'LineString', coordinates: [] }, messages: [{ lang: 'en', text: 'TEST ONLY: move to the approved centre using the confirmed route. ' + 'A'.repeat(150) }], verification: ['threshold','route','capacity','freshness','language','vulnerable'].map(check => ({ check: check as Alert['verification'][number]['check'], passed: true, detail: 'Checked against the scenario: ' + 'x'.repeat(100) })) };
  samples.push(alert);
  ui.alert(alert);
}
const run = document.createElement('button'); run.type = 'button'; run.className = 'btn'; run.textContent = 'Check control layout';
const report = document.createElement('pre'); report.id = 'layout-report'; report.style.cssText = 'padding:16px;white-space:pre-wrap'; report.setAttribute('role','status');
document.getElementById('hud')!.append(run, report);
run.addEventListener('click', () => {
  const panel = document.getElementById('control')!, picker = document.getElementById('alert-picker')!;
  picker.focus(); picker.scrollIntoView({ block: 'nearest' });
  requestAnimationFrame(() => {
    const bounds = panel.getBoundingClientRect();
    const overflowing = [...panel.querySelectorAll<HTMLElement>('.ctl-step, .btn, select, .checks')].filter(el => el.getClientRects().length && (el.getBoundingClientRect().left < bounds.left || el.getBoundingClientRect().right > bounds.right));
    const ok = panel.scrollWidth <= panel.clientWidth + 1 && panel.scrollLeft === 0 && overflowing.length === 0;
    report.textContent = `${ok ? 'PASS' : 'FAIL'}: ${innerWidth}px viewport; panel ${panel.clientWidth}px; content ${panel.scrollWidth}px; horizontal scroll ${panel.scrollLeft}px; overflowing controls ${overflowing.length}.`;
  });
});

const approved = document.createElement('button'); approved.type = 'button'; approved.className = 'btn'; approved.textContent = 'Check resident-only audio';
document.getElementById('hud')!.append(approved);
approved.addEventListener('click', () => {
  ui.alert({ ...samples[0], status: 'approved', approvedBy: 'Test officer' });
  ui.areaWarning({ ...approvedWarning, status: 'approved', approvedBy: 'Test officer' } as AreaWarning);
  const count = document.querySelectorAll('#control audio').length;
  report.textContent = `${count === 0 ? 'PASS' : 'FAIL'}: ${count} control-room audio players after individual and district approval. Spoken warnings belong on the resident page.`;
});
