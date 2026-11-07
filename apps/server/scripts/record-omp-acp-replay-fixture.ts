/**
 * Records an omp ACP replay transcript through the real orchestrator and
 * OmpAdapterV2, teeing only the protocol logger. Run from apps/server, signed in
 * with `omp`, with `omp` on PATH (or T3_OMP_BIN):
 *   node scripts/record-omp-acp-replay-fixture.ts --scenario simple
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProviderReplayEntry } from "@t3tools/contracts";
import { OmpSettings } from "@t3tools/provider-omp/settings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Config from "effect/Config";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as EffectAcpProtocol from "effect-acp/protocol";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { OMP_PROVIDER, makeOmpAdapterV2, makeOmpAcpRuntime } from "@t3tools/provider-omp/testing";
import { ACP_PROTOCOL } from "@t3tools/provider-acp/server/adapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../src/orchestration-v2/ProviderAdapterRegistry.ts";
import { provideDeterministicTestRuntime } from "../src/orchestration-v2/testkit/DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "../src/orchestration-v2/testkit/fixtures/index.ts";
import { materializeFixtureInput } from "../src/orchestration-v2/testkit/fixtures/shared.ts";
import { runOrchestratorV2Scenario } from "../src/orchestration-v2/testkit/OrchestratorScenario.ts";
import * as ProviderReplayHarness from "../src/orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

const wallClock = Clock.Clock.defaultValue();
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

// omp broadcasts T3 never reads. They carry the user's command catalog,
// compaction progress and extension state; the client ignores them.
const DROPPED_INBOUND_METHODS = new Set(["_omp/compaction/start", "_omp/compaction/end"]);
const HOME_PLACEHOLDER = "/home/omp-replay";

interface JsonRpcMessage {
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

type WireMessage =
  | { readonly direction: "incoming" | "outgoing"; readonly message: JsonRpcMessage }
  /** One ACP process ended and the adapter spawned the next (an idle release). */
  | { readonly direction: "respawn" };

function readArgValues(name: string): ReadonlyArray<string> {
  const args = process.argv.slice(2);
  return args.flatMap((arg, index) => (arg === name && args[index + 1] ? [args[index + 1]!] : []));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, map));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, mapStrings(entry, map)]),
  );
}

/**
 * Tees raw ACP lines in wire order. A later process (the idle release the
 * resume fixture forces) is marked as a respawn, which replay turns into a
 * fresh replay agent that continues the transcript.
 */
function makeWireTee() {
  const wire: Array<WireMessage> = [];
  let runtimeCount = 0;
  const attachRuntime = () => {
    runtimeCount += 1;
    if (runtimeCount > 1) wire.push({ direction: "respawn" });
    let incomingBuffer = "";
    const push = (direction: WireMessage["direction"], line: string) => {
      if (line.trim().length === 0) return;
      wire.push({ direction, message: decodeJson(line) as JsonRpcMessage });
    };
    return {
      logIncoming: true,
      logOutgoing: true,
      logger: (event: EffectAcpProtocol.AcpProtocolLogEvent) =>
        Effect.sync(() => {
          if (event.stage !== "raw" || typeof event.payload !== "string") return;
          if (event.direction === "outgoing") {
            for (const line of event.payload.split("\n")) push("outgoing", line);
            return;
          }
          incomingBuffer += event.payload;
          const lines = incomingBuffer.split("\n");
          incomingBuffer = lines.pop() ?? "";
          for (const line of lines) push("incoming", line);
        }),
    };
  };
  // omp settles every turn through the session/prompt response, so it is
  // done once each prompt T3 sent has been answered.
  const ompHasPendingWork = () => {
    const pending = new Set<string>();
    for (const wireMessage of wire) {
      if (wireMessage.direction === "respawn") {
        pending.clear();
        continue;
      }
      const { direction, message } = wireMessage;
      if (direction === "outgoing" && message.method === "session/prompt") {
        pending.add(String(message.id));
      } else if (direction === "incoming" && message.method === undefined) {
        pending.delete(String(message.id));
      }
    }
    return pending.size > 0;
  };
  return { wire, attachRuntime, ompHasPendingWork };
}

function frameLabel(kind: string, method: string, params: unknown): string {
  const update = isRecord(params) && isRecord(params.update) ? params.update : undefined;
  const updateType = typeof update?.sessionUpdate === "string" ? `:${update.sessionUpdate}` : "";
  return `${kind}:${method}${updateType}`;
}

/** Pairs JSON-RPC ids with their methods and emits the logical frames acp-replay-agent reads. */
function wireToEntries(wire: ReadonlyArray<WireMessage>): {
  readonly entries: Array<ProviderReplayEntry>;
  readonly droppedFrames: number;
} {
  const entries: Array<ProviderReplayEntry> = [];
  const t3Requests = new Map<string, string>();
  const agentRequests = new Map<string, string>();
  let droppedFrames = 0;
  for (const wireMessage of wire) {
    if (wireMessage.direction === "respawn") {
      // JSON-RPC ids restart with the process.
      t3Requests.clear();
      agentRequests.clear();
      entries.push({ type: "runtime_exit", status: "success" });
      continue;
    }
    const { direction, message } = wireMessage;
    const type = direction === "outgoing" ? "expect_outbound" : "emit_inbound";
    if (typeof message.method === "string") {
      if (direction === "incoming" && DROPPED_INBOUND_METHODS.has(message.method)) {
        droppedFrames += 1;
        continue;
      }
      const messageParams = isRecord(message.params) ? message.params : undefined;
      const update =
        messageParams !== undefined && isRecord(messageParams.update)
          ? messageParams.update
          : undefined;
      if (
        direction === "incoming" &&
        message.method === "session/update" &&
        update?.sessionUpdate === "available_commands_update"
      ) {
        droppedFrames += 1;
        continue;
      }
      const isRequest = message.id !== undefined && message.id !== null;
      if (isRequest) {
        (direction === "outgoing" ? t3Requests : agentRequests).set(
          String(message.id),
          message.method,
        );
      }
      const kind = isRequest ? "request" : "notification";
      entries.push({
        type,
        label: frameLabel(kind, message.method, message.params),
        frame: {
          kind,
          method: message.method,
          ...(message.params === undefined ? {} : { params: message.params }),
        },
      });
      continue;
    }
    const pending = direction === "outgoing" ? agentRequests : t3Requests;
    const method = pending.get(String(message.id));
    if (method === undefined) {
      // A response to a request T3 never saw; T3's protocol drops it, so replay
      // never sees it either.
      droppedFrames += 1;
      continue;
    }
    pending.delete(String(message.id));
    entries.push({
      type,
      label: `response:${method}`,
      frame: {
        kind: "response",
        method,
        ...(message.result === undefined ? {} : { result: message.result }),
        ...(message.error === undefined ? {} : { error: message.error }),
      },
    });
  }
  return { entries, droppedFrames };
}

/** Wildcards T3-owned request content; only the method and order are pinned. */
function normalizeOutboundFrame(
  frame: Record<string, unknown>,
  _runtimeInstructions: string,
): Record<string, unknown> {
  return { ...frame, params: "<any>" };
}

function normalizeInboundFrame(frame: Record<string, unknown>): Record<string, unknown> {
  return frame;
}

const OTHER_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;

/** Collects omp session ids in first-seen order. */
function collectSessionIds(entries: ReadonlyArray<ProviderReplayEntry>): ReadonlyArray<string> {
  const ids: Array<string> = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.length > 0 && !ids.includes(value)) ids.push(value);
  };
  for (const entry of entries) {
    if (entry.type === "runtime_exit" || !isRecord(entry.frame)) continue;
    const frame = entry.frame;
    if (frame.kind === "response" && frame.method === "session/new" && isRecord(frame.result)) {
      add(frame.result.sessionId);
    }
    if (entry.type === "emit_inbound" && isRecord(frame.params)) add(frame.params.sessionId);
  }
  return ids;
}

function normalizeEntries(input: {
  readonly entries: ReadonlyArray<ProviderReplayEntry>;
  readonly workspace: string;
  readonly home: string;
  readonly user: string;
  readonly runtimeInstructions: string;
}): Array<ProviderReplayEntry> {
  const sessionIds = collectSessionIds(input.entries);
  const replacements: Array<readonly [string, string]> = [
    ...sessionIds.map(
      (id, index) =>
        [id, `sess_00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`] as const,
    ),
    // omp's snapshot URIs carry paths URL-encoded once or twice
    // (`?originalPath%3D%252Fhome%252F…`); replace those forms first.
    // A HOME of "/" (root) or "" would replace every slash, method names included.
    ...[input.workspace, input.home].flatMap((path) => {
      if (path.length <= 1) return [];
      const once = encodeURIComponent(path);
      const twice = encodeURIComponent(once);
      const placeholder = path === input.workspace ? "<workspace>" : HOME_PLACEHOLDER;
      return [
        [twice, encodeURIComponent(encodeURIComponent(placeholder))] as const,
        [once, encodeURIComponent(placeholder)] as const,
      ];
    }),
    ...(input.workspace.length <= 1 ? [] : [[input.workspace, "<workspace>"] as const]),
    ...(input.home.length <= 1 ? [] : [[input.home, HOME_PLACEHOLDER] as const]),
  ];
  // omp's message and backend request ids, numbered in first-seen order.
  const otherIds: Array<string> = [];
  const numberOtherIds = (text: string) =>
    text.replace(OTHER_UUID, (id) => {
      if (id.startsWith("00000000-0000-4000-8000-")) return id;
      if (!otherIds.includes(id)) otherIds.push(id);
      return `00000000-0000-4000-9000-${String(otherIds.indexOf(id) + 1).padStart(12, "0")}`;
    });
  // Shell output (e.g. `ls -l`) names the recording user.
  const user = /^[a-z_][a-z0-9_-]*$/iu.test(input.user) ? input.user : "";
  const userPattern = user.length === 0 ? undefined : new RegExp(`\\b${user}\\b`, "gu");
  const replaceAll = (text: string) => {
    const replaced = replacements.reduce(
      (current, [from, to]) => (from.length === 0 ? current : current.replaceAll(from, to)),
      text,
    );
    const named =
      userPattern === undefined ? replaced : replaced.replace(userPattern, "omp-replay");
    return numberOtherIds(named);
  };
  return input.entries.map((entry) => {
    if (entry.type === "runtime_exit" || !isRecord(entry.frame)) return entry;
    const frame =
      entry.type === "expect_outbound"
        ? normalizeOutboundFrame(entry.frame, input.runtimeInstructions)
        : normalizeInboundFrame(entry.frame);
    return {
      ...entry,
      ...(entry.label === undefined ? {} : { label: replaceAll(entry.label) }),
      frame: mapStrings(frame, replaceAll),
    };
  });
}

const OMP_RECORDING_SETTINGS = Schema.decodeSync(OmpSettings)({
  enabled: true,
  binaryPath: process.env.T3_OMP_BIN ?? "omp",
  profile: "",
  launchArgs: "",
  customModels: [],
});

const RecorderEnv = Config.all({
  T3_OMP_VERSION: Config.String("T3_OMP_VERSION").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  HOME: Config.String("HOME").pipe(Config.option, Config.map(Option.getOrUndefined)),
  USER: Config.String("USER").pipe(Config.option, Config.map(Option.getOrUndefined)),
});

const recordScenario = Effect.fn("recordOmpScenario")(function* (fixtureName: string) {
  const recorderEnv = yield* RecorderEnv;
  const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find((candidate) => candidate.name === fixtureName);
  const variant = fixture?.providers.find((provider) => provider.driver === OMP_PROVIDER);
  if (fixture === undefined || variant === undefined) {
    return yield* Effect.die(new Error(`No omp replay fixture named '${fixtureName}'.`));
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fixtureInput = fixture.buildInput();
  // Same README and seeded files as the replay workspace, so client-mediated
  // fs reads answer identically at replay time.
  const workspace = yield* checkpointWorkspace(fixtureName, fixtureInput.workspaceFiles);
  const realWorkspace = yield* fs.realPath(workspace);
  const materialized = yield* materializeFixtureInput({
    scenario: fixtureName,
    fixtureInput,
    driver: OMP_PROVIDER,
    modelSelection: variant.modelSelection,
  }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
  const scenario = {
    name: `${fixtureName}/omp-record`,
    commands: materialized.commands,
    // Gated fixtures pace replay with gates on the test clock. Live, omp and
    // wall time pace themselves, so a fixture that gates records its
    // dispatches only and then waits for omp to idle.
    steps: materialized.steps.some(
      (step) =>
        step.type === "release_replay_gate" || step.type === "release_replay_gate_after_waiting",
    )
      ? materialized.steps.filter((step) => step.type === "dispatch")
      : materialized.steps.map((step) =>
          step.type === "finish_held_run" ? { ...step, type: "await_run_status" as const } : step,
        ),
    projectionThreadIds: materialized.projectionThreadIds,
    runtimePolicyOverride: { ...variant.runtimePolicyOverride, cwd: realWorkspace },
  };

  const tee = makeWireTee();
  const layerRegistry = ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.gen(function* () {
      const environment = yield* HostProcess.Environment;
      const adapter = yield* makeOmpAdapterV2({
        instanceId: variant.modelSelection.instanceId,
        settings: OMP_RECORDING_SETTINGS,
        environment,
        selfInvocation: yield* resolveSelfInvocation(),
        // Production's runtime factory, with the protocol logger teeing raw lines.
        makeRuntime: ({ runtimePolicy, processEnvironment, ...input }) =>
          makeOmpAcpRuntime({
            ...input,
            policy: runtimePolicy,
            profile: undefined,
            launchArgs: [],
            protocolLogging: tee.attachRuntime(),
            settings: OMP_RECORDING_SETTINGS,
            environment: { ...environment, ...processEnvironment },
          }),
      });
      // The scenario runs on the replay TestClock so its clock steps order
      // dispatches as replay will. omp itself runs on wall time, so the
      // adapter's session does too.
      const onWallClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.provideService(effect, Clock.Clock, wallClock);
      return [
        {
          ...adapter,
          openSession: (input) =>
            adapter.openSession(input).pipe(
              Effect.map((session): ProviderAdapter.ProviderAdapterV2SessionRuntime => ({
                ...session,
                startTurn: (turnInput) => onWallClock(session.startTurn(turnInput)),
                steerTurn: (turnInput) => onWallClock(session.steerTurn(turnInput)),
                interruptTurn: (turnInput) => onWallClock(session.interruptTurn(turnInput)),
                respondToRuntimeRequest: (turnInput) =>
                  onWallClock(session.respondToRuntimeRequest(turnInput)),
              })),
              onWallClock,
            ),
        },
      ];
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        TestProviderHost.layer().pipe(
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
        NodeServices.layer,
        NodeCrypto.layer,
        IdAllocator.layer,
      ),
    ),
  );

  // Same deterministic runtime as replay (TestClock, seeded ids), so the
  // scenario's clock steps order dispatches exactly as they will on replay.
  // The session stays open until every prompt is answered and omp has been
  // quiet for a few seconds, so the transcript holds everything replay emits.
  let quietPolls = 0;
  let seenFrames = -1;
  const waitForOmpIdle = Effect.sleep("1 second").pipe(
    Effect.andThen(
      Effect.sync(() => {
        quietPolls = seenFrames === tee.wire.length ? quietPolls + 1 : 0;
        seenFrames = tee.wire.length;
        return quietPolls >= 3 && !tee.ompHasPendingWork();
      }),
    ),
    Effect.repeat({ until: (idle) => idle }),
    Effect.timeout("5 minutes"),
    Effect.orDie,
    Effect.asVoid,
    Effect.provideService(Clock.Clock, wallClock),
  );
  const result = yield* runOrchestratorV2Scenario(scenario, { afterSteps: waitForOmpIdle }).pipe(
    Effect.provide(
      ProviderReplayHarness.layerWithRegistry(
        scenario,
        layerRegistry,
        variant.runContinuationWorker === true ? { runContinuationWorker: true } : {},
      ),
    ),
    provideDeterministicTestRuntime,
    Effect.scoped,
  );

  const { entries, droppedFrames } = wireToEntries(tee.wire);
  const closedCleanly = entries.some(
    (entry) =>
      entry.type === "expect_outbound" &&
      isRecord(entry.frame) &&
      entry.frame.method === "session/close",
  );
  const transcript = {
    provider: OMP_PROVIDER,
    protocol: ACP_PROTOCOL,
    version: "1",
    scenario: fixtureName,
    metadata: {
      generatedBy: "live-omp-recorder",
      ompVersion: recorderEnv.T3_OMP_VERSION ?? "unknown",
      normalization:
        "Session ids are fixed sess_ UUIDs and other UUIDs (message and request ids) are numbered in first-seen order, the workspace is <workspace>, HOME is /home/omp-replay and the recording user is omp-replay. T3-owned prompt text, MCP servers and initialize params other than clientCapabilities and _meta are <any>. omp's available command broadcasts and _omp/compaction/* notifications are removed. Timestamps are kept as recorded.",
      droppedFrames,
    },
    entries: [
      ...normalizeEntries({
        entries,
        workspace: realWorkspace,
        home: recorderEnv.HOME ?? "",
        user: recorderEnv.USER ?? "",
        runtimeInstructions: buildRuntimeInstructions({
          harness: "omp",
          model: variant.modelSelection.model,
        }),
      }),
      { type: "runtime_exit", status: closedCleanly ? "success" : "cancelled" } as const,
    ],
  };

  // The live orchestration must already satisfy the fixture's assertions
  // before anything is written, so a changed omp response can never replace
  // a good fixture with one that fails replay. `--force` writes it anyway to
  // inspect the frames.
  const liveFailure = (() => {
    try {
      variant.assertOutput(result, transcript);
      return undefined;
    } catch (cause) {
      return cause;
    }
  })();
  if (liveFailure !== undefined && !process.argv.includes("--force")) {
    return yield* Effect.die(
      new Error(`Live orchestration failed ${fixtureName} assertions; nothing was written.`, {
        cause: liveFailure,
      }),
    );
  }

  const outputPath = readArgValues("--out")[0] ?? (yield* path.fromFileUrl(variant.transcriptFile));
  const { entries: transcriptEntries, ...header } = transcript;
  yield* fs.writeFileString(
    outputPath,
    [
      encodeJson({ type: "transcript_start", ...header }),
      ...transcriptEntries.map((entry) => encodeJson(entry)),
      "",
    ].join("\n"),
  );
  yield* Console.log(`Wrote ${transcriptEntries.length} omp ACP replay entries to ${outputPath}`);
});

const scenarios = readArgValues("--scenario").flatMap((value) => value.split(","));
if (scenarios.length === 0) {
  throw new Error("Pass --scenario <fixture name>[,<fixture name>...]");
}
if (scenarios.length > 1 && readArgValues("--out").length > 0) {
  throw new Error("--out cannot be used with multiple scenarios; run them separately.");
}

await Effect.runPromise(
  Effect.forEach(scenarios, (name) => Effect.scoped(recordScenario(name)), {
    discard: true,
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
