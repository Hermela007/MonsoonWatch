// Function-calling loop for the orchestrator and subagents (B1/B2).
// Gemini asks for a tool → we run the plain TS function → send a function_result back with
// previous_interaction_id (per the official function-calling docs). Each tool run is an AgentStep.

import { interact, type FunctionTool, type InteractOptions, type InteractResult } from "./gemini";
import { startStep } from "./steps";

export interface AgentTool {
  decl: FunctionTool;
  /** HUD actor for this tool, e.g. "MongoDB Atlas Search", "MongoDB Geospatial", "Route planner". */
  actor: string;
  run: (args: Record<string, unknown>) => Promise<unknown> | unknown;
  /** One-line HUD summary of what happened; defaults to the tool name. */
  describe?: (args: Record<string, unknown>, result: unknown) => string;
}

export async function runWithTools(
  opts: Omit<InteractOptions, "tools"> & { agentTools: AgentTool[]; maxTurns?: number },
): Promise<InteractResult> {
  const { agentTools, maxTurns = 8, ...base } = opts;
  const decls = agentTools.map((t) => t.decl);
  const byName = new Map(agentTools.map((t) => [t.decl.name, t]));

  let result = await interact({ ...base, tools: decls });

  for (let turn = 0; turn < maxTurns && result.functionCalls.length > 0; turn++) {
    const outputs = await Promise.all(
      result.functionCalls.map(async (call) => {
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
        } catch (err) {
          output = { error: (err as Error).message };
          await step.fail({ summary: `${call.name} failed: ${(err as Error).message}`.slice(0, 200) });
        }
        return {
          type: "function_result" as const,
          name: call.name,
          call_id: call.id,
          result: [{ type: "text" as const, text: JSON.stringify(output) }],
        };
      }),
    );

    result = await interact({
      ...base,
      summary: `${base.summary} (turn ${turn + 2})`,
      tools: decls,
      input: outputs as InteractOptions["input"],
      previousInteractionId: result.id,
    });
  }

  if (result.functionCalls.length > 0) throw new Error(`Tool loop exceeded ${maxTurns} turns`);
  return result;
}
