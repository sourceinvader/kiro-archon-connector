import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSkillName, nodeSkillNames, resolveNodeSkills } from '../../src/skills';

let root: string;
let cwd: string;
let home: string;
let previousHome: string | undefined;

async function skill(base: string, rel: string, name: string): Promise<string> {
  const dir = join(base, rel, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n`);
  return dir;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'skills-'));
  cwd = join(root, 'work');
  home = join(root, 'home');
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  // declaredSkillRoots reads HOME, as Archon's validation does.
  previousHome = process.env.HOME;
  process.env.HOME = home;
});
afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

describe('resolveNodeSkills', () => {
  test('Kiro, agentskills and Claude roots, project before user', async () => {
    const kiro = await skill(cwd, '.kiro/skills', 'a');
    await skill(cwd, '.claude/skills', 'a'); // shadowed by .kiro
    const agents = await skill(cwd, '.agents/skills', 'b');
    const claude = await skill(cwd, '.claude/skills', 'c');
    await skill(home, '.kiro/skills', 'c'); // project wins over user
    const userOnly = await skill(home, '.claude/skills', 'd');
    const result = resolveNodeSkills(['a', 'b', 'c', 'd'], cwd, {});
    expect(result.missing).toEqual([]);
    expect(result.skills.map(entry => entry.dir)).toEqual([kiro, agents, claude, userOnly]);
    expect(result.skills[0]).toEqual({ name: 'a', dir: kiro, file: join(kiro, 'SKILL.md') });
    expect(result.roots).toEqual([
      join(cwd, '.kiro/skills'),
      join(cwd, '.agents/skills'),
      join(cwd, '.claude/skills'),
      join(home, '.kiro/skills'),
      join(home, '.agents/skills'),
      join(home, '.claude/skills'),
    ]);
  });

  test('missing names, directories without SKILL.md, and path-like names are reported missing', async () => {
    await mkdir(join(cwd, '.kiro/skills/empty'), { recursive: true });
    await skill(cwd, '.kiro/skills', 'real');
    const result = resolveNodeSkills(['nope', 'empty', '../real', '/abs/real', 'real'], cwd, {});
    expect(result.missing).toEqual(['nope', 'empty', '../real', '/abs/real']);
    expect(result.skills.map(entry => entry.name)).toEqual(['real']);
  });
});

describe('helpers', () => {
  test('isSkillName', () => {
    expect(isSkillName('playwright-cli')).toBe(true);
    for (const name of ['', '.', '..', 'a/b', '/a']) expect(isSkillName(name)).toBe(false);
  });

  test('nodeSkillNames trims, de-duplicates and keeps [] distinct from absent', () => {
    expect(nodeSkillNames([' a ', 'a', 'b', 3, ''])).toEqual(['a', 'b']);
    expect(nodeSkillNames([])).toEqual([]);
    expect(nodeSkillNames(undefined)).toBeUndefined();
    expect(nodeSkillNames('a')).toBeUndefined();
  });
});
