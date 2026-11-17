import type { AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";

const OMP_WRITE_TOOL = "write";

/** omp's plan-mode prompt writes the canonical plan to `local://<slug>-plan.md`. */
const OMP_PLAN_ARTIFACT = /^local:\/\/\S*-plan\.md$/iu;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const entry = value[key];
  return typeof entry === "string" ? entry : undefined;
}

/**
 * omp never sends its plan over ACP: the `plan` session update carries todo steps, and the
 * plan itself is a `write` to a session-local artifact. Publishing that write lets T3 show
 * the plan document and drive its own review instead of a truncated question.
 */
export const extractOmpProposedPlanMarkdown: NonNullable<
  AcpAdapterV2Flavor["extractProposedPlanMarkdown"]
> = (toolCall: AcpToolCallState) => {
  if (toolCall.data.name !== OMP_WRITE_TOOL) return undefined;
  const rawInput = isRecord(toolCall.data.rawInput) ? toolCall.data.rawInput : undefined;
  if (rawInput === undefined) return undefined;
  const path = recordString(rawInput, "path")?.trim();
  if (path === undefined || !OMP_PLAN_ARTIFACT.test(path)) return undefined;
  const markdown = recordString(rawInput, "content");
  return markdown === undefined || markdown.trim().length === 0 ? undefined : markdown;
};
