import type { OrchestratorFixtureInput } from "../shared.ts";

export const OMP_SUBAGENT_TASKS_PROMPT = [
  "Call the task tool exactly once, with both entries in its tasks array, and nothing else.",
  "",
  '1) name "AlphaScout", agent "task", task: "Reply with exactly ALPHA_OK and make no tool calls."',
  '2) name "BetaScout", agent "task", task: "Reply with exactly BETA_OK and make no tool calls."',
  "",
  "Then reply with exactly DELEGATION_DONE.",
].join("\n");

export function ompSubagentTasksInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: OMP_SUBAGENT_TASKS_PROMPT }],
  };
}
