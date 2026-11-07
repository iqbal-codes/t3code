import {
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { OmpSettings } from "../settings.ts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";

import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ProviderProbeResult,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import { ompProfileArgs, resolveOmpLaunchArgs, resolveOmpProfile } from "./launchArgs.ts";

const OMP_DRIVER_KIND = ProviderDriverKind.make("omp");

const OMP_PRESENTATION = {
  displayName: "omp",
  showInteractionModeToggle: true,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  reportsContextWindow: true,
} as const;

const MINIMUM_OMP_VERSION = "18.17.0";
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const MODEL_PROBE_TIMEOUT_MS = 20_000;
const OMP_DEFAULT_MODEL_SLUG = "default";
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

const OMP_DEFAULT_MODEL: ServerProviderModel = {
  slug: OMP_DEFAULT_MODEL_SLUG,
  name: "omp default",
  isCustom: false,
  isDefault: true,
  capabilities: EMPTY_CAPABILITIES,
};

const THINKING_LABELS: Readonly<Record<string, string>> = {
  off: "Off",
  auto: "Auto",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

function thinkingDescriptor(values: ReadonlyArray<string>) {
  return buildSelectOptionDescriptor({
    id: "thinking",
    label: "Thinking",
    options: values.map((value) => ({
      value,
      label: THINKING_LABELS[value] ?? value,
      ...(value === "auto" ? { isDefault: true } : {}),
    })),
  });
}

const OMP_CUSTOM_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    thinkingDescriptor(["off", "auto", "minimal", "low", "medium", "high", "xhigh", "max"]),
  ],
});

const OmpModelJson = Schema.Struct({
  provider: Schema.String,
  id: Schema.String,
  selector: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  reasoning: Schema.optional(Schema.Boolean),
  thinking: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
});
const OmpModelsJson = Schema.Struct({ models: Schema.Array(OmpModelJson) });
const decodeOmpModels = Schema.decodeUnknownOption(Schema.fromJsonString(OmpModelsJson));

export function parseOmpModelsStdout(
  stdout: string,
): ReadonlyArray<typeof OmpModelJson.Type> | undefined {
  return Option.map(decodeOmpModels(stdout.trim()), (decoded) => decoded.models).pipe(
    Option.getOrUndefined,
  );
}

function ompThinkingCapabilities(model: typeof OmpModelJson.Type): ModelCapabilities {
  if (model.reasoning !== true) return EMPTY_CAPABILITIES;
  const levels = (model.thinking ?? []).flatMap((level) => {
    const trimmed = level.trim();
    return trimmed.length === 0 ? [] : [trimmed];
  });
  if (levels.length === 0) return EMPTY_CAPABILITIES;
  const values = ["off", "auto", ...levels.filter((level) => level !== "off" && level !== "auto")];
  return createModelCapabilities({ optionDescriptors: [thinkingDescriptor(values)] });
}

export function ompModelsFromJson(
  models: ReadonlyArray<typeof OmpModelJson.Type>,
): ReadonlyArray<ServerProviderModel> {
  const seen = new Set<string>();
  const parsed: Array<ServerProviderModel> = [];
  for (const model of models) {
    const provider = model.provider.trim();
    const id = model.id.trim();
    if (provider.length === 0 || id.length === 0) continue;
    const slug = (model.selector?.trim() || `${provider}/${id}`).trim();
    if (slug.length === 0 || seen.has(slug)) continue;
    seen.add(slug);
    const name = model.name?.trim();
    parsed.push({
      slug,
      name: name === undefined || name.length === 0 ? slug : name,
      subProvider: provider,
      isCustom: false,
      capabilities: ompThinkingCapabilities(model),
    });
  }
  return parsed;
}

function ompModels(settings: OmpSettings, discovered: ReadonlyArray<ServerProviderModel> = []) {
  return providerModelsFromSettings(
    [OMP_DEFAULT_MODEL, ...discovered],
    settings.customModels,
    OMP_CUSTOM_MODEL_CAPABILITIES,
  );
}

function makeSnapshot(
  settings: OmpSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
  discovered?: ReadonlyArray<ServerProviderModel>,
): ServerProviderDraft {
  return buildServerProvider({
    driver: OMP_DRIVER_KIND,
    presentation: OMP_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: ompModels(settings, discovered),
    slashCommands: [COMPACT_SLASH_COMMAND],
    probe,
  });
}

export const buildInitialOmpProviderSnapshot = Effect.fn(
  "OmpProvider.buildInitialOmpProviderSnapshot",
)(function* (settings: OmpSettings): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  return makeSnapshot(settings, checkedAt, {
    installed: settings.enabled,
    version: null,
    status: "warning",
    auth: { status: "unknown" },
    message: settings.enabled
      ? "Checking omp CLI availability..."
      : "omp is disabled in T3 Code settings.",
  });
});

const runOmpCli = Effect.fn("OmpProvider.runOmpCli")(function* (
  settings: OmpSettings,
  profile: string | undefined,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) {
  const command = settings.binaryPath || "omp";
  const spawnCommand = yield* resolveSpawnCommand(command, [...ompProfileArgs(profile), ...args], {
    env: environment,
  });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  );
});

function ompAuth(discovered: ReadonlyArray<ServerProviderModel>): ServerProviderAuth {
  return discovered.length > 0
    ? { status: "authenticated", type: "omp" }
    : { status: "unauthenticated" };
}

export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);

  if (!settings.enabled) {
    return makeSnapshot(settings, checkedAt, {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "omp is disabled in T3 Code settings.",
    });
  }

  const profile = resolveOmpProfile(settings.profile);
  if (!profile.ok) {
    return makeSnapshot(settings, checkedAt, {
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: profile.message,
    });
  }
  const launchArgs = resolveOmpLaunchArgs(settings.launchArgs);
  if (!launchArgs.ok) {
    return makeSnapshot(settings, checkedAt, {
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: launchArgs.message,
    });
  }

  const versionResult = yield* runOmpCli(
    settings,
    profile.profile,
    ["--version"],
    environment,
  ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);
  if (Result.isFailure(versionResult) || Option.isNone(versionResult.success)) {
    const missing = Result.isFailure(versionResult) && isCommandMissingCause(versionResult.failure);
    return makeSnapshot(settings, checkedAt, {
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? "omp CLI (`omp`) is not installed or not on PATH. Install with `curl -fsSL https://omp.sh/install | sh` or `bun install -g @oh-my-pi/pi-coding-agent`."
        : "Failed or timed out while running `omp --version`.",
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return makeSnapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "omp CLI is installed but failed to run.",
    });
  }
  if (version === null) {
    return makeSnapshot(settings, checkedAt, {
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: `T3 Code could not determine the omp version. omp ${MINIMUM_OMP_VERSION} or newer is required.`,
    });
  }
  if (compareSemverVersions(version, MINIMUM_OMP_VERSION) < 0) {
    return makeSnapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: `omp ${version} is unsupported. Update to omp ${MINIMUM_OMP_VERSION} or newer.`,
    });
  }

  const modelsResult = yield* runOmpCli(
    settings,
    profile.profile,
    ["models", "--json"],
    environment,
  ).pipe(Effect.timeoutOption(MODEL_PROBE_TIMEOUT_MS), Effect.result);
  if (Result.isFailure(modelsResult) || Option.isNone(modelsResult.success)) {
    return makeSnapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
      message:
        "omp is available, but T3 Code could not refresh its models. The live session will retry startup.",
    });
  }
  const modelsOutput = modelsResult.success.value;
  if (modelsOutput.code !== 0) {
    return makeSnapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
      message:
        "omp is available, but `omp models --json` failed. The live session will retry startup.",
    });
  }
  const decoded = Option.getOrUndefined(decodeOmpModels(modelsOutput.stdout.trim()));
  if (decoded === undefined) {
    return makeSnapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
      message:
        "omp is available, but T3 Code could not read its model catalog. The live session will retry startup.",
    });
  }

  const discovered = ompModelsFromJson(decoded.models);
  const auth = ompAuth(discovered);
  return makeSnapshot(
    settings,
    checkedAt,
    {
      installed: true,
      version,
      status: auth.status === "authenticated" ? "ready" : "warning",
      auth,
      ...(auth.status === "authenticated"
        ? {}
        : {
            message:
              "omp has no authenticated models. Run `omp` in a terminal and use /login, or configure a provider API key.",
          }),
    },
    discovered,
  );
});
