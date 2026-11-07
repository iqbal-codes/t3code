import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { OmpSettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import {
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { normalizeOmpCommands, withOmpBuiltinSlashCommands } from "./commands.ts";
import { discoverOmpSkills } from "./skills.ts";
import { makeOmpAuth } from "./auth.ts";
import { makeOmpAdapterV2Driver, type OmpAdapterV2DriverEnv } from "./adapter.ts";
import { buildInitialOmpProviderSnapshot, checkOmpProviderStatus } from "./status.ts";
import { makeOmpTextGeneration } from "./textGeneration.ts";
import { ompUsageReader } from "./usage.ts";

const DRIVER_KIND = ProviderDriverKind.make("omp");
const decodeOmpSettings = Schema.decodeSync(OmpSettings);
const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@oh-my-pi/pi-coding-agent",
  nativeUpdate: { args: ["update"] },
});

export type OmpDriverEnv =
  | OmpAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | Path.Path;

const enrichOmpSnapshot = Effect.fn("OmpProvider.enrichOmpSnapshot")(
  function* (input: {
    readonly snapshot: ServerProvider;
    readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
    readonly enableProviderUpdateChecks?: boolean;
    readonly liveCommands: Ref.Ref<ReadonlyArray<ServerProviderSlashCommand>>;
    readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  }) {
    const commands = yield* Ref.get(input.liveCommands);
    const merged = {
      ...input.snapshot,
      slashCommands: withOmpBuiltinSlashCommands([...input.snapshot.slashCommands, ...commands]),
    };
    const enriched = yield* enrichProviderSnapshotWithVersionAdvisory(
      merged,
      input.maintenanceCapabilities,
      { enableProviderUpdateChecks: input.enableProviderUpdateChecks },
    );
    yield* input.publishSnapshot(enriched);
  },
  (effect) =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("omp provider snapshot enrichment failed", { cause }),
      ),
      Effect.asVoid,
    ),
);

export const OmpDriver: ProviderDriver<OmpSettings, OmpDriverEnv, Path.Path> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "omp",
    supportsMultipleInstances: true,
  },
  usage: ompUsageReader,
  configSchema: OmpSettings,
  defaultConfig: (): OmpSettings => decodeOmpSettings({}),
  create: Effect.fn("OmpDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const httpClient = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const processEnv = yield* mergeProviderInstanceEnvironment(
      environment,
      yield* HostProcess.Environment,
    );
    const effectiveConfig = { ...config, enabled } satisfies OmpSettings;
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
      resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
      ),
    );
    const stampSnapshot = (snapshot: ServerProvider): ServerProvider => ({
      ...snapshot,
      setup: { canAuthenticate: true, canInstall: false },
      auth: { ...snapshot.auth, canLogout: false },
    });
    const liveCommands = yield* Ref.make<ReadonlyArray<ServerProviderSlashCommand>>([]);

    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OmpSettings>>({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialOmpProviderSnapshot(settings.provider).pipe(
          Effect.map(stampIdentity),
          Effect.map(stampSnapshot),
        ),
      checkProvider: checkOmpProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.map(stampSnapshot),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
      enrichSnapshot: Effect.fn("OmpDriver.enrichSnapshot")(
        function* ({ settings: snapshotSettingsValue, snapshot: current, publishSnapshot }) {
          const maintenanceCapabilities = yield* resolveMaintenance();
          yield* enrichOmpSnapshot({
            snapshot: stampSnapshot(current),
            maintenanceCapabilities,
            enableProviderUpdateChecks: snapshotSettingsValue.enableProviderUpdateChecks,
            liveCommands,
            publishSnapshot,
          });
        },
        (effect) =>
          effect.pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
          ),
      ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build omp snapshot.",
            cause,
          }),
      ),
    );

    const orchestrationAdapter = yield* makeOmpAdapterV2Driver({
      onAvailableCommands: (commands) =>
        Ref.set(liveCommands, normalizeOmpCommands(commands)).pipe(
          Effect.andThen(snapshot.refresh),
          Effect.ignore,
        ),
    })
      .create({ instanceId, displayName, accentColor, environment, enabled, config })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build omp orchestration adapter.",
              cause,
            }),
        ),
      );

    const auth = yield* makeOmpAuth({
      instanceId,
      settings: effectiveConfig,
      environment: processEnv,
      onChanged: () =>
        snapshot.refresh.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("omp snapshot refresh after sign-in failed", { cause }),
          ),
          Effect.asVoid,
        ),
    });

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      snapshotForCwd: (workspaceCwd) =>
        Effect.all([
          snapshot.getSnapshot,
          Ref.get(liveCommands),
          discoverOmpSkills(effectiveConfig, processEnv, workspaceCwd).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.catchCause((cause) =>
              Effect.logWarning("omp skill discovery failed", { cwd: workspaceCwd, cause }).pipe(
                Effect.as([]),
              ),
            ),
          ),
        ]).pipe(
          Effect.map(([machineSnapshot, commands, skills]) => ({
            ...machineSnapshot,
            slashCommands: withOmpBuiltinSlashCommands([
              ...machineSnapshot.slashCommands,
              ...commands,
            ]),
            slashCommandsPending: false,
            skills,
          })),
        ),
      orchestrationAdapter,
      auth,
      textGeneration: yield* makeOmpTextGeneration(effectiveConfig, processEnv),
    } satisfies ProviderInstance;
  }),
};
