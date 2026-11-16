import { existsSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { declaredSkillRoots, type SkillDiscovery } from '@archon/provider-contract';

/**
 * Where a node's named skills are looked up, highest precedence first. Kiro's own roots
 * come first, then the agentskills.io and Claude conventions Archon's other providers use
 * (`npx skills add` and `playwright-cli install --skills` write to `.claude/skills`).
 * Declared in the descriptor, so `archon validate workflows` checks names against the same
 * roots this plugin loads from.
 */
export const KIRO_SKILL_DISCOVERY: SkillDiscovery = {
  project: ['.kiro/skills', '.agents/skills', '.claude/skills'],
  user: ['.kiro/skills', '.agents/skills', '.claude/skills'],
};

export interface ResolvedSkill {
  name: string;
  /** The skill's directory: relative paths in its SKILL.md resolve against it. */
  dir: string;
  /** Absolute path of its SKILL.md. */
  file: string;
}

export interface SkillResolution {
  skills: ResolvedSkill[];
  missing: string[];
  /** The roots searched, for an operator-facing message. */
  roots: string[];
}

/** Name-only, as Archon's resolver: no paths, no traversal. */
export function isSkillName(name: string): boolean {
  return name.length > 0 && !isAbsolute(name) && basename(name) === name && name !== '.' && name !== '..';
}

export function nodeSkillNames(declared: unknown): string[] | undefined {
  if (!Array.isArray(declared)) return undefined;
  return [...new Set(declared.filter((name): name is string => typeof name === 'string').map(name => name.trim()).filter(Boolean))];
}

export function resolveNodeSkills(
  names: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>>
): SkillResolution {
  const roots = declaredSkillRoots(KIRO_SKILL_DISCOVERY, cwd, { env });
  const skills: ResolvedSkill[] = [];
  const missing: string[] = [];
  for (const name of names) {
    if (!isSkillName(name)) {
      missing.push(name);
      continue;
    }
    const dir = roots.map(root => join(root, name)).find(candidate => existsSync(join(candidate, 'SKILL.md')));
    if (dir) skills.push({ name, dir, file: join(dir, 'SKILL.md') });
    else missing.push(name);
  }
  return { skills, missing, roots };
}
