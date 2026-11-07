import { assert, describe, it } from "@effect/vitest";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";

import { buildOmpAcpSpawnInput, ompApprovalMode, ompApprovalOptions } from "./acpSupport.ts";

describe("omp ACP support", () => {
  it("maps runtime modes to omp approval modes", () => {
    assert.equal(ompApprovalMode({ runtimeMode: "full-access", cwd: "/work" }), "yolo");
    assert.equal(ompApprovalMode({ runtimeMode: "auto-accept-edits", cwd: "/work" }), "write");
    assert.equal(ompApprovalMode({ runtimeMode: "approval-required", cwd: "/work" }), "always-ask");
    assert.equal(
      ompApprovalMode({
        runtimeMode: "full-access",
        cwd: "/work",
        approvalPolicy: "ask",
      }),
      "write",
    );
    assert.equal(
      ompApprovalMode({
        runtimeMode: "full-access",
        cwd: "/work",
        sandboxPolicy: { type: "workspaceWrite" },
      }),
      "write",
    );
  });

  it("builds the ACP launch with profile, policy, and orchestration instructions", () => {
    const spawn = buildOmpAcpSpawnInput({
      settings: { binaryPath: "/opt/omp" },
      profile: "work",
      launchArgs: ["--config", "/tmp/omp.yml"],
      policy: { runtimeMode: "auto-accept-edits", cwd: "/work" },
      cwd: "/work",
      environment: { PATH: "/usr/bin" },
    });
    assert.equal(spawn.command, "/opt/omp");
    assert.equal(spawn.cwd, "/work");
    assert.deepEqual(spawn.args.slice(0, 4), ["--profile", "work", "acp", "--approval-mode"]);
    assert.equal(spawn.args[4], "write");
    assert.equal(spawn.args[5], "--append-system-prompt");
    assert.equal(spawn.args[6], T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.deepEqual(spawn.args.slice(7), ["--config", "/tmp/omp.yml"]);
    assert.deepEqual(spawn.env, { PATH: "/usr/bin" });
  });

  it("offers only the approval decisions omp can honor", () => {
    const options = ompApprovalOptions({
      sessionId: "session",
      toolCall: { toolCallId: "tool" },
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
        { optionId: "reject_once", name: "Reject", kind: "reject_once" },
        { optionId: "reject_always", name: "Always reject", kind: "reject_always" },
      ],
    } as never);
    assert.deepEqual(options, [
      { decision: "accept", label: "Allow once" },
      { decision: "acceptForSession", label: "Always allow" },
      { decision: "decline", label: "Reject" },
      { decision: "cancel", label: "Cancel" },
    ]);
  });
});
