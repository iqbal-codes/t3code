import { assert, describe, it } from "@effect/vitest";

import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
import { extractOmpProposedPlanMarkdown } from "./plan.ts";

const PLAN_MARKDOWN = [
  "# Add a dry-run flag",
  "",
  "## Approach",
  "",
  "1. Parse `--dry-run` in the CLI entrypoint.",
].join("\n");

function writeCall(input: {
  readonly path?: unknown;
  readonly content?: unknown;
  readonly name?: string;
}): AcpToolCallState {
  return {
    toolCallId: "write-1",
    data: {
      name: input.name ?? "write",
      rawInput: {
        ...(input.path === undefined ? {} : { path: input.path }),
        ...(input.content === undefined ? {} : { content: input.content }),
        i: "Writing plan artifact",
      },
    },
  };
}

describe("omp proposed plan extraction", () => {
  it("publishes the markdown written to a local plan artifact", () => {
    const toolCall = writeCall({
      path: "local://dry-run-flag-plan.md",
      content: PLAN_MARKDOWN,
    });
    assert.equal(extractOmpProposedPlanMarkdown(toolCall), PLAN_MARKDOWN);
  });

  it("accepts a plan artifact under a subpath", () => {
    const toolCall = writeCall({
      path: "local://plans/dry-run-flag-plan.md",
      content: PLAN_MARKDOWN,
    });
    assert.equal(extractOmpProposedPlanMarkdown(toolCall), PLAN_MARKDOWN);
  });

  it("ignores the proposal write that only carries a slug", () => {
    const toolCall = writeCall({ path: "xd://propose", content: "dry-run-flag" });
    assert.equal(extractOmpProposedPlanMarkdown(toolCall), undefined);
  });

  it("ignores session-local artifacts that are not plans", () => {
    const toolCall = writeCall({ path: "local://shared-notes.md", content: PLAN_MARKDOWN });
    assert.equal(extractOmpProposedPlanMarkdown(toolCall), undefined);
  });

  it("ignores workspace plan files", () => {
    const toolCall = writeCall({ path: "/repo/docs/dry-run-plan.md", content: PLAN_MARKDOWN });
    assert.equal(extractOmpProposedPlanMarkdown(toolCall), undefined);
  });

  it("ignores other tools and missing or empty content", () => {
    assert.equal(
      extractOmpProposedPlanMarkdown(
        writeCall({ path: "local://x-plan.md", content: PLAN_MARKDOWN, name: "edit" }),
      ),
      undefined,
    );
    assert.equal(
      extractOmpProposedPlanMarkdown(writeCall({ path: "local://x-plan.md" })),
      undefined,
    );
    assert.equal(
      extractOmpProposedPlanMarkdown(writeCall({ path: "local://x-plan.md", content: "   " })),
      undefined,
    );
    assert.equal(extractOmpProposedPlanMarkdown(writeCall({ content: PLAN_MARKDOWN })), undefined);
  });
});
