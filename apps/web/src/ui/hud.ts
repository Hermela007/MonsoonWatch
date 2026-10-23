import { REPLAY_HOURS, rainIntensity, replayDate, stageM, worstStageM } from '../mock/replay2014';

const $ = <T extends HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

export interface HudReadouts {
  rain: number;
  stageM: number;
  floodedKm2: number;
  slopeKm2: number;
}

/** Timeline (play / scrub 72 h), readouts, loading screen. */
export function createHud(handlers: { onTour: () => void; onPreset: (i: number) => void }) {
  const slider = $<HTMLInputElement>('time');
  const play = $<HTMLButtonElement>('play');
  const dateEl = $('date');
  const hourEl = $('hour');
  let hour = 0;
  let playing = false;
  let speed = 3; // replay hours per second

  slider.max = String(REPLAY_HOURS);
  slider.addEventListener('input', () => {
    hour = Number(slider.value);
    setPlaying(false);
  });
  const setPlaying = (p: boolean) => {
    playing = p;
    play.textContent = p ? '❚❚' : '▶';
    play.setAttribute('aria-label', p ? 'Pause replay' : 'Play replay');
  };
  play.addEventListener('click', () => {
    if (!playing && hour >= REPLAY_HOURS) hour = 0;
    setPlaying(!playing);
  });
  $('tour').addEventListener('click', handlers.onTour);
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
    if (e.code === 'Space') {
      e.preventDefault();
      play.click();
    } else if (e.key === 'c') handlers.onTour();
    else if (/^[1-9]$/.test(e.key)) handlers.onPreset(Number(e.key) - 1);
  });

  drawSparkline($<HTMLCanvasElement>('spark'));

  const readout = {
    rain: $('r-rain'),
    stage: $('r-stage'),
    flooded: $('r-flooded'),
    slope: $('r-slope'),
  };

  return {
    get hour() {
      return hour;
    },
    get playing() {
      return playing;
    },
    play(fromStart = false, hoursPerSecond = 3) {
      if (fromStart) hour = 0;
      speed = hoursPerSecond;
      setPlaying(true);
    },
    tick(dtS: number) {
      if (playing) {
        hour = Math.min(REPLAY_HOURS, hour + dtS * speed);
        if (hour >= REPLAY_HOURS) setPlaying(false);
      }
      slider.value = String(hour);
      slider.style.setProperty('--p', `${(hour / REPLAY_HOURS) * 100}%`);
      const d = replayDate(hour);
      dateEl.textContent = d.toLocaleDateString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
      hourEl.textContent = `${d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kuala_Lumpur', hour: '2-digit', minute: '2-digit' })} MYT · T+${hour.toFixed(0)}h`;
    },
    setReadouts(r: HudReadouts) {
      readout.rain.textContent = `${Math.round(r.rain * 100)}%`;
      readout.stage.textContent = `+${r.stageM.toFixed(1)} m`;
      readout.flooded.textContent = `${Math.round(r.floodedKm2).toLocaleString('en-GB')} km²`;
      readout.slope.textContent = `${Math.round(r.slopeKm2).toLocaleString('en-GB')} km²`;
    },
    loading(msg: string, frac: number) {
      $('loading-msg').textContent = msg;
      $('loading-bar').style.width = `${Math.round(frac * 100)}%`;
    },
    ready() {
      document.body.classList.add('ready');
    },
    fail(msg: string) {
      $('loading-msg').textContent = msg;
      document.body.classList.add('failed');
    },
  };
}

function drawSparkline(canvas: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  const bars = 72;
  for (let i = 0; i < bars; i++) {
    const v = rainIntensity(i + 0.5);
    const bh = v * h * 0.55;
    ctx.fillStyle = 'rgba(159, 216, 255, 0.28)';
    ctx.fillRect((i / bars) * w + 0.5, h - bh, w / bars - 1, bh);
  }
  const peak = worstStageM(REPLAY_HOURS);
  const curve = (f: (h: number) => number, style: string, dash: number[]) => {
    ctx.beginPath();
    for (let x = 0; x <= w; x++) {
      const y = h - (f((x / w) * REPLAY_HOURS) / peak) * h * 0.92;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = style;
    ctx.setLineDash(dash);
    ctx.lineWidth = 1.5;
    ctx.stroke();
  };
  curve(worstStageM, 'rgba(111, 243, 255, 0.35)', [3, 3]);
  curve(stageM, 'rgba(111, 243, 255, 0.95)', []);
}
