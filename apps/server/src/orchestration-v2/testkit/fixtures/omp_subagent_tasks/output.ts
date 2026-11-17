import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertNoExtraAppRunsForProviderChildren,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import { OMP_SUBAGENT_TASKS_PROMPT } from "./input.ts";

export function assertOmpSubagentTasksOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertNoExtraAppRunsForProviderChildren({ projection, expectedAppRuns: 1 });
  assertUserMessagesInclude(projection, [OMP_SUBAGENT_TASKS_PROMPT]);

  // One `task` call carries the whole batch, so the batch projects as one subagent.
  assert.lengthOf(projection.subagents, 1);
  const subagent = projection.subagents[0];
  assert.isDefined(subagent);
  assert.equal(subagent.origin, "provider_native");
  assert.equal(subagent.createdBy, "agent");
  assert.equal(subagent.driver, "omp");
  assert.equal(subagent.status, "completed");
  assert.include(subagent.prompt, "ALPHA_OK");
  assert.include(subagent.prompt, "BETA_OK");
  assert.include(subagent.title ?? "", "AlphaScout");
  assert.isTrue(
    projection.turnItems.some((item) => item.type === "subagent"),
    "the task call projects as a subagent turn item",
  );
  // omp reports the batch through one tool call, so no provider thread backs the child.
  assert.isNull(subagent.providerThreadId);

  assert.lengthOf(result.shellSnapshot.threads, 2, "root thread plus one subagent thread");
  if (subagent.childThreadId === null) throw new Error("subagent is missing its child thread");
  const childProjection = result.projections.get(subagent.childThreadId);
  assert.isDefined(childProjection);
  assert.equal(childProjection.thread.lineage.parentThreadId, projection.thread.id);
  assert.equal(childProjection.thread.lineage.relationshipToParent, "subagent");
  assertUserMessagesInclude(childProjection, [subagent.prompt]);
}
