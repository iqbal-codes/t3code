import { type ServerProviderSlashCommand } from "@t3tools/contracts";
import { COMPACT_SLASH_COMMAND } from "@t3tools/provider-core/server/snapshotProbe";

function normalizeName(name: string): string {
  return name.trim().replace(/^\//, "").trim();
}

export function normalizeOmpCommands(
  commands: ReadonlyArray<{
    readonly name: string;
    readonly description?: string | null | undefined;
    readonly input?: { readonly hint?: string | null | undefined } | null | undefined;
  }>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>();
  const slashCommands: Array<ServerProviderSlashCommand> = [];
  for (const command of commands) {
    const name = normalizeName(command.name);
    if (name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    const description = command.description?.trim();
    const hint = command.input?.hint?.trim();
    slashCommands.push({
      name,
      ...(description === undefined || description.length === 0 ? {} : { description }),
      ...(hint === undefined || hint.length === 0 ? {} : { input: { hint } }),
    });
  }
  return slashCommands;
}

export function withOmpBuiltinSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  return [COMPACT_SLASH_COMMAND, ...commands.filter((command) => command.name !== "compact")];
}
