import type * as EffectAcpSchema from "effect-acp/compat";

export interface AcpMcpTransportInput {
  readonly mcpCapabilities: { readonly http?: boolean; readonly acp?: boolean } | null | undefined;
  readonly acpServers: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly httpServers: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly fallback: ReadonlyArray<EffectAcpSchema.McpServer>;
}

/**
 * Picks the transport `session/new` advertises: the ACP channel, then HTTP, then the client's
 * stdio bridge. An agent that advertises `http` but is handed the bridge spawns a subprocess
 * whose connect failures it may tolerate silently, leaving the session with no MCP tools.
 */
export function selectAcpMcpServers(
  input: AcpMcpTransportInput,
): ReadonlyArray<EffectAcpSchema.McpServer> {
  if (input.mcpCapabilities?.acp === true && input.acpServers.length > 0) return input.acpServers;
  if (input.mcpCapabilities?.http === true && input.httpServers.length > 0)
    return input.httpServers;
  return input.fallback;
}
