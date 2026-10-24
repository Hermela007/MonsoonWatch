export interface ApprovedRecording { id: string; languages: string[]; status: string }
export type RecordingState = { visible: boolean; phase: 'idle' | 'loading' | 'playing' | 'error'; language?: string; message: string };
export const approvedLanguages = (languages: string[]) => ['ms', 'en'].filter(lang => languages.includes(lang));

/** Fetch only the approved recording. A 404 is retried briefly; device speech is never substituted. */
export function createResidentAudio(onState: (state: RecordingState) => void, deps: {
  request?: typeof fetch;
  createAudio?: () => HTMLAudioElement;
  createUrl?: (blob: Blob) => string;
  revokeUrl?: (url: string) => void;
  wait?: (signal: AbortSignal) => Promise<void>;
} = {}) {
  const request = deps.request ?? fetch;
  const makeAudio = deps.createAudio ?? (() => new Audio());
  const createUrl = deps.createUrl ?? (blob => URL.createObjectURL(blob));
  const revokeUrl = deps.revokeUrl ?? (url => URL.revokeObjectURL(url));
  const wait = deps.wait ?? (signal => new Promise<void>((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, 2000);
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('Cancelled')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  }));
  let target: ApprovedRecording | null = null;
  let signature = '';
  let revision = 0;
  let controller: AbortController | null = null;
  let audio: HTMLAudioElement | null = null;
  let objectUrl: string | null = null;
  const show = (phase: RecordingState['phase'], message = '', language = target ? approvedLanguages(target.languages)[0] : undefined) => onState({ visible: !!target, phase, message, language });
  const release = () => {
    revision++; controller?.abort(); controller = null;
    if (audio) { audio.onended = audio.onerror = null; audio.pause(); audio.removeAttribute('src'); audio.load(); audio = null; }
    if (objectUrl) { revokeUrl(objectUrl); objectUrl = null; }
  };
  const stop = () => { release(); show('idle'); };
  return {
    set(value: ApprovedRecording | null) {
      const next = value && ['approved', 'sent'].includes(value.status) && approvedLanguages(value.languages).length ? value : null;
      const nextSignature = next ? `${next.id}:${approvedLanguages(next.languages).join(',')}` : '';
      if (nextSignature === signature) return;
      release(); target = next; signature = nextSignature; show('idle');
    },
    stop,
    async toggle() {
      if (controller || audio) { stop(); return; }
      if (!target) return;
      const selected = target, mine = ++revision, ctl = new AbortController(); controller = ctl;
      show('loading', 'Loading the approved Gemini recording…');
      try {
        for (let attempt = 0; attempt < 6; attempt++) {
          for (const language of approvedLanguages(selected.languages)) {
            const timeout = setTimeout(() => ctl.abort(), 15000);
            let response: Response;
            try { response = await request(`/api/alerts/${encodeURIComponent(selected.id)}/audio/${language}`, { signal: ctl.signal }); }
            finally { clearTimeout(timeout); }
            if (mine !== revision) return;
            if (response.status === 404) continue;
            if (!response.ok) throw new Error(`Recording unavailable (HTTP ${response.status}). Tap Listen to retry.`);
            const blob = await response.blob();
            if (mine !== revision) return;
            objectUrl = createUrl(blob); audio = makeAudio(); audio.src = objectUrl;
            audio.onended = () => { if (mine === revision) stop(); };
            audio.onerror = () => { if (mine === revision) { release(); show('error', 'Recording could not play. Tap Listen to retry.'); } };
            await audio.play();
            if (mine === revision) show('playing', `Gemini · approved alert · ${language === 'ms' ? 'Bahasa Melayu' : 'English'}`, language);
            return;
          }
          if (attempt < 5) { show('loading', 'Approved audio is still being generated. Waiting a few seconds…'); await wait(ctl.signal); }
        }
        throw new Error('Approved recording is not ready yet. Tap Listen to retry in a few seconds.');
      } catch (error) {
        if (mine !== revision) return;
        release(); show('error', error instanceof Error ? error.message : 'Recording unavailable. Tap Listen to retry.');
      }
    },
  };
}
