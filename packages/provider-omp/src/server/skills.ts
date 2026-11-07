import type { ServerProviderSkill } from "@t3tools/contracts";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";

import type { OmpSettings } from "../settings.ts";
import { ompProfileArgs, resolveOmpProfile } from "./launchArgs.ts";

const SKILL_LIST_TIMEOUT_MS = 10_000;

const OmpSkillSummary = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  filePath: Schema.String,
  source: Schema.optional(Schema.String),
  hide: Schema.optional(Schema.Boolean),
});
const OmpSkillList = Schema.Struct({
  skills: Schema.Array(OmpSkillSummary),
});
const decodeSkillList = Schema.decodeUnknownOption(Schema.fromJsonString(OmpSkillList));

export function ompSkillsFromJson(stdout: string): ReadonlyArray<ServerProviderSkill> | undefined {
  const decoded = decodeSkillList(stdout.trim());
  if (Option.isNone(decoded)) return undefined;
  const seen = new Set<string>();
  const skills: Array<ServerProviderSkill> = [];
  for (const skill of decoded.value.skills) {
    const name = skill.name.trim();
    const path = skill.filePath.trim();
    if (name.length === 0 || path.length === 0 || seen.has(name)) continue;
    seen.add(name);
    const description = skill.description?.trim();
    const source = skill.source?.trim();
    skills.push({
      name,
      path,
      enabled: skill.hide !== true,
      ...(description === undefined || description.length === 0 ? {} : { description }),
      ...(source === undefined || source.length === 0 ? {} : { scope: source }),
    });
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

export const discoverOmpSkills = Effect.fn("discoverOmpSkills")(function* (
  settings: Pick<OmpSettings, "binaryPath" | "profile">,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) {
  const profile = resolveOmpProfile(settings.profile);
  if (!profile.ok) return [];
  const command = settings.binaryPath || "omp";
  const result = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(
      command,
      [...ompProfileArgs(profile.profile), "skill", "list", cwd, "--json"],
      { env: environment },
    );
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd,
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  }).pipe(Effect.timeoutOption(SKILL_LIST_TIMEOUT_MS));

  if (Option.isNone(result) || result.value.code !== 0) return [];
  return ompSkillsFromJson(result.value.stdout) ?? [];
});
