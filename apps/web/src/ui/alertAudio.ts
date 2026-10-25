/** Approved messages only. Never substitute browser speech for an official recording. */
export function createAlertAudio(root: HTMLElement) {
  const label = document.createElement('label'); label.textContent = 'Listen to approved warning ';
  const language = document.createElement('select'); language.setAttribute('aria-label', 'Spoken alert language'); label.append(language);
  const audio = document.createElement('audio'); audio.controls = true; audio.preload = 'none';
  const status = document.createElement('p'); status.className = 'audio-recording-status'; status.setAttribute('role', 'status');
  const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'link'; retry.textContent = 'Retry recording';
  root.append(label, audio, retry, status);
  let id: string | null = null;
  const select = () => {
    audio.pause();
    retry.hidden = true;
    status.dataset.state = 'ready';
    if (!id) { audio.removeAttribute('src'); audio.load(); return; }
    audio.src = `/api/alerts/${encodeURIComponent(id)}/audio/${encodeURIComponent(language.value)}`;
    status.textContent = 'Gemini voice · Press play to hear the approved warning.';
  };
  language.addEventListener('change', select);
  retry.addEventListener('click', select);
  audio.addEventListener('error', () => { status.dataset.state = 'error'; status.textContent = 'Recording is not ready yet. Try again in a few seconds.'; retry.hidden = false; });
  audio.addEventListener('canplay', () => { status.dataset.state = 'ready'; status.textContent = 'Gemini voice · Approved warning'; retry.hidden = true; });
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
