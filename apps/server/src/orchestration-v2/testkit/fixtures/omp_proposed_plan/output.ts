import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertNoExtraAppRunsForProviderChildren,
  assertSemanticProjectionIntegrity,
  projectionFor,
} from "../shared.ts";

export function assertOmpProposedPlanOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertNoExtraAppRunsForProviderChildren({ projection, expectedAppRuns: 1 });

  // omp never sends the plan over ACP; its plan-artifact write is what publishes it.
  assert.lengthOf(projection.plans, 1);
  const plan = projection.plans[0];
  assert.isDefined(plan);
  assert.equal(plan.kind, "proposed_plan");
  const markdown = plan.kind === "proposed_plan" ? plan.markdown : "";
  assert.include(markdown, "DRY_RUN_PLAN_OK");
  assert.isTrue(
    projection.turnItems.some((item) => item.type === "proposed_plan"),
    "the plan artifact projects as a proposed_plan turn item",
  );
}
