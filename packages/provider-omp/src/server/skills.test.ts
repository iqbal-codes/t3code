import { assert, describe, it } from "@effect/vitest";

import { ompSkillsFromJson } from "./skills.ts";

describe("omp skill discovery", () => {
  it("maps omp skill summaries and keeps enabled state", () => {
    const skills = ompSkillsFromJson(
      JSON.stringify({
        skills: [
          {
            name: "zeta",
            description: "Second skill",
            filePath: "/skills/zeta/SKILL.md",
            source: "native:project",
            hide: true,
          },
          {
            name: "alpha",
            description: "First skill",
            filePath: "/skills/alpha/SKILL.md",
            source: "native:user",
            hide: false,
          },
          {
            name: "alpha",
            description: "Duplicate",
            filePath: "/skills/alpha-copy/SKILL.md",
            source: "custom",
            hide: false,
          },
        ],
        warnings: [],
      }),
    );

    assert.deepEqual(skills, [
      {
        name: "alpha",
        description: "First skill",
        path: "/skills/alpha/SKILL.md",
        scope: "native:user",
        enabled: true,
      },
      {
        name: "zeta",
        description: "Second skill",
        path: "/skills/zeta/SKILL.md",
        scope: "native:project",
        enabled: false,
      },
    ]);
  });

  it("returns undefined for malformed output", () => {
    assert.equal(ompSkillsFromJson("not json"), undefined);
  });
});
