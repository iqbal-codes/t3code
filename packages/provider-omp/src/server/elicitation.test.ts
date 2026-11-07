import { assert, describe, it } from "@effect/vitest";

import { extractOmpElicitationForm } from "./elicitation.ts";

const request = {
  mode: "form",
  message: "Answer the questions",
  requestedSchema: {
    type: "object",
    properties: {
      q0: {
        type: "string",
        title: "Which database?",
        description: "Database",
        oneOf: [
          { const: "Postgres", title: "Postgres", description: "Relational" },
          { const: "SQLite", title: "SQLite" },
        ],
        default: "SQLite",
      },
      q0__other: { type: "string", title: "Other" },
      q1: {
        type: "array",
        title: "Which features?",
        description: "Features",
        items: {
          anyOf: [
            { const: "Auth", title: "Auth" },
            { const: "Billing", title: "Billing" },
          ],
        },
      },
      q1__other: { type: "string", title: "Other" },
    },
    required: ["q0"],
  },
} as const;

describe("omp ACP elicitation", () => {
  it("maps ask questions and restores selected labels", () => {
    const extracted = extractOmpElicitationForm(request as never);
    assert.isDefined(extracted);
    if (extracted === undefined) return;
    assert.deepEqual(extracted.questions, [
      {
        id: "q0",
        header: "Database",
        question: "Which database?",
        options: [
          { label: "Postgres", description: "Relational", value: "Postgres" },
          { label: "SQLite", description: "SQLite", value: "SQLite" },
        ],
        allowCustomAnswer: true,
        initialAnswer: "SQLite",
      },
      {
        id: "q1",
        header: "Features",
        question: "Which features?",
        options: [
          { label: "Auth", description: "Auth", value: "Auth" },
          { label: "Billing", description: "Billing", value: "Billing" },
        ],
        multiSelect: true,
        allowCustomAnswer: true,
      },
    ]);
    assert.deepEqual(extracted.respond({ q0: "Postgres", q1: ["Auth"] }), {
      action: "accept",
      content: { q0: "Postgres", q1: ["Auth"] },
    });
  });

  it("sends free text through omp's __other companion", () => {
    const extracted = extractOmpElicitationForm(request as never);
    assert.isDefined(extracted);
    if (extracted === undefined) return;
    assert.deepEqual(extracted.respond({ q0: "DuckDB", q1: ["Auth"] }), {
      action: "accept",
      content: { q0: "DuckDB", q0__other: "DuckDB", q1: ["Auth"] },
    });
  });
});
