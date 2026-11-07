import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { OmpSettings } from "../settings.ts";
import { resolveOmpLaunchArgs, resolveOmpProfile } from "./launchArgs.ts";

const OmpScanState = Schema.Struct({ sessionId: Schema.mutableKey(Schema.String) });
const Usage = Schema.Struct({
  input: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  cacheRead: Schema.optional(Schema.Unknown),
  cacheWrite: Schema.optional(Schema.Unknown),
  reasoning: Schema.optional(Schema.Unknown),
  cost: Schema.optional(Schema.Struct({ total: Schema.Unknown })),
});
const Identity = { id: Schema.NonEmptyString, timestamp: Schema.String };
const Model = { provider: Schema.NonEmptyString, model: Schema.NonEmptyString };
const Entry = Schema.Union([
  Schema.Struct({ type: Schema.Literal("session"), id: Schema.NonEmptyString }),
  Schema.Struct({
    ...Identity,
    type: Schema.Literal("message"),
    message: Schema.Union([
      Schema.Struct({
        ...Model,
        role: Schema.Literal("assistant"),
        responseModel: Schema.optional(Schema.NonEmptyString),
        usage: Usage,
      }),
      Schema.Struct({ role: Schema.Literal("toolResult"), usage: Usage }),
    ]),
  }),
  Schema.Struct({
    ...Identity,
    ...Model,
    type: Schema.Literal("model_usage"),
    purpose: Schema.optional(Schema.String),
    role: Schema.optional(Schema.String),
    usage: Usage,
  }),
  Schema.Struct({ ...Identity, ...Model, type: Schema.Literal("usage"), usage: Usage }),
  Schema.Struct({
    ...Identity,
    type: Schema.Literals(["compaction", "branch_summary"]),
    usage: Usage,
  }),
]);
const decodeEntry = Schema.decodeUnknownOption(Entry);

function parseRecord(parsed: unknown, state: typeof OmpScanState.Type): readonly UsageRecord[] {
  const decoded = decodeEntry(parsed);
  if (Option.isNone(decoded)) return [];
  const entry = decoded.value;
  if (entry.type === "session") {
    state.sessionId = entry.id;
    return [];
  }
  const timestampMs = parseTimestampMs(entry.timestamp);
  if (timestampMs === null) return [];
  const source = entry.type === "message" ? entry.message : entry;
  const usage = source.usage;
  const rateModel =
    "model" in source
      ? "responseModel" in source
        ? (source.responseModel ?? source.model)
        : source.model
      : undefined;
  const model = "provider" in source ? `${source.provider}/${rateModel}` : "Tools/summaries";
  const outputTokens = tokenCount(usage.output);
  const totals = {
    uncachedInputTokens: tokenCount(usage.input),
    cachedInputTokens: tokenCount(usage.cacheRead),
    cacheCreationTokens: tokenCount(usage.cacheWrite),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(usage.reasoning)),
  };
  const cost = usage.cost?.total;
  const reportedCostUsd =
    typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null;
  if (totalTokens(totals) === 0 && reportedCostUsd === null) return [];
  return [
    {
      provider: "omp",
      timestampMs,
      model,
      ...(rateModel === undefined ? {} : { rateModel }),
      sessionId: state.sessionId,
      totals,
      reportedCostUsd,
      speed: "standard",
      dedupeKey: JSON.stringify(["omp", entry.id, entry.timestamp, model]),
    },
  ];
}

export const ompUsageFormat: TranscriptUsageFormat<typeof OmpScanState.Type> = {
  selectFields: {
    type: true,
    id: true,
    timestamp: true,
    provider: true,
    model: true,
    usage: true,
    message: { role: true, provider: true, model: true, responseModel: true, usage: true },
  },
  usageMarkers: ['"usage"', '"model_usage"', '"session"'],
  parseLine: (line, state) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return parseRecord(parsed, state);
  },
  parseProjected: parseRecord,
  state: { initial: () => ({ sessionId: "" }), schema: OmpScanState },
};

function launchSessionDir(launchArgs: string): string | undefined {
  const resolved = resolveOmpLaunchArgs(launchArgs);
  if (!resolved.ok) return undefined;
  let sessionDir: string | undefined;
  for (let index = 0; index < resolved.args.length; index += 1) {
    const arg = resolved.args[index];
    if (arg === "--session-dir") {
      sessionDir = resolved.args[index + 1] || undefined;
      break;
    }
  }
  return sessionDir;
}

function resolveOmpSessionsDir(
  environment: NodeJS.ProcessEnv,
  home: string,
  path: Path.Path,
  profile: string | undefined,
): string {
  if (profile === undefined) {
    const agentDir = environment.PI_CODING_AGENT_DIR?.trim();
    if (agentDir) return path.resolve(expandHomePath(agentDir, home), "sessions");
  }
  const configRoot = environment.PI_CONFIG_DIR?.trim() || ".omp";
  const root = path.resolve(home, expandHomePath(configRoot, home));
  return profile === undefined
    ? path.join(root, "agent", "sessions")
    : path.join(root, "profiles", profile, "agent", "sessions");
}

function envOmpProfile(environment: NodeJS.ProcessEnv): string | undefined {
  const profile = environment.OMP_PROFILE?.trim();
  return profile === undefined || profile === "" || profile === "default" ? undefined : profile;
}

export function resolveOmpSessionsDirForInstance(
  environment: NodeJS.ProcessEnv,
  home: string,
  path: Path.Path,
  profileSetting: string | undefined,
): string {
  const profile = resolveOmpProfile(profileSetting ?? "");
  return resolveOmpSessionsDir(
    environment,
    home,
    path,
    profile.ok ? profile.profile : envOmpProfile(environment),
  );
}

export const ompUsageReader: ProviderUsageReader<OmpSettings, Path.Path> = {
  kind: "transcripts",
  provider: "omp",
  format: ompUsageFormat,
  directories: Effect.fn("ompUsageReader.directories")(function* ({ config, environment }) {
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const platform = yield* HostProcess.Platform;
    const launchHome = (platform === "win32" ? environment.USERPROFILE : environment.HOME) || home;
    const profile = config === undefined ? undefined : resolveOmpProfile(config.profile);
    const resolvedProfile = profile?.ok === true ? profile.profile : envOmpProfile(environment);
    const sessionDirArg = config === undefined ? undefined : launchSessionDir(config.launchArgs);
    const launchDir =
      sessionDirArg === undefined ? undefined : expandHomePath(sessionDirArg, launchHome);
    const xdgData = environment.XDG_DATA_HOME?.trim();
    return [
      ...(launchDir !== undefined && path.isAbsolute(launchDir)
        ? [{ dir: path.resolve(launchDir) }]
        : []),
      ...(resolvedProfile === undefined && xdgData !== undefined
        ? [{ dir: path.resolve(expandHomePath(xdgData, launchHome), "omp", "sessions") }]
        : []),
      { dir: resolveOmpSessionsDir(environment, home, path, resolvedProfile) },
    ];
  }),
};
