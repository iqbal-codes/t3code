import { assert, describe, it } from "@effect/vitest";

import { ompProfileArgs, resolveOmpLaunchArgs, resolveOmpProfile } from "./launchArgs.ts";

describe("omp launch args", () => {
  it("resolves a profile and omits the default profile", () => {
    assert.deepEqual(resolveOmpProfile(""), { ok: true, profile: undefined });
    assert.deepEqual(resolveOmpProfile("default"), { ok: true, profile: undefined });
    assert.deepEqual(resolveOmpProfile(" work "), { ok: true, profile: "work" });
    assert.deepEqual(resolveOmpProfile("-bad"), {
      ok: false,
      message:
        "omp profile may contain only letters, numbers, dots, underscores, and dashes, and must start with a letter or number.",
    });
    assert.deepEqual(ompProfileArgs("work"), ["--profile", "work"]);
    assert.deepEqual(ompProfileArgs(undefined), []);
  });

  it("splits known equals-form arguments and keeps extension flags", () => {
    const resolved = resolveOmpLaunchArgs(
      "--config=/tmp/omp.yml --add-dir=/work --extension-flag=kept --model=anthropic/claude",
    );
    assert.isTrue(resolved.ok);
    if (!resolved.ok) return;
    assert.deepEqual(resolved.args, [
      "--config",
      "/tmp/omp.yml",
      "--add-dir",
      "/work",
      "--extension-flag=kept",
      "--model",
      "anthropic/claude",
    ]);
  });

  it("rejects T3-owned flags, positionals, and lone --provider", () => {
    assert.deepEqual(resolveOmpLaunchArgs("--mode rpc"), {
      ok: false,
      message: "omp launch argument '--mode' is controlled by T3 Code and cannot be overridden.",
    });
    assert.deepEqual(resolveOmpLaunchArgs("--approval-mode yolo"), {
      ok: false,
      message:
        "omp launch argument '--approval-mode' is controlled by T3 Code and cannot be overridden.",
    });
    assert.deepEqual(resolveOmpLaunchArgs("fix the build"), {
      ok: false,
      message: "omp launch arguments cannot include positional prompt 'fix'.",
    });
    assert.deepEqual(resolveOmpLaunchArgs("--provider anthropic"), {
      ok: false,
      message: "omp launch argument '--provider' requires '--model'.",
    });
    assert.deepEqual(resolveOmpLaunchArgs("--"), {
      ok: false,
      message: "omp launch arguments cannot include positional prompts.",
    });
  });

  it("requires a value for known value arguments", () => {
    assert.deepEqual(resolveOmpLaunchArgs("--config"), {
      ok: false,
      message: "omp launch argument '--config' requires a value.",
    });
  });
});
