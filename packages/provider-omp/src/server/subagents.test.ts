import { assert, describe, it } from "@effect/vitest";

import { extractOmpSubagentUpdate, isOmpSubagentTool } from "./subagents.ts";

describe("omp subagent detection", () => {
  it("maps the task tool into a subagent update", () => {
    const toolCall = {
      toolCallId: "task-1",
      title: "Delegate review",
      status: "inProgress" as const,
      data: {
        rawInput: {
          task: "Review the provider package",
          name: "review",
          agent: "reviewer",
          model: "openai/gpt-5.2",
        },
      },
    };

    assert.equal(isOmpSubagentTool(toolCall), true);
    assert.deepEqual(extractOmpSubagentUpdate(toolCall), {
      nativeTaskId: "task-1",
      prompt: "Review the provider package",
      title: "review",
      model: "openai/gpt-5.2",
      status: "running",
      childSessionId: null,
      result: null,
      suppressNormalTool: true,
    });
  });

  it("ignores unrelated tool calls", () => {
    const toolCall = {
      toolCallId: "bash-1",
      title: "Run tests",
      status: "completed" as const,
      data: { rawInput: { command: "pnpm test" } },
    };

    assert.equal(isOmpSubagentTool(toolCall), false);
    assert.equal(extractOmpSubagentUpdate(toolCall), undefined);
  });
});
