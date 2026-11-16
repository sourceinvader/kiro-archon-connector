import { z } from 'zod';
import { clampEffort, isEffortRung, normalizedConfigString, snapshotConfigSchema } from '@archon/provider-contract';

/** Reasoning levels `kiro-cli chat --effort` accepts. */
export const KIRO_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type KiroEffort = (typeof KIRO_EFFORT_LEVELS)[number];

const nonEmpty = z.string().min(1);

/**
 * Settings that mean the same thing on any machine, so they may be layered per run and
 * recorded in a run snapshot.
 */
const portableFields = {
  /** Kiro model id, as `kiro-cli chat --list-models` prints it (for example `minimax-m2.5`). */
  model: normalizedConfigString(nonEmpty, 'trim').optional(),
  /** Kiro agent name (`kiro-cli agent list`). Unset uses Kiro's own default agent. */
  agent: normalizedConfigString(nonEmpty, 'trim').optional(),
  /** Default reasoning effort when a node sets none. Models without effort levels ignore it. */
  effort: z.enum(KIRO_EFFORT_LEVELS).optional(),
  /**
   * Pass `--trust-all-tools`, so tools run without approval. Headless Kiro cannot ask for an
   * approval, so a tool that needs one is denied. Default true: workflow nodes are
   * autonomous, as they are on Archon's other providers. Node `allowed_tools` and
   * `denied_tools` still limit which tools exist.
   */
  trustAllTools: z.boolean().optional(),
};

/** Settings that only make sense on this machine: excluded from run layers and snapshots. */
const localFields = {
  /** Absolute path to `kiro-cli` when it is not on PATH. */
  kiroPath: normalizedConfigString(nonEmpty, 'trim').optional(),
};

export const installConfigSchema = z.strictObject({ ...portableFields, ...localFields });
export const runConfigSchema = z.strictObject(portableFields);
export const snapshotSchema = snapshotConfigSchema(portableFields, localFields);

export type KiroInstallConfig = z.output<typeof installConfigSchema>;

/** JSON Schemas Archon validates `assistants.kiro` against, generated from the same Zod schemas. */
export const configJsonSchemas = {
  install: z.toJSONSchema(installConfigSchema, { io: 'input' }) as Record<string, unknown>,
  run: z.toJSONSchema(runConfigSchema, { io: 'input' }) as Record<string, unknown>,
  snapshot: z.toJSONSchema(snapshotSchema, { io: 'input' }) as Record<string, unknown>,
};

/**
 * Read the merged `assistants.kiro` block defensively. Archon validated it against the
 * install schema already; an unexpected shape here falls back to defaults rather than
 * failing a running turn.
 */
export function readAssistantConfig(raw: Record<string, unknown> | undefined): KiroInstallConfig {
  const parsed = installConfigSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  // Keep the fields that are individually valid.
  const result: KiroInstallConfig = {};
  for (const key of Object.keys(installConfigSchema.shape) as (keyof KiroInstallConfig)[]) {
    const field = installConfigSchema.shape[key].safeParse(raw?.[key]);
    if (field.success && field.data !== undefined) (result as Record<string, unknown>)[key] = field.data;
  }
  return result;
}

/**
 * Archon effort rungs (`minimal` .. `persistent`) mapped onto Kiro's levels. An unsupported
 * rung clamps to a weaker one first, so a mapping never silently buys more reasoning.
 */
export function kiroEffort(value: unknown): KiroEffort | undefined {
  if (!isEffortRung(value)) return undefined;
  return clampEffort(value, KIRO_EFFORT_LEVELS);
}
