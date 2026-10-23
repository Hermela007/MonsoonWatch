// Gemini model + agent IDs used by MonsoonWatch (exact strings, see CLAUDE.md / GUIDELINES §6.2).
// Keep every ID in this one file so the README can link to it.

export const MODELS = {
  /** Lead orchestrator — whole situation in one 1M-token context. */
  argon: "gemini-4-argon",
  /** Parallel per-village subagents (route, centre, pickup order, alert text). */
  flash: "gemini-3.8-flash",
  /** Cheap routing / classification (e.g. "does this risk event need a full agent run?"). */
  flashLite: "gemini-3.5-flash-lite",
  /** Browser voice Q&A (Live API — separate skill, not the Interactions API). */
  live: "gemini-3.8-live",
  /** Optional: spoken alerts. */
  tts: "gemini-3.8-flash-tts",
  /** Optional: "Illustration, not a prediction". */
  nanoBanana: "gemini-nano-banana-2.1",
} as const;

export const AGENTS = {
  /** Landslide thresholds + flood history briefs, with citations. Requires background: true. */
  deepResearch: "deep-research-preview-04-2026",
  /** Optional sandboxed verification scripts. */
  antigravity: "antigravity-preview-09-2026",
} as const;

export type ModelId = (typeof MODELS)[keyof typeof MODELS];
export type AgentId = (typeof AGENTS)[keyof typeof AGENTS];

/** Per CLAUDE.md we only ever use these three levels. Never thinking_budget. */
export type ThinkingLevel = "low" | "medium" | "high";

/** Human-readable actor names shown as badges in the Tech HUD (AgentStep.actor). */
export const ACTOR_LABEL: Record<ModelId | AgentId, string> = {
  "gemini-4-argon": "Gemini 4 Argon",
  "gemini-3.8-flash": "Gemini 3.8 Flash",
  "gemini-3.5-flash-lite": "Gemini 3.5 Flash-Lite",
  "gemini-3.8-live": "Gemini 3.8 Live",
  "gemini-3.8-flash-tts": "Gemini 3.8 Flash TTS",
  "gemini-nano-banana-2.1": "Nano Banana 2.1",
  "deep-research-preview-04-2026": "Gemini Deep Research",
  "antigravity-preview-09-2026": "Antigravity Agent",
};
