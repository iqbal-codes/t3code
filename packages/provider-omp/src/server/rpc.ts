import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";

export class OmpRpcError extends Schema.TaggedError<OmpRpcError>()("OmpRpcError", {
  operation: Schema.String,
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `omp RPC ${this.operation} failed${this.detail === undefined ? "" : `: ${this.detail}`}.`;
  }
}

export class OmpRpcTimeoutError extends Schema.TaggedError<OmpRpcTimeoutError>()(
  "OmpRpcTimeoutError",
  {
    operation: Schema.String,
    timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  },
) {
  override get message(): string {
    return `omp RPC ${this.operation} failed: timed out after ${this.timeoutMs}ms.`;
  }
}

export type OmpRpcRecord = Record<string, unknown>;

export interface OmpRpcSpawnOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string | undefined;
  readonly env: NodeJS.ProcessEnv;
}

export interface OmpRpcConnection {
  readonly send: (record: OmpRpcRecord) => Effect.Effect<void, OmpRpcError>;
  readonly request: (
    record: OmpRpcRecord,
    timeoutMs?: number,
  ) => Effect.Effect<unknown, OmpRpcError | OmpRpcTimeoutError>;
  readonly events: Queue.Queue<OmpRpcRecord, OmpRpcError>;
  readonly exited: Effect.Effect<number, OmpRpcError>;
  readonly terminate: Effect.Effect<void>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE = Duration.seconds(1);
const MAX_RECORD_CHARS = 8 * 1024 * 1024;

interface PendingRequest {
  readonly deferred: Deferred.Deferred<unknown, OmpRpcError>;
}

function makeJsonlFramer() {
  let buffer = "";
  let dropping = false;
  return (chunk: string) => {
    const lines: string[] = [];
    const droppedLengths: number[] = [];
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf("\n", start);
      const end = newline < 0 ? chunk.length : newline;
      if (!dropping) {
        if (buffer.length + end - start > MAX_RECORD_CHARS) {
          droppedLengths.push(buffer.length + end - start);
          buffer = "";
          dropping = true;
        } else {
          buffer += chunk.slice(start, end);
        }
      }
      if (newline < 0) break;
      if (!dropping && buffer.length > 0) {
        lines.push(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
      }
      buffer = "";
      dropping = false;
      start = newline + 1;
    }
    return { lines, droppedLengths };
  };
}

const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const decodeJsonLine = Schema.decodeSync(UnknownFromJsonString);
const encodeJsonLine = Schema.encodeSync(UnknownFromJsonString);

function summarizeError(error: unknown): string {
  const text = typeof error === "string" ? error : JSON.stringify(error);
  if (text === undefined) return "unknown error";
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function parseRecord(line: string): OmpRpcRecord | undefined {
  try {
    const parsed: unknown = decodeJsonLine(line);
    return Predicate.isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const terminateProcess = Effect.fn("OmpRpc.terminateProcess")(function* (
  kill: (signal: NodeJS.Signals) => boolean,
  hasExited: () => boolean,
) {
  if (hasExited()) return;
  if (!kill("SIGTERM")) return;
  yield* Effect.sleep(TERMINATION_GRACE);
  if (hasExited()) return;
  kill("SIGKILL");
});

export const makeOmpRpcConnection = Effect.fnUntraced(function* (options: OmpRpcSpawnOptions) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const scope = yield* Effect.scope;

  const spawnCommand = yield* resolveSpawnCommand(options.command, [...options.args], {
    env: options.env,
  }).pipe(Effect.mapError((cause) => new OmpRpcError({ operation: "spawn", cause })));
  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: options.env,
        extendEnv: false,
        shell: spawnCommand.shell,
        detached: platform !== "win32",
        stdin: { stream: "pipe", endOnDone: false },
      }),
    )
    .pipe(Effect.mapError((cause) => new OmpRpcError({ operation: "spawn", cause })));

  let childExited = false;
  let diagnosingStdoutClose = false;

  const killProcessGroup = (signal: NodeJS.Signals): boolean => {
    try {
      if (platform === "win32") process.kill(Number(child.pid), signal);
      else signalProcessGroup(Number(child.pid), signal);
      return true;
    } catch {
      return false;
    }
  };
  const hasExited = (): boolean => {
    if (childExited) return true;
    try {
      if (platform === "win32") process.kill(Number(child.pid), 0);
      else signalProcessGroup(Number(child.pid), 0);
      return false;
    } catch {
      return true;
    }
  };
  const terminateWindowsTree = Effect.gen(function* () {
    if (hasExited()) return;
    const taskkill = yield* spawner.spawn(
      ChildProcess.make("taskkill", ["/PID", String(child.pid), "/T", "/F"]),
    );
    yield* taskkill.exitCode;
  }).pipe(Effect.scoped, Effect.ignore);
  const terminate =
    platform === "win32" ? terminateWindowsTree : terminateProcess(killProcessGroup, hasExited);
  yield* Scope.addFinalizer(scope, terminate.pipe(Effect.ignore, Effect.uninterruptible));

  const pendingRequests = new Map<string, PendingRequest>();
  const events = yield* Queue.unbounded<OmpRpcRecord, OmpRpcError>();
  const outgoing = yield* Queue.unbounded<Uint8Array, OmpRpcError>();
  const transportDown = yield* Deferred.make<never, OmpRpcError>();
  const exitDeferred = yield* Deferred.make<number, OmpRpcError>();
  let nextRequestId = 0;

  const failTransport = Effect.fn("OmpRpc.failTransport")(function* (error: OmpRpcError) {
    const claimed = yield* Deferred.fail(transportDown, error);
    if (!claimed) return;
    for (const [key, pending] of pendingRequests) {
      pendingRequests.delete(key);
      yield* Deferred.fail(pending.deferred, error);
    }
    yield* Queue.fail(outgoing, error);
    yield* Queue.fail(events, error);
  });

  const routeRecord = Effect.fnUntraced(function* (record: OmpRpcRecord) {
    if (record["type"] === "response" && typeof record["id"] === "string") {
      const pending = pendingRequests.get(record["id"]);
      if (pending !== undefined) {
        pendingRequests.delete(record["id"]);
        if (record["success"] === true) {
          yield* Deferred.succeed(pending.deferred, record["data"]);
        } else {
          yield* Deferred.fail(
            pending.deferred,
            new OmpRpcError({
              operation: String(record["command"] ?? "request"),
              detail: summarizeError(record["error"]),
              ...(record["error"] === undefined ? {} : { cause: record["error"] }),
            }),
          );
        }
        return;
      }
    }
    yield* Queue.offer(events, record);
  });

  yield* child.exitCode.pipe(
    Effect.matchEffect({
      onFailure: (cause) =>
        Deferred.fail(exitDeferred, new OmpRpcError({ operation: "exit", cause })),
      onSuccess: (code) =>
        Effect.suspend(() => {
          childExited = true;
          return Deferred.succeed(exitDeferred, Number(code));
        }),
    }),
    Effect.forkIn(scope),
  );

  yield* Effect.gen(function* () {
    const frame = makeJsonlFramer();
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          const { lines, droppedLengths } = frame(chunk);
          for (const length of droppedLengths) {
            yield* Effect.logWarning("Dropping oversized omp stdout record.", {
              recordLength: length,
              maxRecordLength: MAX_RECORD_CHARS,
            });
          }
          for (const line of lines) {
            const record = parseRecord(line);
            if (record !== undefined) yield* routeRecord(record);
          }
        }),
      ),
    );
    const flushed = frame("\n");
    for (const line of flushed.lines) {
      const record = parseRecord(line);
      if (record !== undefined) yield* routeRecord(record);
    }
  }).pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) => failTransport(new OmpRpcError({ operation: "read", cause })),
      onSuccess: Effect.fnUntraced(function* () {
        diagnosingStdoutClose = true;
        const polled = yield* Deferred.poll(exitDeferred);
        const maybeExitCode = Option.isSome(polled)
          ? yield* polled.value.pipe(
              Effect.asSome,
              Effect.orElseSucceed(() => Option.none<number>()),
            )
          : yield* Deferred.await(exitDeferred).pipe(
              Effect.timeoutOption(Duration.millis(250)),
              Effect.provideService(Clock.Clock, Clock.Clock.defaultValue()),
              Effect.orElseSucceed(() => Option.none<number>()),
            );
        return yield* failTransport(
          new OmpRpcError({
            operation: "read",
            detail: Option.isSome(maybeExitCode)
              ? `omp process exited with code ${maybeExitCode.value}`
              : "omp process closed stdout",
          }),
        );
      }),
    }),
    Effect.forkIn(scope),
  );

  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      chunk.trim().length === 0
        ? Effect.void
        : Effect.logDebug("omp stderr", { stderrLength: chunk.length }),
    ),
    Effect.ignore,
    Effect.forkIn(scope),
  );

  yield* Stream.fromQueue(outgoing).pipe(
    Stream.run(child.stdin),
    Effect.catchCause((cause) =>
      diagnosingStdoutClose
        ? Effect.void
        : failTransport(new OmpRpcError({ operation: "write", cause })),
    ),
    Effect.forkIn(scope),
  );

  const send = Effect.fnUntraced(function* (
    record: OmpRpcRecord,
  ): Effect.fn.Return<void, OmpRpcError> {
    const accepted = yield* Queue.offer(
      outgoing,
      new TextEncoder().encode(`${encodeJsonLine(record)}\n`),
    );
    if (!accepted) return yield* Deferred.await(transportDown);
  });

  const request = Effect.fn("OmpRpc.request")(function* (
    record: OmpRpcRecord,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Effect.fn.Return<unknown, OmpRpcError | OmpRpcTimeoutError> {
    const id = `t3-omp-${nextRequestId++}`;
    const deferred = yield* Deferred.make<unknown, OmpRpcError>();
    pendingRequests.set(id, { deferred });
    yield* send({ ...record, id }).pipe(
      Effect.tapError(() => Effect.sync(() => pendingRequests.delete(id))),
    );
    return yield* Effect.raceFirst(Deferred.await(deferred), Deferred.await(transportDown)).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(timeoutMs),
        orElse: () =>
          Effect.fail(
            new OmpRpcTimeoutError({
              operation: String(record["type"] ?? "request"),
              timeoutMs,
            }),
          ),
      }),
      Effect.onInterrupt(() => Effect.sync(() => pendingRequests.delete(id))),
      Effect.onError(() => Effect.sync(() => pendingRequests.delete(id))),
    );
  });

  return {
    send,
    request,
    events,
    exited: Deferred.await(exitDeferred),
    terminate: failTransport(
      new OmpRpcError({ operation: "terminate", detail: "omp process was stopped" }),
    ).pipe(Effect.andThen(terminate), Effect.ignore, Effect.uninterruptible),
  } satisfies OmpRpcConnection;
});
