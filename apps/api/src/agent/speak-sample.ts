// Try the spoken alert without approving anything: speaks one sample Malay + English message
// (TEST TEXT) with Gemini 3.8 Flash TTS and writes apps/api/data/audio/sample.<lang>.wav.
//   pnpm --filter @monsoonwatch/api exec tsx src/agent/speak-sample.ts
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { closeDb } from "../db/client";
import { audioFile, speakText, wavSeconds } from "./speech";

const SAMPLES = [
  { lang: "ms", text: "AMARAN BANJIR (UJIAN): Paras air Sungai Galas melepasi tahap bahaya. Penduduk Kampung Manik Urai diminta berpindah ke SK Manik Urai. Penduduk terlantar dan OKU akan diambil dahulu dengan ambulans. Sila bertenang dan ikut arahan petugas." },
  { lang: "en", text: "FLOOD WARNING (TEST): The Galas river has passed the danger level. Residents of Kampung Manik Urai, please move to SK Manik Urai. Bedridden and disabled residents will be collected first by ambulance. Please stay calm and follow instructions." },
];

try {
  await mkdir(new URL(".", audioFile("sample", "ms")), { recursive: true });
  for (const s of SAMPLES) {
    const wav = await speakText(`tts-sample-${Date.now()}`, s.text, `sample (${s.lang})`);
    const f = audioFile("sample", s.lang);
    await writeFile(f, wav);
    console.log(`${s.lang}: ${wavSeconds(wav.length)} s → ${fileURLToPath(f)}`);
  }
} finally {
  await closeDb();
}
