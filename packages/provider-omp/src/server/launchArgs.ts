import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

const RESERVED_OMP_ARGUMENTS = new Set([
  "--approval-mode",
  "--auto-approve",
  "--continue",
  "--cwd",
  "--export",
  "--fork",
  "--help",
  "-h",
  "--mode",
  "--no-session",
  "--print",
  "-p",
  "--profile",
  "--restore",
  "--resume",
  "-r",
  "--session",
  "--version",
  "-v",
  "--yolo",
]);

const OMP_ARGUMENTS_WITH_VALUES = new Set([
  "--add-dir",
  "--alias",
  "--api-key",
  "--append-system-prompt",
  "--config",
  "--exclude-tools",
  "-xt",
  "--extension",
  "-e",
  "--max-cost",
  "--max-time",
  "--model",
  "--models",
  "--plan",
  "--plan-yolo-into",
  "--prewalk-into",
  "--prompt-cache-key",
  "--prompt-template",
  "--provider",
  "--provider-session-id",
  "--service-tier",
  "--session-dir",
  "--skill",
  "--slow",
  "--smol",
  "--system-prompt",
  "--theme",
  "--thinking",
  "--tools",
  "-t",
  "--warn-cost",
]);

const OMP_ARGUMENTS_WITHOUT_VALUES = new Set([
  "--allow-home",
  "--hide-thinking",
  "--no-context-files",
  "--no-extensions",
  "--no-prompt-templates",
  "--no-skills",
  "--no-title",
  "--no-tools",
  "--no-prewalk",
  "--offline",
  "--plan-yolo",
  "--verbose",
  "--wait-async",
]);

const OMP_PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export type OmpLaunchArgsResolution =
  | { readonly ok: true; readonly args: ReadonlyArray<string> }
  | { readonly ok: false; readonly message: string };

export type OmpProfileResolution =
  | { readonly ok: true; readonly profile: string | undefined }
  | { readonly ok: false; readonly message: string };

export function resolveOmpProfile(profile: string | undefined): OmpProfileResolution {
  const trimmed = profile?.trim() ?? "";
  if (trimmed.length === 0 || trimmed === "default") return { ok: true, profile: undefined };
  if (!OMP_PROFILE_PATTERN.test(trimmed)) {
    return {
      ok: false,
      message:
        "omp profile may contain only letters, numbers, dots, underscores, and dashes, and must start with a letter or number.",
    };
  }
  return { ok: true, profile: trimmed };
}

export function ompProfileArgs(profile: string | undefined): ReadonlyArray<string> {
  return profile === undefined ? [] : ["--profile", profile];
}

function reservedOmpArgument(arg: string): string | undefined {
  for (const reserved of RESERVED_OMP_ARGUMENTS) {
    if (arg === reserved || (reserved.startsWith("--") && arg.startsWith(`${reserved}=`))) {
      return reserved;
    }
  }
  return undefined;
}

function normalizeOmpEqualsArguments(args: ReadonlyArray<string>): ReadonlyArray<string> {
  return args.flatMap((arg) => {
    const equalsIndex = arg.indexOf("=");
    if (equalsIndex <= 0) return [arg];
    const option = arg.slice(0, equalsIndex);
    return OMP_ARGUMENTS_WITH_VALUES.has(option) ? [option, arg.slice(equalsIndex + 1)] : [arg];
  });
}

export function resolveOmpLaunchArgs(launchArgs: string): OmpLaunchArgsResolution {
  const args = normalizeOmpEqualsArguments(tokenizeCliArgs(launchArgs));
  let hasProvider = false;
  let hasModel = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    const reserved = reservedOmpArgument(arg);
    if (reserved !== undefined) {
      return {
        ok: false,
        message: `omp launch argument '${reserved}' is controlled by T3 Code and cannot be overridden.`,
      };
    }
    if (arg === "--") {
      return {
        ok: false,
        message: "omp launch arguments cannot include positional prompts.",
      };
    }
    if (OMP_ARGUMENTS_WITH_VALUES.has(arg)) {
      const value = args[index + 1];
      if (value === undefined) {
        return { ok: false, message: `omp launch argument '${arg}' requires a value.` };
      }
      if (arg === "--provider") hasProvider = true;
      if (arg === "--model") hasModel = true;
      index += 1;
      continue;
    }
    if (OMP_ARGUMENTS_WITHOUT_VALUES.has(arg) || (arg.startsWith("--") && arg.includes("="))) {
      continue;
    }
    if (arg.startsWith("--")) {
      if (
        args[index + 1] !== undefined &&
        !args[index + 1]!.startsWith("-") &&
        !args[index + 1]!.startsWith("@")
      ) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      return { ok: false, message: `omp launch argument '${arg}' is not supported by T3 Code.` };
    }
    return {
      ok: false,
      message: `omp launch arguments cannot include positional prompt '${arg}'.`,
    };
  }
  if (hasProvider && !hasModel) {
    return { ok: false, message: "omp launch argument '--provider' requires '--model'." };
  }
  return { ok: true, args };
}
