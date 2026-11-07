import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import { OmpSettings } from "@t3tools/provider-omp/settings";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import type { ProviderReplayGate } from "@t3tools/provider-testing/replayGate";
import type { OrchestratorV2ProviderReplayHarness } from "../testkit/ProviderReplayHarness.ts";
import {
  type AcpReplayTranscript,
  AcpReplayTranscriptDecodeError,
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
} from "./AcpAdapterV2.testkit.ts";
import { OMP_PROVIDER, makeOmpAdapterV2 } from "@t3tools/provider-omp/testing";

const OMP_REPLAY_SETTINGS = Schema.decodeSync(OmpSettings)({ enabled: true });

function layerOmpProviderAdapterRegistryReplay(
  transcript: AcpReplayTranscript,
  options: { readonly replayGate?: ProviderReplayGate } = {},
) {
  const layerHost = TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

  return ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const replayDir = yield* fileSystem
        .makeTempDirectory({ prefix: `t3-orchestration-v2-omp-replay-${transcript.scenario}-` })
        .pipe(Effect.orDie);
      const statusPath = path.join(replayDir, "status.json");
      const scriptPath = yield* path
        .fromFileUrl(new URL("../../../scripts/acp-replay-agent.ts", import.meta.url))
        .pipe(Effect.orDie);
      const adapter = yield* makeOmpAdapterV2({
        instanceId: ProviderInstanceId.make("omp"),
        settings: OMP_REPLAY_SETTINGS,
        environment: {},
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: makeAcpReplayRuntime({
          transcript,
          statusPath,
          scriptPath,
          childProcessSpawner,
          fileSystem,
          ...(options.replayGate === undefined ? {} : { replayGate: options.replayGate }),
        }),
        assertComplete: makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript),
      });
      return [adapter];
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(layerHost, NodeServices.layer, NodeCrypto.layer, IdAllocator.layer),
    ),
    Layer.merge(
      Layer.effectDiscard(
        Effect.addFinalizer(() => Effect.sync(() => options.replayGate?.releaseAll())),
      ),
    ),
  );
}

export const OmpOrchestratorReplayHarness: OrchestratorV2ProviderReplayHarness<
  AcpReplayTranscript,
  AcpReplayTranscriptDecodeError
> = {
  driver: OMP_PROVIDER,
  decodeTranscript: (transcript) => decodeAcpReplayTranscript(transcript, OMP_PROVIDER),
  makeProviderAdapterRegistryLayer: layerOmpProviderAdapterRegistryReplay,
};
