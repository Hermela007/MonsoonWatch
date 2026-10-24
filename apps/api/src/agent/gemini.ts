// The ONLY file that calls the Gemini SDK (CLAUDE.md). Everything else goes through `interact`.
//
// Rules enforced here (GUIDELINES §6.1):
//   - Interactions API: client.interactions.create
//   - thinking via generation_config.thinking_level ("low" | "medium" | "high")
//   - never temperature / top_p / top_k / thinking_budget / cached_content
//   - background: true for long jobs (and always for agents like Deep Research)
//   - every call is logged as an AgentStep (actor, summary, status, latency, tokens)
//
// API shapes checked against the official gemini-api-dev skill + docs on 23 Oct 2026
// (interactions, thinking, structured-output, function-calling pages) and the
// @google/genai 2.31 type definitions.

import { GoogleGenAI, type GoogleGenAIInteraction, type Interactions } from "@google/genai";
import { z } from "zod";
import type { AgentStep } from "@monsoonwatch/shared";
import { ACTOR_LABEL, type AgentId, type ModelId, type ThinkingLevel } from "./models";
import { startStep } from "./steps";
import { env } from "../env";

type CreateParams = Interactions.InteractionCreateParams.CreateModelInteractionParamsNonStreaming;
type AgentCreateParams = Interactions.InteractionCreateParams.CreateAgentInteractionParamsNonStreaming;

/** Input accepted by the Interactions API: a string, content parts, or steps (e.g. function_result). */
export type InteractionInput = CreateParams["input"];
export type FunctionTool = {
  type: "function";
  name: string;
  description: string;
  /** JSON Schema object: { type: "object", properties, required } */
  parameters: Record<string, unknown>;
};

export interface FunctionCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface InteractOptions {
  runId: string;
  /** Exactly one of model / agent. */
  model?: ModelId;
  agent?: AgentId;
  /** One-line HUD text, e.g. "Orchestrating 4 villages". Token count is appended automatically. */
  summary: string;
  kind?: AgentStep["kind"];
  input: InteractionInput;
  systemInstruction?: string;
  thinkingLevel?: ThinkingLevel;
  tools?: FunctionTool[];
  /** Plain JSON Schema for structured output (use interactJson for zod validation). */
  responseJsonSchema?: Record<string, unknown>;
  /** TTS: return audio (WAV by default) spoken by this prebuilt voice, e.g. "Charon". */
  audioVoice?: string;
  previousInteractionId?: string;
  /** Required for agents; use for outputs > 65,536 tokens. Polls until done. */
  background?: boolean;
}

export interface InteractResult {
  id: string;
  text: string | null;
  functionCalls: FunctionCall[];
  usage: { inputTokens?: number; outputTokens?: number; thoughtTokens?: number; totalTokens?: number };
  /** Base64 audio when audioVoice was set (unary TTS defaults to audio/wav with a RIFF header). */
  audio: { data: string; mimeType?: string } | null;
  latencyMs: number;
  raw: GoogleGenAIInteraction;
}

const FORBIDDEN_CONFIG_KEYS = ["temperature", "top_p", "top_k", "thinking_budget", "cached_content"];
const BACKGROUND_POLL_MS = 5_000;
const BACKGROUND_TIMEOUT_MS = 20 * 60_000;

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!client) {
    const apiKey = env.geminiApiKey;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set (copy .env.example to .env)");
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

// The key lives only in .env (git-ignored) and in this process. Error text can end up in
// AgentSteps (MongoDB + Tech HUD on screen) and server logs, so scrub anything key-like first.
const GOOGLE_KEY_PATTERN = /AIza[0-9A-Za-z_-]{20,}/g;

export function redactSecrets(text: string): string {
  let out = text.replace(GOOGLE_KEY_PATTERN, "[REDACTED]");
  if (env.geminiApiKey) out = out.split(env.geminiApiKey).join("[REDACTED]");
  return out;
}

function buildParams(opts: InteractOptions): Record<string, unknown> {
  if (!!opts.model === !!opts.agent) throw new Error("interact: pass exactly one of `model` or `agent`");

  const params: Record<string, unknown> = { input: opts.input };
  if (opts.model) params.model = opts.model;
  if (opts.agent) params.agent = opts.agent;
  if (opts.systemInstruction) params.system_instruction = opts.systemInstruction;
  if (opts.tools?.length) params.tools = opts.tools;
  if (opts.previousInteractionId) params.previous_interaction_id = opts.previousInteractionId;
  if (opts.background || opts.agent) params.background = true;

  if (opts.thinkingLevel) params.generation_config = { thinking_level: opts.thinkingLevel };
  if (opts.audioVoice) {
    // Speech generation docs: response_format { type: "audio" } + generation_config.speech_config.
    params.response_format = { type: "audio" };
    params.generation_config = { ...((params.generation_config as object) ?? {}), speech_config: [{ voice: opts.audioVoice }] };
  }

  if (opts.responseJsonSchema) {
    params.response_format = { type: "text", mime_type: "application/json", schema: opts.responseJsonSchema };
  }

  const config = (params.generation_config ?? {}) as Record<string, unknown>;
  for (const key of FORBIDDEN_CONFIG_KEYS) {
    if (key in config || key in params) throw new Error(`interact: "${key}" is not allowed (GUIDELINES §6.1)`);
  }
  return params;
}

async function waitForBackground(id: string): Promise<GoogleGenAIInteraction> {
  const deadline = Date.now() + BACKGROUND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const it = await getClient().interactions.get(id);
    if (it.status === "completed") return it;
    if (it.status === "failed" || it.status === "cancelled" || it.status === "incomplete") {
      throw new Error(`Background interaction ${id} ended with status "${it.status}"`);
    }
    await new Promise((r) => setTimeout(r, BACKGROUND_POLL_MS));
  }
  throw new Error(`Background interaction ${id} timed out`);
}

function extractFunctionCalls(it: GoogleGenAIInteraction): FunctionCall[] {
  const steps = (it.steps ?? []) as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>;
  return steps
    .filter((s) => s.type === "function_call")
    .map((s) => ({
      id: String(s.id),
      name: String(s.name),
      arguments: (s.arguments ?? {}) as Record<string, unknown>,
    }));
}

function formatTokens(n?: number): string {
  if (n === undefined) return "";
  return n >= 1000 ? ` · ${Math.round(n / 1000)}k tokens` : ` · ${n} tokens`;
}

/** One Gemini call, logged as an AgentStep. */
export async function interact(opts: InteractOptions): Promise<InteractResult> {
  const params = buildParams(opts);
  const actor = ACTOR_LABEL[(opts.model ?? opts.agent) as ModelId | AgentId];
  const step = await startStep({ runId: opts.runId, actor, kind: opts.kind ?? "plan", summary: opts.summary });
  const startedAt = Date.now();

  try {
    const interactions = getClient().interactions;
    let it = opts.agent
      ? await interactions.create(params as AgentCreateParams)
      : await interactions.create(params as CreateParams);
    if (params.background && it.status !== "completed") it = await waitForBackground(it.id);

    const u = it.usage;
    const usage = {
      inputTokens: u?.total_input_tokens,
      outputTokens: u?.total_output_tokens,
      thoughtTokens: u?.total_thought_tokens,
      totalTokens: u?.total_tokens,
    };
    await step.ok({ summary: opts.summary + formatTokens(usage.inputTokens), tokens: usage.totalTokens });

    return {
      id: it.id,
      text: it.output_text ?? null,
      functionCalls: extractFunctionCalls(it),
      audio: it.output_audio?.data ? { data: it.output_audio.data, mimeType: it.output_audio.mime_type } : null,
      usage,
      latencyMs: Date.now() - startedAt,
      raw: it,
    };
  } catch (err) {
    const message = redactSecrets((err as Error).message ?? String(err));
    await step.fail({ summary: `${opts.summary} — error: ${message}`.slice(0, 200) });
    throw new Error(`Gemini call failed: ${message}`);
  }
}

/**
 * Structured output validated with zod. On parse/validation failure: retry ONCE, telling the
 * model what was wrong (continuing the same interaction), then surface the error (CLAUDE.md).
 */
export async function interactJson<T>(
  opts: Omit<InteractOptions, "responseJsonSchema"> & { schema: z.ZodType<T> },
): Promise<{ data: T; result: InteractResult }> {
  const { schema, ...rest } = opts;
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;

  const first = await interact({ ...rest, responseJsonSchema: jsonSchema });
  const firstTry = parseJson(schema, first.text);
  if (firstTry.ok) return { data: firstTry.data, result: first };

  const retry = await interact({
    ...rest,
    summary: `${rest.summary} (retry: invalid JSON)`,
    input: `Your previous answer failed validation: ${firstTry.error}. Return only JSON that matches the schema.`,
    previousInteractionId: first.id,
    responseJsonSchema: jsonSchema,
  });
  const secondTry = parseJson(schema, retry.text);
  if (secondTry.ok) return { data: secondTry.data, result: retry };
  throw new Error(`Structured output invalid after retry: ${secondTry.error}`);
}

function parseJson<T>(schema: z.ZodType<T>, text: string | null):
  | { ok: true; data: T }
  | { ok: false; error: string } {
  if (!text) return { ok: false, error: "empty response" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "response was not valid JSON" };
  }
  const res = schema.safeParse(parsed);
  return res.success ? { ok: true, data: res.data } : { ok: false, error: z.prettifyError(res.error).slice(0, 1000) };
}
