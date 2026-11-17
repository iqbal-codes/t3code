import type { AcpAdapterV2SubagentUpdate } from "@t3tools/provider-acp/server/adapter";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";

const OMP_TASK_TOOL = "task";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const entry = value[key];
  return typeof entry === "string" && entry.trim().length > 0 ? entry.trim() : undefined;
}

interface OmpTaskItem {
  readonly prompt: string;
  readonly title: string | null;
  readonly model: string | null;
}

function taskItem(value: unknown): OmpTaskItem | undefined {
  const prompt = recordString(value, "task") ?? recordString(value, "taskFile");
  if (prompt === undefined) return undefined;
  return {
    prompt,
    title: recordString(value, "name") ?? recordString(value, "agent") ?? null,
    model: recordString(value, "model") ?? null,
  };
}

/**
 * omp switches its task tool to `{context, tasks}` once `task.batch` is on, which ACP
 * defaults to. A batch that does not fully parse stays a tool call rather than a
 * half-described subagent.
 */
function taskItems(rawInput: Record<string, unknown>): ReadonlyArray<OmpTaskItem> | undefined {
  if (Array.isArray(rawInput.tasks)) {
    const items = rawInput.tasks.map(taskItem);
    return items.length > 0 && items.every((item): item is OmpTaskItem => item !== undefined)
      ? items
      : undefined;
  }
  const single = taskItem(rawInput);
  return single === undefined ? undefined : [single];
}

function taskPrompt(context: string | undefined, items: ReadonlyArray<OmpTaskItem>): string {
  // One assignment reads as the child's own prompt; a batch names each assignment.
  const assignments =
    items.length === 1
      ? items[0]!.prompt
      : items
          .map((item) => (item.title === null ? item.prompt : `## ${item.title}\n${item.prompt}`))
          .join("\n\n");
  return context === undefined ? assignments : `# Shared context\n${context}\n\n${assignments}`;
}

function taskTitle(items: ReadonlyArray<OmpTaskItem>): string | null {
  const first = items.find((item) => item.title !== null)?.title ?? null;
  if (first === null) return null;
  return items.length === 1 ? first : `${first} +${items.length - 1}`;
}

function taskModel(items: ReadonlyArray<OmpTaskItem>): string | null {
  const models = new Set(items.flatMap((item) => (item.model === null ? [] : [item.model])));
  return models.size === 1 ? ([...models][0] ?? null) : null;
}

function taskStatus(toolCall: AcpToolCallState): AcpAdapterV2SubagentUpdate["status"] {
  // A spawned subagent is running: ACP's opening `pending` frame is not a queued state here.
  switch (toolCall.status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "running";
  }
}

export function isOmpSubagentTool(toolCall: AcpToolCallState): boolean {
  return extractOmpSubagentUpdate(toolCall) !== undefined;
}

export function extractOmpSubagentUpdate(
  toolCall: AcpToolCallState,
): AcpAdapterV2SubagentUpdate | undefined {
  if (toolCall.data.name !== OMP_TASK_TOOL) return undefined;
  const rawInput = isRecord(toolCall.data.rawInput) ? toolCall.data.rawInput : undefined;
  if (rawInput === undefined) return undefined;
  const items = taskItems(rawInput);
  if (items === undefined) return undefined;
  const status = taskStatus(toolCall);
  return {
    nativeTaskId: toolCall.toolCallId,
    prompt: taskPrompt(recordString(rawInput, "context"), items),
    title: taskTitle(items),
    model: taskModel(items),
    status,
    childSessionId: null,
    result: status === "completed" || status === "failed" ? (toolCall.detail ?? null) : null,
    suppressNormalTool: true,
  };
}
