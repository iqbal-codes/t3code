import type {
  OrchestrationV2UserInputQuestion,
  ProviderUserInputAnswers,
} from "@t3tools/contracts";
import type { AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";
import type * as EffectAcpSchema from "effect-acp/compat";

interface OptionEntry {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

interface ParsedQuestion {
  readonly question: OrchestrationV2UserInputQuestion;
  readonly companionId: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionEntries(value: unknown): ReadonlyArray<OptionEntry> {
  if (!Array.isArray(value)) return [];
  const options: Array<OptionEntry> = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const optionValue = stringValue(entry["const"]);
    const label = stringValue(entry["title"]) ?? optionValue;
    if (optionValue === undefined || label === undefined) continue;
    const description = stringValue(entry["description"]);
    options.push({
      value: optionValue,
      label,
      ...(description === undefined ? {} : { description }),
    });
  }
  return options;
}

function questionFromProperty(
  id: string,
  property: unknown,
  fallbackQuestion: string,
): ParsedQuestion | undefined {
  if (!isRecord(property)) return undefined;
  const type = stringValue(property["type"]);
  const multiSelect = type === "array";
  const options = multiSelect
    ? optionEntries(isRecord(property["items"]) ? property["items"]["anyOf"] : undefined)
    : optionEntries(property["oneOf"]);
  if (options.length === 0 && type !== "string") return undefined;

  const title = stringValue(property["title"]) ?? fallbackQuestion;
  const description = stringValue(property["description"]);
  const companionId = id.endsWith("__other") ? undefined : `${id}__other`;
  const defaultAnswer = stringValue(property["default"]);
  const initialAnswer = options.find(
    (option) => option.value === defaultAnswer || option.label === defaultAnswer,
  )?.value;
  const question: OrchestrationV2UserInputQuestion = {
    id,
    header: description ?? title,
    question: title,
    options: options.map((option) => ({
      label: option.label,
      description: option.description ?? option.label,
      value: option.value,
    })),
    ...(multiSelect ? { multiSelect: true } : {}),
    allowCustomAnswer: true,
    ...(initialAnswer === undefined ? {} : { initialAnswer }),
  };
  // A custom answer is only meaningful when omp supplied its companion field.
  return { question, companionId };
}

/**
 * omp's `ask` dialog is a form with `q0`, `q0__other`, `q1`, ... properties.
 * Single-choice questions use `oneOf`; multi-choice use `items.anyOf`; the
 * `__other` companion carries free text. Other forms fall back to the shared
 * ACP extraction.
 */
export const extractOmpElicitationForm: NonNullable<
  AcpAdapterV2Flavor["extractElicitationForm"]
> = (request) => {
  if (request.mode !== "form" || !isRecord(request.requestedSchema)) return undefined;
  const properties = request.requestedSchema["properties"];
  if (!isRecord(properties)) return undefined;

  const keys = Object.keys(properties)
    .filter((key) => /^q(?:0|[1-9]\d*)$/.test(key))
    .sort((left, right) => Number(left.slice(1)) - Number(right.slice(1)));
  if (keys.length === 0) return undefined;

  const parsed: Array<ParsedQuestion> = [];
  for (const key of keys) {
    const question = questionFromProperty(key, properties[key], request.message);
    if (question === undefined) return undefined;
    parsed.push(question);
  }

  const hasCompanion = (id: string) => properties[`${id}__other`] !== undefined;
  const questions = parsed.map(({ question, companionId }) => ({
    ...question,
    allowCustomAnswer:
      question.options.length === 0 || (companionId !== undefined && hasCompanion(question.id)),
  }));

  return {
    questions,
    respond: (answers: ProviderUserInputAnswers): EffectAcpSchema.CreateElicitationResponse => {
      const content: Record<string, string | ReadonlyArray<string>> = {};
      for (const question of questions) {
        const raw = answers[question.id];
        const optionValues = new Set(
          question.options.flatMap((option) =>
            option.value === undefined ? [option.label] : [option.value, option.label],
          ),
        );
        const selected = (Array.isArray(raw) ? raw : [raw]).flatMap((value) => {
          if (typeof value !== "string") return [];
          const trimmed = value.trim();
          return trimmed.length === 0 || !optionValues.has(trimmed) ? [] : [trimmed];
        });
        const custom =
          typeof raw === "string" && raw.trim().length > 0 && !optionValues.has(raw.trim())
            ? raw.trim()
            : undefined;
        if (question.multiSelect === true) {
          if (selected.length === 0 && custom === undefined) return { action: "cancel" };
          content[question.id] = selected;
          if (custom !== undefined && question.allowCustomAnswer !== false) {
            content[`${question.id}__other`] = custom;
          }
          continue;
        }
        if (selected.length === 0 && custom === undefined) return { action: "cancel" };
        content[question.id] = selected[0] ?? custom!;
        if (custom !== undefined && question.allowCustomAnswer !== false) {
          content[`${question.id}__other`] = custom;
        }
      }
      return { action: "accept", content };
    },
  };
};
