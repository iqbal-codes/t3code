import type { UsageProviderKind } from "@t3tools/contracts";
import type { TranscriptUsageFormat } from "@t3tools/provider-core/server/usage";
import { piUsageFormat } from "@t3tools/provider-pi/server/usage";
import { ompUsageFormat } from "@t3tools/provider-omp/server/usage";
import { grokUsageFormat } from "@t3tools/provider-grok/server/usage";
import { museUsageFormat } from "@t3tools/provider-muse/server/usage";

import { claudeUsageFormat } from "../provider/Drivers/claudeUsage.ts";
import { codexUsageFormat } from "../provider/Drivers/codexUsage.ts";

export const TEST_FORMATS: Record<
  "claude" | "codex" | "grok" | "pi" | "muse" | "omp",
  TranscriptUsageFormat<unknown>
> = {
  claude: claudeUsageFormat,
  codex: codexUsageFormat,
  grok: grokUsageFormat,
  pi: piUsageFormat,
  muse: museUsageFormat,
  omp: ompUsageFormat,
};

export const TEST_FORMAT_MAP = new Map<UsageProviderKind, TranscriptUsageFormat<unknown>>(
  Object.entries(TEST_FORMATS) as Array<[UsageProviderKind, TranscriptUsageFormat<unknown>]>,
);
