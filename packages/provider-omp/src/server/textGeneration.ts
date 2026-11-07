import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { TextGenerationError } from "@t3tools/contracts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import type { OmpSettings } from "../settings.ts";
import { ompProfileArgs, resolveOmpLaunchArgs, resolveOmpProfile } from "./launchArgs.ts";
import { makeOmpRpcConnection } from "./rpc.ts";

const OMP_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

function recordString(record: unknown, key: string): string | undefined {
  return typeof record === "object" &&
    record !== null &&
    typeof (record as Record<string, unknown>)[key] === "string"
    ? ((record as Record<string, unknown>)[key] as string)
    : undefined;
}

export function parseOmpModelSlug(slug: string): { provider: string; modelId: string } | null {
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator === slug.length - 1) return null;
  return { provider: slug.slice(0, separator), modelId: slug.slice(separator + 1) };
}

export function buildOmpTextGenerationArgs(input: {
  readonly profile: string | undefined;
  readonly launchArgs: ReadonlyArray<string>;
  readonly model: string;
}): ReadonlyArray<string> {
  return [
    ...ompProfileArgs(input.profile),
    "--mode",
    "rpc",
    "--no-session",
    "--no-extensions",
    "--no-tools",
    ...input.launchArgs,
    ...(input.model === "default" ? [] : ["--model", input.model]),
  ];
}

const ompTurnErrorDetail = (errorMessage: string | undefined) => {
  const status = errorMessage?.match(/^([45]\d\d)\b/)?.[1];
  return status === undefined
    ? "omp could not generate text: the model provider reported an error."
    : `omp could not generate text: the model provider returned HTTP ${status}.`;
};

export const makeOmpTextGeneration = Effect.fn("makeOmpTextGeneration")(function* (
  ompSettings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runOmpJson: TextGenerationOperations.Runner = Effect.fn("OmpTextGeneration.runOmpJson")(
    function* (request) {
      const { operation, cwd, prompt, modelSelection } = request;
      const profile = resolveOmpProfile(ompSettings.profile);
      if (!profile.ok)
        return yield* new TextGenerationError({ operation, detail: profile.message });
      const launchArgs = resolveOmpLaunchArgs(ompSettings.launchArgs);
      if (!launchArgs.ok) {
        return yield* new TextGenerationError({ operation, detail: launchArgs.message });
      }
      const model = modelSelection.model.trim() || "default";
      const connection = yield* makeOmpRpcConnection({
        command: ompSettings.binaryPath || "omp",
        args: buildOmpTextGenerationArgs({
          profile: profile.profile,
          launchArgs: launchArgs.args,
          model,
        }),
        cwd,
        env: environment,
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

      if (model !== "default") {
        const parsed = parseOmpModelSlug(model);
        if (parsed === null) {
          return yield* new TextGenerationError({
            operation,
            detail: `omp model '${model}' must use provider/model format.`,
          });
        }
        yield* connection
          .request({ type: "set_model", provider: parsed.provider, modelId: parsed.modelId })
          .pipe(
            Effect.mapError((error) =>
              error._tag === "OmpRpcError" && error.operation === "set_model"
                ? new TextGenerationError({
                    operation,
                    detail: `omp rejected model '${model}': ${error.detail ?? "unknown error"}.`,
                    cause: error,
                  })
                : error,
            ),
          );
      }

      yield* connection.request({ type: "prompt", message: prompt });
      let turnError: string | undefined;
      yield* Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(connection.events);
          if (event["type"] === "session_settled") return;
          if (event["type"] === "prompt_result") {
            const status = recordString(event, "status");
            if (status === "error" || status === "aborted") {
              turnError =
                recordString(event["error"], "message") ??
                recordString(event, "error") ??
                turnError;
              return;
            }
          }
          const message = event["message"];
          if (event["type"] === "message_end" && recordString(message, "role") === "assistant") {
            turnError =
              recordString(message, "stopReason") === "error"
                ? ompTurnErrorDetail(recordString(message, "errorMessage"))
                : undefined;
          }
        }
      });
      const data = yield* connection.request({ type: "get_last_assistant_text" });
      const text =
        typeof data === "object" &&
        data !== null &&
        typeof (data as { text?: unknown }).text === "string"
          ? (data as { text: string }).text.trim()
          : "";
      if (!text) {
        return yield* new TextGenerationError({
          operation,
          detail: turnError ?? "omp returned empty output.",
        });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "omp", text);
    },
    (effect, request) => {
      const { operation } = request;
      return effect.pipe(
        Effect.timeoutOption(OMP_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(new TextGenerationError({ operation, detail: "omp request timed out." })),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "omp text generation failed.",
                cause,
              }),
        ),
        Effect.scoped,
      );
    },
  );

  return TextGenerationOperations.fromRunner(
    "OmpTextGeneration",
    TextGenerationOperations.withoutInvestigation("omp", runOmpJson),
  );
});
