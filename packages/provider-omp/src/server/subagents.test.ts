import { assert, describe, it } from "@effect/vitest";

import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
import { extractOmpSubagentUpdate, isOmpSubagentTool } from "./subagents.ts";

const ALPHA = {
  name: "AlphaScout",
  agent: "task",
  task: "Reply with exactly ALPHA_OK.",
  solutionSpace: "one fix: reply with a fixed token",
  model: "openai/gpt-5.2",
};
const BETA = {
  name: "BetaScout",
  agent: "task",
  task: "Reply with exactly BETA_OK.",
  solutionSpace: "one fix: reply with a fixed token",
  model: "openai/gpt-5.2",
};

function taskCall(input: {
  readonly rawInput?: unknown;
  readonly toolCallId?: string;
  /** `null` omits the ACP tool name, for calls that predate it. */
  readonly name?: string | null;
  readonly status?: AcpToolCallState["status"];
  readonly detail?: string;
}): AcpToolCallState {
  return {
    toolCallId: input.toolCallId ?? "task-1",
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.detail === undefined ? {} : { detail: input.detail }),
    data: {
      ...(input.name === null ? {} : { name: input.name ?? "task" }),
      ...(input.rawInput === undefined ? {} : { rawInput: input.rawInput }),
    },
  };
}

describe("omp subagent detection", () => {
  it("folds a batch task call into one subagent covering every assignment", () => {
    const toolCall = taskCall({ rawInput: { context: "shared contract", tasks: [ALPHA, BETA] } });

    assert.equal(isOmpSubagentTool(toolCall), true);
    assert.deepEqual(extractOmpSubagentUpdate(toolCall), {
      nativeTaskId: "task-1",
      prompt:
        "# Shared context\nshared contract\n\n" +
        "## AlphaScout\nReply with exactly ALPHA_OK.\n\n" +
        "## BetaScout\nReply with exactly BETA_OK.",
      title: "AlphaScout +1",
      model: "openai/gpt-5.2",
      status: "running",
      childSessionId: null,
      result: null,
      suppressNormalTool: true,
    });
  });

  it("keeps the task title for a one-entry batch", () => {
    const update = extractOmpSubagentUpdate(taskCall({ rawInput: { tasks: [ALPHA] } }));
    assert.equal(update?.title, "AlphaScout");
    assert.equal(update?.prompt, "Reply with exactly ALPHA_OK.");
  });

  it("still maps the pre-batch single-task shape", () => {
    const update = extractOmpSubagentUpdate(
      taskCall({ rawInput: { agent: "reviewer", task: "Review it", name: "Review" } }),
    );
    assert.equal(update?.title, "Review");
    assert.equal(update?.prompt, "Review it");
  });

  it("uses taskFile as the instruction text", () => {
    const update = extractOmpSubagentUpdate(
      taskCall({ rawInput: { agent: "task", taskFile: "/tmp/task.md" } }),
    );
    assert.equal(update?.prompt, "/tmp/task.md");
    assert.equal(update?.title, "task");
  });

  it("drops the model when a batch mixes models", () => {
    const update = extractOmpSubagentUpdate(
      taskCall({ rawInput: { tasks: [ALPHA, { ...BETA, model: "anthropic/claude-x" }] } }),
    );
    assert.isNull(update?.model);
  });

  it("maps the opening pending frame to running", () => {
    const update = extractOmpSubagentUpdate(
      taskCall({ rawInput: { tasks: [ALPHA] }, status: "pending" }),
    );
    assert.equal(update?.status, "running");
  });

  it("reports a terminal batch with its aggregate output", () => {
    const update = extractOmpSubagentUpdate(
      taskCall({
        rawInput: { tasks: [ALPHA, BETA] },
        status: "completed",
        detail: "ALPHA_OK BETA_OK",
      }),
    );
    assert.equal(update?.status, "completed");
    assert.equal(update?.result, "ALPHA_OK BETA_OK");
  });

  it("maps a failed batch to failed", () => {
    const update = extractOmpSubagentUpdate(
      taskCall({ rawInput: { tasks: [ALPHA] }, status: "failed", detail: "boom" }),
    );
    assert.equal(update?.status, "failed");
    assert.equal(update?.result, "boom");
  });

  it("ignores unrelated tool calls", () => {
    const toolCall = taskCall({ name: "bash", rawInput: { command: "pnpm test" } });
    assert.equal(isOmpSubagentTool(toolCall), false);
    assert.equal(extractOmpSubagentUpdate(toolCall), undefined);
  });

  it("ignores a task-shaped payload from another tool", () => {
    const toolCall = taskCall({ name: "todo", rawInput: { task: "write tests" } });
    assert.equal(extractOmpSubagentUpdate(toolCall), undefined);
  });

  it("does not invent a subagent for an empty or malformed batch", () => {
    assert.equal(extractOmpSubagentUpdate(taskCall({ rawInput: { tasks: [] } })), undefined);
    assert.equal(extractOmpSubagentUpdate(taskCall({ rawInput: { tasks: [{}] } })), undefined);
    assert.equal(extractOmpSubagentUpdate(taskCall({ rawInput: {} })), undefined);
    assert.equal(extractOmpSubagentUpdate(taskCall({ name: "task" })), undefined);
  });
});
