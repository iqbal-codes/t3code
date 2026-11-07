import { assert, describe, it } from "@effect/vitest";

import { buildOmpTextGenerationArgs, parseOmpModelSlug } from "./textGeneration.ts";

describe("omp text generation", () => {
  it("builds an isolated RPC launch", () => {
    assert.deepEqual(
      buildOmpTextGenerationArgs({
        profile: "work",
        launchArgs: ["--config", "/tmp/omp.yml"],
        model: "anthropic/claude-sonnet-5",
      }),
      [
        "--profile",
        "work",
        "--mode",
        "rpc",
        "--no-session",
        "--no-extensions",
        "--no-tools",
        "--config",
        "/tmp/omp.yml",
        "--model",
        "anthropic/claude-sonnet-5",
      ],
    );
    assert.deepEqual(
      buildOmpTextGenerationArgs({ profile: undefined, launchArgs: [], model: "default" }),
      ["--mode", "rpc", "--no-session", "--no-extensions", "--no-tools"],
    );
  });

  it("splits provider/model slugs", () => {
    assert.deepEqual(parseOmpModelSlug("anthropic/claude-sonnet-5"), {
      provider: "anthropic",
      modelId: "claude-sonnet-5",
    });
    assert.deepEqual(parseOmpModelSlug("openai/gpt-5.2"), {
      provider: "openai",
      modelId: "gpt-5.2",
    });
    assert.isNull(parseOmpModelSlug("default"));
    assert.isNull(parseOmpModelSlug("/model"));
    assert.isNull(parseOmpModelSlug("provider/"));
  });
});
