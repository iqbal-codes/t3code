import type { OrchestratorFixtureInput } from "../shared.ts";

const OMP_PROPOSED_PLAN_PROMPT = [
  "Plan how to add a `--dry-run` flag to this workspace's CLI entrypoint.",
  "Do not change any workspace file. Write the plan to the session-local plan artifact for this task.",
  "End the plan with the line DRY_RUN_PLAN_OK, then reply with exactly PLAN_DONE.",
  "Do not ask any question and do not start implementing.",
].join("\n");

/**
 * The transcript keeps a recorded omp ACP envelope and replaces only its tool frame with a
 * plan-artifact `write`, because a live plan-mode turn blocks on omp's plan review, which no
 * replay agent can answer. The hook under test reads that write, not the session mode.
 */
export function ompProposedPlanInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: OMP_PROPOSED_PLAN_PROMPT }],
  };
}
