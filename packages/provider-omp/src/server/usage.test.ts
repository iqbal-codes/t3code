import { assert, describe, it } from "@effect/vitest";

import { ompUsageFormat } from "./usage.ts";

const state = () => ({ sessionId: "" });

describe("omp transcript usage", () => {
  it("reads assistant message usage and omp model_usage entries", () => {
    const scan = state();
    assert.deepEqual(ompUsageFormat.parseLine('{"type":"session","id":"session-1"}', scan), []);
    const assistant = ompUsageFormat.parseLine(
      JSON.stringify({
        type: "message",
        id: "message-1",
        timestamp: "2026-11-06T00:00:00.000Z",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-5",
          usage: {
            input: 100,
            output: 20,
            cacheRead: 30,
            cacheWrite: 4,
            reasoning: 5,
            cost: { total: 0.02 },
          },
        },
      }),
      scan,
    );
    assert.deepEqual(assistant, [
      {
        provider: "omp",
        timestampMs: Date.parse("2026-11-06T00:00:00.000Z"),
        model: "anthropic/claude-sonnet-5",
        rateModel: "claude-sonnet-5",
        sessionId: "session-1",
        totals: {
          uncachedInputTokens: 100,
          cachedInputTokens: 30,
          cacheCreationTokens: 4,
          outputTokens: 20,
          reasoningTokens: 5,
        },
        reportedCostUsd: 0.02,
        speed: "standard",
        dedupeKey: JSON.stringify([
          "omp",
          "message-1",
          "2026-11-06T00:00:00.000Z",
          "anthropic/claude-sonnet-5",
        ]),
      },
    ]);

    const modelUsage = ompUsageFormat.parseLine(
      JSON.stringify({
        type: "model_usage",
        id: "usage-1",
        timestamp: "2026-11-06T00:05:00.000Z",
        provider: "openai",
        model: "gpt-5.2",
        purpose: "title",
        usage: { input: 3, output: 4 },
      }),
      scan,
    );
    assert.lengthOf(modelUsage, 1);
    assert.equal(modelUsage[0]?.model, "openai/gpt-5.2");
    assert.equal(modelUsage[0]?.sessionId, "session-1");
    assert.deepEqual(modelUsage[0]?.totals, {
      uncachedInputTokens: 3,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 4,
      reasoningTokens: 0,
    });
  });

  it("ignores malformed lines and empty usage", () => {
    const scan = state();
    assert.deepEqual(ompUsageFormat.parseLine("not json", scan), []);
    assert.deepEqual(
      ompUsageFormat.parseLine(
        JSON.stringify({
          type: "model_usage",
          id: "usage-2",
          timestamp: "2026-11-06T00:00:00.000Z",
          provider: "openai",
          model: "gpt-5.2",
          usage: { input: 0, output: 0 },
        }),
        scan,
      ),
      [],
    );
  });
});
