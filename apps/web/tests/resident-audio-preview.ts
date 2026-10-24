import '../src/styles.css';
import { createResidentUi } from '../src/ui/resident';
// Isolated browser check: no real alerts, model calls, recordings or messages.
const markup = new DOMParser().parseFromString(await (await fetch('/index.html')).text(), 'text/html');
markup.querySelectorAll('script').forEach(script => script.remove());
document.body.replaceChildren(...Array.from(markup.body.childNodes));
document.body.classList.add('ready'); document.body.dataset.view = 'result';
const panel = document.createElement('aside');
panel.style.cssText = 'position:fixed;right:20px;top:70px;z-index:20;background:white;border:1px solid #ccc;padding:20px;max-width:350px';
panel.innerHTML = '<h2>Simulated recording test</h2><p>The test recording is silence. No real Gemini calls.</p><button id="preview-clear">Remove approval</button><button id="preview-approve">Approved district warning</button><pre id="preview-log"></pre>';
document.body.append(panel);
const log = document.getElementById('preview-log')!;
const nativeFetch = window.fetch.bind(window); let requests = 0;
window.fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith('/api/alerts/')) return nativeFetch(input, init);
  log.textContent += url + '\n';
  if (++requests <= 2) return new Response('', { status: 404 });
  const bytes = new ArrayBuffer(44 + 16000), data = new DataView(bytes);
  const text = (offset: number, value: string) => [...value].forEach((c, i) => data.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF'); data.setUint32(4, bytes.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt '); data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true); data.setUint32(24, 8000, true); data.setUint32(28, 16000, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true); text(36, 'data'); data.setUint32(40, 16000, true);
  return new Response(bytes, { headers: { 'Content-Type': 'audio/wav' } });
};
const noop = () => {};
const ui = createResidentUi([], { onPick: noop, onAddress: noop, onLocate: noop, onShowWay: noop, onWhatIf: noop, onChange: noop, onStreet: noop, onRouteBack: noop });
const approve = () => ui.setOfficial({ id: 'area:preview-warning', status: 'approved', languages: ['en','ms'], approvedAt: new Date().toISOString(), approvedBy: 'Test officer', centre: '', heading: 'Approved district advisory', people: 0, message: 'TEST APPROVED MESSAGE — prepare to move.' });
document.getElementById('preview-clear')!.onclick = () => ui.setOfficial(null);
document.getElementById('preview-approve')!.onclick = approve;
approve();
