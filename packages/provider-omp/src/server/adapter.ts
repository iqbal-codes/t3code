import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import { ProviderDriverKind, type OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import { OmpSettings } from "../settings.ts";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import type * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { resolveOmpLaunchArgs, resolveOmpProfile } from "./launchArgs.ts";
import {
  makeOmpAcpRuntime,
  ompApprovalOptions,
  ompLaunchError,
  ompPermissionDisposition,
} from "./acpSupport.ts";
import { extractOmpElicitationForm } from "./elicitation.ts";
import { extractOmpSubagentUpdate, isOmpSubagentTool } from "./subagents.ts";

export const OMP_PROVIDER = ProviderDriverKind.make("omp");
const DEFAULT_OMP_SETTINGS = Schema.decodeSync(OmpSettings)({});

const OmpProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    // `--approval-mode` is a launch flag; T3 restarts the runtime on mode changes.
    supportsRuntimeModeSwitchInSession: false,
  },
  threads: {
    ...AcpProviderCapabilitiesV2.threads,
    // omp advertises `sessionCapabilities.fork`; it forks the whole session.
    canForkThread: true,
    canForkFromTurn: false,
  },
  turns: {
    ...AcpProviderCapabilitiesV2.turns,
    supportsInterrupt: true,
    supportsQueuedMessages: true,
    supportsActiveSteering: true,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
  planning: {
    ...AcpProviderCapabilitiesV2.planning,
    supportsStructuredQuestions: true,
    emitsPlanUpdated: false,
  },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
    emitsSubagentLifecycle: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

function ompPromptFailure(cause: unknown) {
  return makeProviderFailure({
    cause,
    ...(isAcpRequestError(cause) ? { message: cause.errorMessage, code: String(cause.code) } : {}),
    class: "provider_error",
  });
}

export interface OmpAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: OmpSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly onAvailableCommands?: (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
  ) => Effect.Effect<void>;
  /** Replaces the `omp acp` launch (replay tests). */
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
}

function customModelSlugs(settings: OmpSettings): ReadonlyArray<string> {
  return settings.customModels.flatMap((entry) =>
    typeof entry === "string" ? [entry] : [entry.slug],
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const entry = value[key];
  return typeof entry === "string" && entry.length > 0 ? entry : undefined;
}

function makeOmpAcpAdapterFlavor(options: OmpAdapterV2Options): AcpAdapterV2Flavor {
  let steerSequence = 0;
  const pendingSteerIds = new Map<string, string>();
  const makeRuntime =
    options.makeRuntime ??
    ((input: AcpAdapterV2RuntimeInput) => {
      const profile = resolveOmpProfile(options.settings.profile);
      if (!profile.ok) return Effect.fail(ompLaunchError(profile.message));
      const launchArgs = resolveOmpLaunchArgs(options.settings.launchArgs);
      if (!launchArgs.ok) return Effect.fail(ompLaunchError(launchArgs.message));
      const { runtimePolicy, processEnvironment, ...runtimeInput } = input;
      return makeOmpAcpRuntime({
        ...runtimeInput,
        settings: options.settings,
        environment: { ...options.environment, ...processEnvironment },
        profile: profile.profile,
        launchArgs: launchArgs.args,
        policy: runtimePolicy,
      });
    });
  return {
    driver: OMP_PROVIDER,
    runtimeHarness: "omp",
    capabilities: OmpProviderCapabilitiesV2,
    makeRuntime,
    customModels: customModelSlugs(options.settings),
    promptFailure: ompPromptFailure,
    approvalOptions: ompApprovalOptions,
    permissionDisposition: ompPermissionDisposition,
    extractElicitationForm: extractOmpElicitationForm,
    extractSubagentUpdate: extractOmpSubagentUpdate,
    isProvisionalSubagentTool: isOmpSubagentTool,
    // omp executes `/compact` as an ACP builtin, so no native compact request is needed.
    supportsCompaction: true,
    steering: {
      send: Effect.fn("OmpSteering.send")(function* (runtime, sessionId, text) {
        const result = yield* runtime.request("_session/steering", {
          sessionId,
          prompt: [{ type: "text", text }],
          _meta: { steering: { queue: "steering" } },
        });
        const outcome = recordString(result, "outcome");
        if (outcome !== "injected") {
          return yield* new EffectAcpErrors.AcpRequestError({
            code: -32603,
            method: "_session/steering",
            errorMessage:
              outcome === "promptRequired"
                ? "omp is not accepting steering for this turn."
                : `omp rejected steering: ${recordString(result, "reason") ?? outcome ?? "unknown"}`,
          });
        }
        const id = `omp-steer-${sessionId}-${++steerSequence}`;
        pendingSteerIds.set(sessionId, id);
        return id;
      }),
      injectedSteerId: (notification) => {
        const update = notification.update;
        if (
          update.sessionUpdate !== "agent_message_chunk" &&
          update.sessionUpdate !== "agent_thought_chunk" &&
          update.sessionUpdate !== "tool_call" &&
          update.sessionUpdate !== "tool_call_update" &&
          update.sessionUpdate !== "plan"
        ) {
          return undefined;
        }
        const id = pendingSteerIds.get(notification.sessionId);
        if (id === undefined) return undefined;
        pendingSteerIds.delete(notification.sessionId);
        return id;
      },
    },
    reportsPerTurnPromptUsage: true,
    ...(options.onAvailableCommands === undefined
      ? {}
      : { onAvailableCommandsUpdate: options.onAvailableCommands }),
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

export const makeOmpAdapterV2 = Effect.fn("makeOmpAdapterV2")(function* (
  options: OmpAdapterV2Options,
) {
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeOmpAcpAdapterFlavor(options),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
});

export type OmpAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const makeOmpAdapterV2Driver = (
  hooks: Pick<OmpAdapterV2Options, "onAvailableCommands"> = {},
): ProviderAdapterDriver<OmpSettings, OmpAdapterV2DriverEnv> => ({
  driverKind: OMP_PROVIDER,
  configSchema: OmpSettings,
  defaultConfig: (): OmpSettings => DEFAULT_OMP_SETTINGS,
  create: Effect.fn("OmpAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<OmpSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeOmpAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        selfInvocation,
        ...(hooks.onAvailableCommands === undefined
          ? {}
          : { onAvailableCommands: hooks.onAvailableCommands }),
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: OMP_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: OMP_PROVIDER,
              instanceId: input.instanceId,
              detail: "Failed to create omp ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
});
