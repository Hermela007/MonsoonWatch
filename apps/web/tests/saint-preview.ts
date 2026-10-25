import { createSaintUi } from '../src/ui/saint';
import type { SaintTask } from '@monsoonwatch/shared';
const root = document.querySelector<HTMLElement>('#saint-box')!;
const panel = createSaintUi(root);
const task: SaintTask = { _id: 'test-task', alertId: 'test-alert', ts: new Date().toISOString(), type: 'send_alert', status: 'queued', detail: 'Approved alert for one leader via WhatsApp' };
let link: string | null = null;
let marked = 0;
let opened = '';
let fail = false;
let refuse = false;
window.open = (() => ({ opener: null, closed: false, close() {}, location: { set href(value: string) { opened = value; } } })) as typeof window.open;
window.fetch = async (input, init) => {
  if (String(input).endsWith('/handoff') && refuse) return Response.json({ error: { message: 'Approved alert needs Malay and English text.' } }, { status: 409 });
  if (String(input).endsWith('/handoff')) return Response.json({ taskId: task._id, alertId: task.alertId, brief: 'APPROVED ALERT: test only', whatsappUrl: link });
  if (String(input).endsWith('/handed-off')) { marked++; return Response.json({ ...task, status: 'in_progress' }); }
  if (String(input).endsWith('/updates')) {
    if (fail) return Response.json({ error: { message: 'No MW CHECKIN line found' } }, { status: 400 });
    if (JSON.parse(String(init?.body)).by !== 'Test officer') throw new Error('Officer missing');
    return Response.json({ applied: [{ people: null, centre: 'SK Dabong', status: 'acknowledged' }], skipped: [{ line: 'duplicate', reason: 'already applied' }], errors: [{ line: 'bad', reason: 'unknown centre' }] });
  }
  throw new Error(`Unexpected request ${input}`);
};
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); document.querySelector('#checks')!.textContent += `PASS: ${message}\n`; };
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const click = (text: string) => { const b = [...root.querySelectorAll('button')].find((el) => el.textContent === text); if (!b) throw new Error(`Button missing: ${text}`); b.click(); };
panel.setMode('live'); panel.task(task);
document.querySelector('#run')!.addEventListener('click', () => {
  void (async () => {
    document.querySelector('#checks')!.textContent = '';
    panel.reset(); panel.setMode('live'); panel.setReadOnly(false); panel.task(task);
    click('Send to Saint'); await settle();
    check(root.querySelector<HTMLTextAreaElement>('.saint-brief')?.value.includes('APPROVED ALERT'), 'Null URL displays the copyable brief');
    check(marked === 0, 'Manual fallback does not mark an unsent brief handed off');
    click('I sent the brief on WhatsApp'); await settle();
    check(marked === 1 && root.textContent?.includes('Waiting for the village head’s check-in · sent'), 'Manual confirmation records handoff');
    panel.task(task); refuse = true; opened = '';
    click('Send to Saint'); await settle();
    check(root.querySelector('.task .note')?.textContent?.includes('Approved alert needs Malay and English text.') && opened === '' && marked === 1, '409 stays on the task card and never navigates to WhatsApp');
    refuse = false;
    panel.task(task); link = 'https://wa.me/' + '0'.repeat(10) + '?text=test';
    click('Send to Saint'); await settle();
    check(opened === link && marked === 2, 'WhatsApp link opens before handoff is recorded');
    const report = root.querySelector<HTMLTextAreaElement>('#saint-report')!;
    report.value = 'MW CHECKIN alert=test-alert centre=SK Dabong people= status=acknowledged'; report.dispatchEvent(new Event('input'));
    click('Apply report'); await settle();
    check(root.textContent?.includes('Acknowledged → SK Dabong') && !root.textContent?.includes('null people'), 'Empty acknowledgement shows a centre without a headcount');
    check(root.textContent?.includes('Applied: 1 · Skipped: 1 · Errors: 1'), 'All report result groups are visible');
    fail = true; click('Apply report'); await settle();
    check(root.textContent?.includes('Report not applied: No MW CHECKIN'), 'Backend errors remain visible and pasted text is retained');
    panel.evac({ _id: 'centre', regionId: 'kelantan', name: 'SK Dabong', headcount: 30, capacity: 100, elevationM: 20, location: { type: 'Point', coordinates: [102, 5] } });
    check(root.textContent?.includes('30 / 100'), 'Live centre update displays capacity');
    panel.task(task); panel.setReadOnly(true);
    check([...root.querySelectorAll('button')].filter((b) => ['Send to Saint', 'Apply report'].includes(b.textContent ?? '')).every((b) => b.disabled), 'Public demo blocks handoff and report mutations');
    panel.setReadOnly(false);
    panel.task({ ...task, _id: 'supplies', type: 'supply_order', status: 'awaiting_approval', detail: 'Supply order draft awaiting approval — nothing placed' });
    check(!root.querySelector('.task.awaiting_approval button'), 'Supply drafts have no order-placement action');
  })().catch((err) => { document.querySelector('#checks')!.textContent += `FAIL: ${err.message}`; });
});
