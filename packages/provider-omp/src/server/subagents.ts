import type { AcpAdapterV2SubagentUpdate } from "@t3tools/provider-acp/server/adapter";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const entry = value[key];
  return typeof entry === "string" && entry.trim().length > 0 ? entry.trim() : undefined;
}

function taskInput(toolCall: AcpToolCallState): Record<string, unknown> | undefined {
  const rawInput = isRecord(toolCall.data.rawInput) ? toolCall.data.rawInput : undefined;
  if (rawInput === undefined) return undefined;
  const task = recordString(rawInput, "task");
  const taskFile = recordString(rawInput, "taskFile");
  if (task === undefined && taskFile === undefined) return undefined;
  return rawInput;
}

export function isOmpSubagentTool(toolCall: AcpToolCallState): boolean {
  return taskInput(toolCall) !== undefined;
}

export function extractOmpSubagentUpdate(
  toolCall: AcpToolCallState,
): AcpAdapterV2SubagentUpdate | undefined {
  const rawInput = taskInput(toolCall);
  if (rawInput === undefined) return undefined;
  const prompt = recordString(rawInput, "task") ?? recordString(rawInput, "taskFile") ?? "";
  const title = recordString(rawInput, "name") ?? recordString(rawInput, "agent") ?? null;
  const model = recordString(rawInput, "model") ?? null;
  const status =
    toolCall.status === "completed"
      ? "completed"
      : toolCall.status === "failed"
        ? "failed"
        : toolCall.status === "pending"
          ? "pending"
          : "running";
  return {
    nativeTaskId: toolCall.toolCallId,
    prompt,
    title,
    model,
    status,
    childSessionId: null,
    result: status === "completed" || status === "failed" ? (toolCall.detail ?? null) : null,
    suppressNormalTool: true,
  };
}
