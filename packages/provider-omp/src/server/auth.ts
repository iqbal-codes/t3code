import type { ProviderAuthMethod, ProviderInstanceId } from "@t3tools/contracts";
import { ProviderSetupError } from "@t3tools/contracts";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { OmpSettings } from "../settings.ts";
import { ompProfileArgs, resolveOmpProfile } from "./launchArgs.ts";
import { parseOmpModelsStdout } from "./status.ts";

const AUTH_TERMINAL_ARGS = ["acp", "--acp-terminal-auth"] as const;
const VERIFY_TIMEOUT_MS = 20_000;

export const makeOmpAuth = Effect.fn("makeOmpAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: Pick<OmpSettings, "binaryPath" | "profile">;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly onChanged: (authenticated: boolean) => Effect.Effect<void, ProviderSetupError>;
}) {
  const pty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const failure = (operation: string, detail: string, cause?: unknown) =>
    new ProviderSetupError({
      instanceId: options.instanceId,
      operation,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  const methods: ReadonlyArray<ProviderAuthMethod> = [
    {
      id: "agent",
      name: "Use existing omp credentials",
      description: "Verify the provider keys and OAuth accounts already configured for omp.",
      type: "agent",
    },
    ...(Option.isSome(pty)
      ? [
          {
            id: "terminal",
            name: "Set up omp in terminal",
            description: "Open the omp TUI to add provider keys and sign in.",
            type: "terminal" as const,
          },
        ]
      : []),
  ];

  const verify = Effect.fn("OmpAuth.verify")(
    function* () {
      const profile = resolveOmpProfile(options.settings.profile);
      if (!profile.ok) return false;
      const command = options.settings.binaryPath || "omp";
      const result = yield* Effect.gen(function* () {
        const spawnCommand = yield* resolveSpawnCommand(
          command,
          [...ompProfileArgs(profile.profile), "models", "--json"],
          { env: options.environment },
        );
        return yield* spawnAndCollect(
          command,
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            env: options.environment,
            shell: spawnCommand.shell,
          }),
        );
      }).pipe(
        Effect.timeoutOption(VERIFY_TIMEOUT_MS),
        Effect.orElseSucceed(() => Option.none()),
      );
      if (Option.isNone(result) || result.value.code !== 0) return false;
      return (parseOmpModelsStdout(result.value.stdout)?.length ?? 0) > 0;
    },
    (effect) =>
      effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
  );

  const runTerminal = Effect.fn("OmpAuth.runTerminal")(function* (
    context: ProviderAuthFlow.ProviderAuthFlowContext,
  ) {
    const ptyService = Option.getOrUndefined(pty);
    if (ptyService === undefined) {
      return yield* failure("start", "Interactive provider login is unavailable here.");
    }
    const profile = resolveOmpProfile(options.settings.profile);
    if (!profile.ok) return yield* failure("start", profile.message);
    const command = options.settings.binaryPath || "omp";
    const exited = yield* Deferred.make<number>();
    const output = yield* Queue.sliding<string>(64);
    const terminal = yield* ptyService
      .spawn({
        shell: command,
        args: [...ompProfileArgs(profile.profile), ...AUTH_TERMINAL_ARGS],
        cwd: options.cwd ?? process.cwd(),
        cols: 100,
        rows: 30,
        env: options.environment,
      })
      .pipe(
        Effect.mapError((cause) =>
          failure("start", "Could not open the omp sign-in terminal.", cause),
        ),
      );
    const detachData = terminal.onData((data) => {
      Queue.offerUnsafe(output, data.slice(-16_384));
    });
    const detachExit = terminal.onExit(({ exitCode }) => {
      Deferred.doneUnsafe(exited, Effect.succeed(exitCode));
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        detachData();
        detachExit();
        try {
          terminal.kill();
        } catch {}
      }),
    );
    let transcript = "";
    let outputOffset = 0;
    const update = () =>
      context.setInteraction(
        { type: "terminal", id: "terminal", output: transcript, outputOffset },
        (response) =>
          response.type === "terminal"
            ? Effect.try({
                try: () => {
                  if (response.size) terminal.resize(response.size.cols, response.size.rows);
                  if (response.data) terminal.write(response.data);
                },
                catch: () => failure("respond", "The omp sign-in terminal is no longer available."),
              })
            : Effect.void,
      );
    yield* update();
    yield* Queue.take(output).pipe(
      Effect.flatMap((data) => {
        outputOffset += data.length;
        transcript = (transcript + data).slice(-16_384);
        return update();
      }),
      Effect.forever,
      Effect.forkScoped,
    );
    if ((yield* Deferred.await(exited)) !== 0) {
      return yield* failure("start", "The omp sign-in command did not finish successfully.");
    }
  });

  const authenticate = Effect.fn("OmpAuth.authenticate")(function* (
    methodId: string,
    context: ProviderAuthFlow.ProviderAuthFlowContext,
  ) {
    if (methodId === "agent") {
      if (!(yield* verify())) {
        return yield* failure(
          "start",
          "omp has no authenticated models. Use terminal setup to add a provider or sign in.",
        );
      }
      yield* options.onChanged(true);
      return yield* Effect.void;
    }
    if (methodId !== "terminal") {
      return yield* failure("start", "omp no longer advertises this sign-in method.");
    }
    yield* runTerminal(context).pipe(Effect.scoped);
    yield* context.verifying;
    if (!(yield* verify())) {
      return yield* failure(
        "verify",
        "omp finished signing in, but no authenticated models were found.",
      );
    }
    yield* options.onChanged(true);
    return yield* Effect.void;
  });

  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: { owner: "provider", key: `omp:${options.instanceId}` },
    methods: Effect.succeed(methods),
    defaultMethodId: "agent",
    refreshMethodsAfterAuth: true,
    authenticate,
    logout: Effect.fail(
      failure(
        "logout",
        "Sign out from omp directly with `omp auth-broker logout`, then refresh this provider.",
      ),
    ),
    timeoutMs: 300_000,
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
});
