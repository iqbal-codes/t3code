import { assert, describe, it } from "@effect/vitest";

import { ompModelsFromJson } from "./status.ts";

describe("omp model catalog", () => {
  it("maps provider/id selectors and per-model thinking levels", () => {
    const models = ompModelsFromJson([
      {
        provider: "anthropic",
        id: "claude-sonnet-5",
        selector: "anthropic/claude-sonnet-5",
        name: "Claude Sonnet 5",
        reasoning: true,
        thinking: ["low", "medium", "high"],
      },
      {
        provider: "openai",
        id: "gpt-5.2",
        name: "GPT 5.2",
        reasoning: false,
        thinking: null,
      },
    ]);
    assert.lengthOf(models, 2);
    assert.deepEqual(models[0], {
      slug: "anthropic/claude-sonnet-5",
      name: "Claude Sonnet 5",
      subProvider: "anthropic",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "thinking",
            label: "Thinking",
            type: "select",
            currentValue: "auto",
            options: [
              { id: "off", label: "Off" },
              { id: "auto", label: "Auto", isDefault: true },
              { id: "low", label: "Low" },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High" },
            ],
          },
        ],
      },
    });
    assert.deepEqual(models[1], {
      slug: "openai/gpt-5.2",
      name: "GPT 5.2",
      subProvider: "openai",
      isCustom: false,
      capabilities: { optionDescriptors: [] },
    });
  });

  it("deduplicates selectors and skips incomplete entries", () => {
    const models = ompModelsFromJson([
      { provider: "openai", id: "gpt-5.2", selector: "openai/gpt-5.2" },
      { provider: "openai", id: "gpt-5.2", selector: "openai/gpt-5.2", name: "Duplicate" },
      { provider: "", id: "missing" },
      { provider: "anthropic", id: "" },
    ]);
    assert.lengthOf(models, 1);
    assert.equal(models[0]?.slug, "openai/gpt-5.2");
  });
});
