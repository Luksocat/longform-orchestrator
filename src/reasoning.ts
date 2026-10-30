import { Agent, Runner } from "@openai/agents";
import { z } from "zod";
import type { Task } from "./domain.js";

const AdviceSchema = z.object({
  suggestions: z.array(
    z.object({
      taskId: z.string(),
      classification: z.enum(["CANDIDATE", "BLOCKED", "OWNER_DECISION"]),
      provider: z.enum(["codex", "claude", "mock"]),
      explanation: z.string(),
    }),
  ),
});
export function preparePacket(task: Task) {
  // No retrieved documents, paths, credentials, briefs, source text or freeform
  // blocker content is exported. Output is advisory and cannot mutate the DB.
  return {
    taskId: task.id,
    status: task.status,
    simulation: task.simulation,
    risk: task.risk,
    priority: task.priority,
    dependencies: task.dependencies,
    decisionRequired: task.decisionRequired,
    hasHolds: task.blockers.length > 0,
    providers: task.providers,
  };
}
export function deterministicAdvice(tasks: Task[]) {
  return AdviceSchema.parse({
    suggestions: tasks.map((t) => ({
      taskId: t.id,
      classification: t.decisionRequired
        ? "OWNER_DECISION"
        : t.blockers.length
          ? "BLOCKED"
          : "CANDIDATE",
      provider: t.providers[0],
      explanation:
        "Advisory metadata classification; controller guards decide eligibility",
    })),
  });
}
export function createAdviser(model: string) {
  if (!model.trim()) throw new Error("EXPLICIT_MODEL_REQUIRED");
  return new Agent({
    name: "Longform advisory classifier",
    model,
    instructions:
      "Classify supplied synthetic task metadata. You have no tools or authority. Candidate is a suggestion only. Do not infer owner decisions, acceptance, or source authority.",
    outputType: AdviceSchema,
  });
}
export async function sdkAdvice(
  tasks: Task[],
  options: {
    model: string;
    enable: boolean;
    exportTaskIds: string[];
    deadlineMs: number;
  },
) {
  if (!options.enable) throw new Error("SDK_NETWORK_DISABLED");
  if (tasks.some((t) => !t.simulation || !options.exportTaskIds.includes(t.id)))
    throw new Error("RESTRICTED_SOURCE_EXPORT_DISABLED");
  if (!process.env.OPENAI_API_KEY)
    throw new Error("SDK_CREDENTIAL_UNAVAILABLE");
  if (
    !Number.isInteger(options.deadlineMs) ||
    options.deadlineMs < 1 ||
    options.deadlineMs > 30_000
  )
    throw new Error("INVALID_DEADLINE");
  // No tools, handoffs, SDK sessions, or traces. SQLite remains the sole workflow state.
  const result = await new Runner({ tracingDisabled: true }).run(
    createAdviser(options.model),
    JSON.stringify(tasks.map(preparePacket)),
    { maxTurns: 1, signal: AbortSignal.timeout(options.deadlineMs) },
  );
  const output = AdviceSchema.parse(result.finalOutput);
  if (output.suggestions.some((s) => !tasks.some((t) => t.id === s.taskId)))
    throw new Error("ADVISER_UNKNOWN_TASK");
  return output;
}
