import type { ProviderApprovalOption } from "@t3tools/contracts";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  acpPermissionDisposition,
  type AcpPermissionDisposition,
  type AcpRuntimePolicy,
} from "@t3tools/provider-acp/server/clientPolicy";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { OmpSettings } from "../settings.ts";
import { ompProfileArgs } from "./launchArgs.ts";

type OmpAcpRuntimeSettings = Pick<OmpSettings, "binaryPath">;

export function ompApprovalMode(policy: AcpRuntimePolicy): "always-ask" | "write" | "yolo" {
  const restricted = policy.approvalPolicy !== undefined || policy.sandboxPolicy !== undefined;
  switch (policy.runtimeMode) {
    case "full-access":
      return restricted ? "write" : "yolo";
    case "auto-accept-edits":
      return "write";
    default:
      return "always-ask";
  }
}

export function buildOmpAcpSpawnInput(input: {
  readonly settings: OmpAcpRuntimeSettings | null | undefined;
  readonly profile: string | undefined;
  readonly launchArgs: ReadonlyArray<string>;
  readonly policy: AcpRuntimePolicy;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
}): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: input.settings?.binaryPath || "omp",
    args: [
      ...ompProfileArgs(input.profile),
      "acp",
      "--approval-mode",
      ompApprovalMode(input.policy),
      "--append-system-prompt",
      T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim(),
      ...input.launchArgs,
    ],
    cwd: input.cwd,
    ...(input.environment === undefined ? {} : { env: input.environment }),
  };
}

/**
 * omp's ACP gate sends `allow_once` / `allow_always` / `reject_once` /
 * `reject_always`. `allow_always` lives in memory for the session
 * (`#acpPermissionDecisions`), so it maps to T3's session-scoped grant. The
 * `reject_always` variant is not offered: T3's decline covers one request.
 */
export function ompApprovalOptions(
  request: EffectAcpSchema.RequestPermissionRequest,
): ReadonlyArray<ProviderApprovalOption> {
  const option = (kind: EffectAcpSchema.PermissionOption["kind"]) =>
    request.options.find(
      (candidate) => candidate.kind === kind && candidate.optionId.trim().length > 0,
    );
  const allowOnce = option("allow_once");
  const allowAlways = option("allow_always");
  const rejectOnce = option("reject_once");
  return [
    ...(allowOnce === undefined ? [] : [{ decision: "accept", label: allowOnce.name } as const]),
    ...(allowAlways === undefined
      ? []
      : [{ decision: "acceptForSession", label: allowAlways.name } as const]),
    ...(rejectOnce === undefined ? [] : [{ decision: "decline", label: rejectOnce.name } as const]),
    { decision: "cancel", label: "Cancel" },
  ];
}

export function ompPermissionDisposition(
  policy: AcpRuntimePolicy,
  request: EffectAcpSchema.RequestPermissionRequest,
): AcpPermissionDisposition {
  return acpPermissionDisposition(policy, request);
}

export interface OmpAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly settings: OmpAcpRuntimeSettings | null | undefined;
  readonly profile: string | undefined;
  readonly launchArgs: ReadonlyArray<string>;
  readonly policy: AcpRuntimePolicy;
  readonly environment?: NodeJS.ProcessEnv;
}

export const makeOmpAcpRuntime = Effect.fn("OmpAcpSupport.makeOmpAcpRuntime")(function* (
  input: OmpAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
> {
  const { settings, profile, launchArgs, policy, environment, ...runtimeOptions } = input;
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...runtimeOptions,
      authMethodId: "agent",
      spawn: buildOmpAcpSpawnInput({
        settings,
        profile,
        launchArgs,
        policy,
        cwd: input.cwd,
        ...(environment === undefined ? {} : { environment }),
      }),
    }),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
});

export function ompLaunchError(message: string): EffectAcpErrors.AcpRequestError {
  return new EffectAcpErrors.AcpRequestError({
    code: -32602,
    errorMessage: message,
    method: "launch",
  });
}
