/** Approved messages only. Never substitute browser speech for an official recording. */
export function createAlertAudio(root: HTMLElement) {
  const label = document.createElement('label'); label.textContent = 'Spoken alert ';
  const language = document.createElement('select'); language.setAttribute('aria-label', 'Spoken alert language'); label.append(language);
  const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'none';
  const status = document.createElement('p'); status.className = 'note'; status.setAttribute('role', 'status');
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'link'; retry.textContent = 'Retry recording';
  root.append(label, audio, retry, status);
  let id: string | null = null;
  const select = () => {
    audio.pause();
    if (!id) { audio.removeAttribute('src'); audio.load(); return; }
    audio.src = `/api/alerts/${encodeURIComponent(id)}/audio/${encodeURIComponent(language.value)}`;
    status.textContent = 'Recording may take a few seconds after approval. Press play to load; use Retry recording if it is unavailable.';
  };
  language.addEventListener('change', select);
  retry.addEventListener('click', select);
  audio.addEventListener('error', () => { status.textContent = 'Recording is not ready or unavailable. Use Retry recording to try again.'; });
  audio.addEventListener('canplay', () => { status.textContent = 'Approved alert recording'; });
  return {
    set(alert: { id: string; languages: string[] } | null) {
      const next = alert?.id ?? null;
      root.hidden = !alert;
      if (next === id) return;
      id = next;
      language.replaceChildren();
      for (const lang of alert?.languages ?? []) { const option = document.createElement('option'); option.value = lang; option.textContent = lang === 'ms' ? 'Bahasa Melayu' : lang === 'en' ? 'English' : lang; language.append(option); }
      select();
    },
  };
}
