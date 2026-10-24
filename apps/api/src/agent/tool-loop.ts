// Function-calling loop for the orchestrator and subagents (B1/B2).
// Gemini asks for a tool → we run the plain TS function → send a function_result back with
// previous_interaction_id (per the official function-calling docs). Each tool run is an AgentStep.
//
// A tool can be marked `submit`: when Gemini calls it with valid arguments, the loop stops and
// returns those arguments as the answer (structured output via a tool call — no free-text JSON
// to parse). The call is left unanswered on purpose: the caller answers it later with
// `submitResult()` (e.g. the verification verdict), continuing the same interaction.

import { interact, type FunctionTool, type InteractOptions, type InteractResult } from "./gemini";
import { startStep } from "./steps";

export interface AgentTool {
  decl: FunctionTool;
  /** HUD actor for this tool, e.g. "MongoDB Atlas Search", "MongoDB Geospatial", "Route planner". */
  actor: string;
  run: (args: Record<string, unknown>) => Promise<unknown> | unknown;
  /** One-line HUD summary of what happened; defaults to the tool name. */
  describe?: (args: Record<string, unknown>, result: unknown) => string;
  /** If set, a successful call ends the loop; `run` must throw on invalid arguments (sent back to fix). */
  submit?: boolean;
}

export interface ToolLoopResult extends InteractResult {
  /** Arguments of the accepted `submit` tool call, if one happened. */
  submitted?: { callId: string; name: string; args: Record<string, unknown>; value: unknown; otherResults: unknown[] };
}

type ResultStep = { type: "function_result"; name: string; call_id: string; result: { type: "text"; text: string }[] };

/** The function_result that answers an accepted submit call (send as `input` with previousInteractionId). */
export function submitResult(submitted: NonNullable<ToolLoopResult["submitted"]>, text: string): InteractOptions["input"] {
  const step: ResultStep = { type: "function_result", name: submitted.name, call_id: submitted.callId, result: [{ type: "text", text }] };
  // Any other tool calls made in the same turn are answered too, so no call is left open.
  return [...submitted.otherResults, step] as unknown as InteractOptions["input"];
}

export async function runWithTools(
  opts: Omit<InteractOptions, "tools"> & { agentTools: AgentTool[]; maxTurns?: number },
): Promise<ToolLoopResult> {
  const { agentTools, maxTurns = 8, ...base } = opts;
  const decls = agentTools.map((t) => t.decl);
  const byName = new Map(agentTools.map((t) => [t.decl.name, t]));

  let result: ToolLoopResult = await interact({ ...base, tools: decls });

  for (let turn = 0; turn < maxTurns && result.functionCalls.length > 0; turn++) {
    let submitted: ToolLoopResult["submitted"];
    const outputs = await Promise.all(
      result.functionCalls.map(async (call): Promise<ResultStep> => {
        const tool = byName.get(call.name);
        const step = await startStep({
          runId: base.runId,
          actor: tool?.actor ?? "Agent tool",
          kind: "tool",
          summary: call.name,
        });
        let output: unknown;
        try {
          if (!tool) throw new Error(`Unknown tool ${call.name}`);
          output = await tool.run(call.arguments);
          await step.ok({ summary: tool.describe?.(call.arguments, output) ?? call.name });
          if (tool.submit) submitted = { callId: call.id, name: call.name, args: call.arguments, value: output, otherResults: [] };
        } catch (err) {
          output = { error: (err as Error).message };
          await step.fail({ summary: `${call.name} failed: ${(err as Error).message}`.slice(0, 200) });
        }
        return { type: "function_result", name: call.name, call_id: call.id, result: [{ type: "text", text: JSON.stringify(output) }] };
      }),
    );

    // An accepted submit ends the loop. Its call stays open for the caller's verdict (submitResult).
    if (submitted) {
      const s = submitted as NonNullable<ToolLoopResult["submitted"]>;
      s.otherResults = outputs.filter((o) => o.call_id !== s.callId);
      return { ...result, submitted: s };
    }

    result = await interact({
      ...base,
      summary: `${base.summary} (turn ${turn + 2})`,
      tools: decls,
      input: outputs as unknown as InteractOptions["input"],
      previousInteractionId: result.id,
    });
  }

  if (result.functionCalls.length > 0) throw new Error(`Tool loop exceeded ${maxTurns} turns`);
  return result;
}
