// Brief item 7 — spoken alert. AFTER an official approves an alert, Gemini 3.8 Flash TTS reads the
// approved text aloud, one WAV per language (Malay first), for mosque loudspeakers / local radio
// and for Saint to send as a WhatsApp voice note.
//
// Safety: the TTS transcript is the approved message VERBATIM (the speech generation docs treat
// `text` strictly as a transcript; delivery style goes in speech_metadata), so the audio can't say
// anything the official didn't approve. Generating audio is not sending: sending stays with
// Saint / humans after approval.
//
// Files: apps/api/data/audio/<alertId>.<lang>.wav (git-ignored), served by
// GET /api/alerts/:id/audio/:lang.

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import type { Alert } from "@monsoonwatch/shared";
import { interact } from "./gemini";
import { MODELS } from "./models";
import { emitStep } from "./steps";

/** Prebuilt voice from the docs' list: "Kore" (Firm) — a woman's voice, suits an official announcement. */
export const ALERT_VOICE = "Kore";
/** Brisk for the 2–4 min demo, but still clear enough for a loudspeaker. */
export const ALERT_STYLE = "clear, calm and brisk, speaking at a quick but easily understood pace, like an official public safety announcement";

const AUDIO_DIR = new URL("../../data/audio/", import.meta.url);

const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
export const audioFile = (alertId: string, lang: string) => new URL(`${safe(alertId)}.${safe(lang)}.wav`, AUDIO_DIR);
export const audioUrl = (alertId: string, lang: string) => `/api/alerts/${encodeURIComponent(alertId)}/audio/${lang}`;

/** Seconds of audio in a 24 kHz mono 16-bit WAV (the TTS default). Approximate if the header differs. */
export function wavSeconds(bytes: number): number {
  return Math.max(0, Math.round(((bytes - 44) / 48_000) * 10) / 10);
}

/** Region languages first in the order given (Malay first), any others after. */
export function orderMessages(alert: Pick<Alert, "messages">, languages: string[]): Alert["messages"] {
  const rank = (l: string) => { const i = languages.indexOf(l); return i < 0 ? 99 : i; };
  return [...alert.messages].filter((m) => m.text.trim()).sort((a, b) => rank(a.lang) - rank(b.lang));
}

export async function speakText(runId: string, text: string, label: string): Promise<Buffer> {
  const res = await interact({
    runId,
    model: MODELS.tts,
    kind: "tool",
    summary: `Spoken alert: ${label}`,
    audioVoice: ALERT_VOICE,
    input: [{
      type: "user_input",
      content: [{ type: "text", text, annotations: [{ type: "speech_metadata", style: ALERT_STYLE }] }],
    }] as unknown as Parameters<typeof interact>[0]["input"],
  });
  if (!res.audio) throw new Error("TTS returned no audio");
  return Buffer.from(res.audio.data, "base64");
}

/** Generate and save audio for every message of an approved alert. Never throws (logged to the HUD). */
export async function generateSpokenAlert(alert: Alert, languages = ["ms", "en"]): Promise<{ lang: string; url: string; seconds: number }[]> {
  if (alert.status !== "approved" && alert.status !== "sent") {
    await emitStep({ runId: alert.runId, actor: "Gemini 3.8 Flash TTS", kind: "tool", status: "fail", summary: `Not speaking alert ${alert._id}: it is "${alert.status}", not approved` });
    return [];
  }
  const done: { lang: string; url: string; seconds: number }[] = [];
  await mkdir(AUDIO_DIR, { recursive: true });
  for (const m of orderMessages(alert, languages)) {
    try {
      const wav = await speakText(alert.runId, m.text, `${alert.villageId} (${m.lang})`);
      await writeFile(audioFile(alert._id, m.lang), wav);
      done.push({ lang: m.lang, url: audioUrl(alert._id, m.lang), seconds: wavSeconds(wav.length) });
    } catch (err) {
      await emitStep({ runId: alert.runId, actor: "Gemini 3.8 Flash TTS", kind: "tool", status: "fail", summary: `Spoken alert (${m.lang}) failed: ${(err as Error).message}`.slice(0, 200) });
    }
  }
  if (done.length) {
    await emitStep({
      runId: alert.runId, actor: "Gemini 3.8 Flash TTS", kind: "info", status: "ok",
      summary: `Spoken alert ready for ${alert.villageId}: ${done.map((d) => `${d.lang} ${d.seconds}s`).join(", ")} → for loudspeaker / radio / voice note`,
    });
  }
  return done;
}

export async function readSpokenAlert(alertId: string, lang: string): Promise<Buffer | null> {
  try {
    const f = audioFile(alertId, lang);
    await stat(f);
    return await readFile(f);
  } catch {
    return null;
  }
}
