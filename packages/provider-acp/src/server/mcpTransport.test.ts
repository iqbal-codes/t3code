import { describe, expect, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";

import { selectAcpMcpServers } from "./mcpTransport.ts";

const stdio = {
  name: "t3-code",
  command: "node",
  args: ["acp-mcp-bridge"],
  env: [{ name: "T3_ACP_MCP_ENDPOINT", value: "http://127.0.0.1:1/mcp" }],
} satisfies EffectAcpSchema.McpServer;

const http = {
  type: "http",
  name: "t3-code",
  url: "http://127.0.0.1:1/mcp",
  headers: [{ name: "Authorization", value: "Bearer token" }],
} satisfies EffectAcpSchema.McpServer;

const acp = {
  type: "acp",
  name: "t3-code",
  serverId: "t3-code",
} satisfies EffectAcpSchema.McpServer;

describe("selectAcpMcpServers", () => {
  it("prefers HTTP over the stdio bridge when the agent advertises HTTP", () => {
    expect(
      selectAcpMcpServers({
        mcpCapabilities: { http: true },
        acpServers: [acp],
        httpServers: [http],
        fallback: [stdio],
      }),
    ).toEqual([http]);
  });

  it("keeps the stdio bridge when the flavor injected no HTTP server", () => {
    expect(
      selectAcpMcpServers({
        mcpCapabilities: { http: true },
        acpServers: [],
        httpServers: [],
        fallback: [stdio],
      }),
    ).toEqual([stdio]);
  });

  it("prefers the ACP channel when the agent advertises it", () => {
    expect(
      selectAcpMcpServers({
        mcpCapabilities: { acp: true, http: true },
        acpServers: [acp],
        httpServers: [http],
        fallback: [stdio],
      }),
    ).toEqual([acp]);
  });

  it("falls back when the agent advertises no MCP transport", () => {
    expect(
      selectAcpMcpServers({
        mcpCapabilities: undefined,
        acpServers: [acp],
        httpServers: [http],
        fallback: [stdio],
      }),
    ).toEqual([stdio]);
  });
});
