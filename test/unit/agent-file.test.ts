import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentConfigError,
  buildAgentConfig,
  createEphemeralAgent,
  EPHEMERAL_PREFIX,
  globalAgentDir,
  needsEphemeralAgent,
  STALE_AGENT_MS,
  sweepStaleAgents,
  workflowTools,
} from '../../src/agent-file';

let root: string;
let home: string;
let cwd: string;
let globalDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-file-'));
  home = join(root, 'home');
  cwd = join(root, 'work');
  globalDir = join(home, '.kiro', 'agents');
  await mkdir(globalDir, { recursive: true });
  await mkdir(join(cwd, '.kiro', 'agents'), { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('needsEphemeralAgent', () => {
  test('only when the node restricts tools or sets a prompt', () => {
    expect(needsEphemeralAgent({})).toBe(false);
    expect(needsEphemeralAgent({ baseAgent: 'x' })).toBe(false);
    expect(needsEphemeralAgent({ deniedTools: [] })).toBe(false);
    expect(needsEphemeralAgent({ allowedTools: [] })).toBe(true); // "no tools at all" is a restriction
    expect(needsEphemeralAgent({ deniedTools: ['shell'] })).toBe(true);
    expect(needsEphemeralAgent({ systemPrompt: 'x' })).toBe(true);
    expect(needsEphemeralAgent({ appendSystemPrompt: 'x' })).toBe(true);
  });
});

describe('globalAgentDir', () => {
  test('honours KIRO_HOME, else ~/.kiro', () => {
    expect(globalAgentDir({ HOME: '/h' })).toBe('/h/.kiro/agents');
    expect(globalAgentDir({ HOME: '/h', KIRO_HOME: '/k' })).toBe('/k/agents');
  });
});

describe('buildAgentConfig', () => {
  test('from scratch: mirrors the default agent, then applies the node', async () => {
    const config = await buildAgentConfig('n', { allowedTools: ['read'], deniedTools: ['shell'], systemPrompt: 'Be brief.' }, cwd, globalDir);
    expect(config).toMatchObject({
      name: 'n',
      tools: ['read'],
      excludedTools: ['shell'],
      prompt: 'Be brief.',
      includeMcpJson: true,
      includePowers: true,
    });
  });

  test('a deny list alone keeps every other tool', async () => {
    expect(await buildAgentConfig('n', { deniedTools: ['shell', 'write'] }, cwd, globalDir)).toMatchObject({
      tools: ['*'],
      excludedTools: ['shell', 'write'],
    });
  });

  test('allowed_tools: [] leaves the session without tools', async () => {
    expect((await buildAgentConfig('n', { allowedTools: [] }, cwd, globalDir)).tools).toEqual([]);
  });

  test('systemPrompt plus appendSystemPrompt', async () => {
    const config = await buildAgentConfig('n', { systemPrompt: 'A', appendSystemPrompt: 'B' }, cwd, globalDir);
    expect(config.prompt).toBe('A\n\nB');
  });

  test('builds on a configured JSON agent: workspace first, prompt appended, exclusions merged', async () => {
    await writeFile(join(globalDir, 'reviewer.json'), JSON.stringify({ name: 'reviewer', prompt: 'global', tools: ['*'] }));
    await writeFile(
      join(cwd, '.kiro', 'agents', 'reviewer.json'),
      JSON.stringify({ name: 'reviewer', prompt: 'You review code.', tools: ['read', 'shell'], excludedTools: ['web'], mcpServers: { m: { command: 'x' } } })
    );
    const config = await buildAgentConfig('n', { baseAgent: 'reviewer', deniedTools: ['shell'], appendSystemPrompt: 'Archon rules.' }, cwd, globalDir);
    expect(config).toMatchObject({
      name: 'n',
      prompt: 'You review code.\n\nArchon rules.',
      tools: ['read', 'shell'],
      excludedTools: ['web', 'shell'],
      mcpServers: { m: { command: 'x' } },
    });
  });

  test('a base agent file:// prompt is inlined, because the copy lives elsewhere', async () => {
    await writeFile(join(globalDir, 'p.md'), 'Prompt from file.');
    await writeFile(join(globalDir, 'filer.json'), JSON.stringify({ name: 'filer', prompt: 'file://p.md' }));
    const config = await buildAgentConfig('n', { baseAgent: 'filer', allowedTools: ['read'] }, cwd, globalDir);
    expect(config.prompt).toBe('Prompt from file.');
  });

  test('a systemPrompt replaces the base agent prompt', async () => {
    await writeFile(join(globalDir, 'r.json'), JSON.stringify({ name: 'r', prompt: 'old' }));
    expect((await buildAgentConfig('n', { baseAgent: 'r', systemPrompt: 'new' }, cwd, globalDir)).prompt).toBe('new');
  });

  test('kiro_default is treated as no base', async () => {
    expect(await buildAgentConfig('n', { baseAgent: 'kiro_default', allowedTools: ['read'] }, cwd, globalDir)).toMatchObject({ tools: ['read'], includeMcpJson: true });
  });

  test('misconfigured bases fail with AgentConfigError', async () => {
    await writeFile(join(globalDir, 'broken.json'), '{nope');
    await writeFile(join(globalDir, 'md-only.md'), '---\nname: md-only\n---\nhi');
    for (const baseAgent of ['kiro_planner', 'missing', 'broken', 'md-only', '../escape']) {
      await expect(buildAgentConfig('n', { baseAgent, allowedTools: [] }, cwd, globalDir)).rejects.toBeInstanceOf(AgentConfigError);
    }
  });
});

describe('workflow isolation', () => {
  const skill = { name: 'pw', dir: '/s/pw', file: '/s/pw/SKILL.md' };
  const secret = { secret: { command: 'bun', args: ['server.ts'] } };

  test('a workflow node always gets an agent', () => {
    expect(needsEphemeralAgent({ workflow: { mcpServers: {}, skills: [] } })).toBe(true);
  });

  test('no declarations: no ambient MCP, no powers, Kiro skill loader denied, no resources', async () => {
    const config = await buildAgentConfig('n', { workflow: { mcpServers: {}, skills: [] } }, cwd, globalDir);
    expect(config).toMatchObject({
      // Not '*': that would also match the tools of the user's own mcp.json servers.
      tools: ['@builtin'],
      includeMcpJson: false,
      includePowers: false,
      mcpServers: {},
      permissions: { rules: [{ capability: 'skill', effect: 'deny' }] },
    });
    expect(config.resources).toBeUndefined();
    expect(config.prompt).toBeUndefined();
  });

  test('declared servers and skills, with a note naming each skill directory', async () => {
    const config = await buildAgentConfig('n', { workflow: { mcpServers: secret, skills: [skill] } }, cwd, globalDir);
    expect(config.mcpServers).toEqual(secret);
    expect(config.resources).toEqual(['file:///s/pw/SKILL.md']);
    expect(config.prompt).toContain('- pw: /s/pw');
    expect(config.tools).toEqual(['@builtin', '@secret']);
  });

  test('workflowTools: * → @builtin, undeclared servers dropped, declared ones added', () => {
    expect(workflowTools(['*'], [])).toEqual(['@builtin']);
    expect(workflowTools(['read', '@ambient', '@ambient/tool', '@secret/get_secret', '@builtin'], ['secret'])).toEqual([
      'read',
      '@secret/get_secret',
      '@builtin',
      '@secret',
    ]);
    expect(workflowTools([], ['a', 'b'])).toEqual(['@a', '@b']);
  });

  test('allowed_tools keeps declared MCP servers usable', async () => {
    const config = await buildAgentConfig('n', { allowedTools: [], workflow: { mcpServers: secret, skills: [] } }, cwd, globalDir);
    expect(config.tools).toEqual(['@secret']);
    const withRead = await buildAgentConfig('n', { allowedTools: ['read'], workflow: { mcpServers: secret, skills: [] } }, cwd, globalDir);
    expect(withRead.tools).toEqual(['read', '@secret']);
  });

  test('system prompts and the skills note compose', async () => {
    const config = await buildAgentConfig('n', { systemPrompt: 'Be brief.', appendSystemPrompt: 'Extra.', workflow: { mcpServers: {}, skills: [skill] } }, cwd, globalDir);
    expect((config.prompt as string).split('\n\n').slice(0, 2)).toEqual(['Be brief.', 'Extra.']);
    expect(config.prompt).toContain('- pw: /s/pw');
  });

  test('a base agent loses its own MCP servers and skills, keeps the rest', async () => {
    await writeFile(
      join(globalDir, 'mine.json'),
      JSON.stringify({
        name: 'mine',
        tools: ['read', 'shell'],
        includeMcpJson: true,
        mcpServers: { theirs: { command: 'x' } },
        resources: ['file://README.md', 'skill://.kiro/skills/*/SKILL.md'],
        permissions: { rules: [{ capability: 'shell', effect: 'ask' }], mode: 'strict' },
      })
    );
    const config = await buildAgentConfig('n', { baseAgent: 'mine', workflow: { mcpServers: secret, skills: [skill] } }, cwd, globalDir);
    expect(config).toMatchObject({
      tools: ['read', 'shell', '@secret'],
      includeMcpJson: false,
      mcpServers: secret,
      resources: ['file://README.md', 'file:///s/pw/SKILL.md'],
      permissions: { mode: 'strict', rules: [{ capability: 'shell', effect: 'ask' }, { capability: 'skill', effect: 'deny' }] },
    });
  });
});

describe('createEphemeralAgent', () => {
  test('writes a private archon-run-* file in the global dir, never the workspace, and removes it', async () => {
    const agent = await createEphemeralAgent({ allowedTools: ['read'] }, { cwd, env: { HOME: home } });
    expect(agent.name.startsWith(EPHEMERAL_PREFIX)).toBe(true);
    expect(agent.path).toBe(join(globalDir, `${agent.name}.json`));
    expect(((await stat(agent.path)).mode & 0o777).toString(8)).toBe('600');
    expect(JSON.parse(await readFile(agent.path, 'utf8'))).toMatchObject({ name: agent.name, tools: ['read'] });
    expect(await readdir(join(cwd, '.kiro', 'agents'))).toEqual([]);
    await agent.dispose();
    expect(existsSync(agent.path)).toBe(false);
    await agent.dispose(); // idempotent
  });

  test('creates the agent directory when missing', async () => {
    await rm(join(home, '.kiro'), { recursive: true });
    const agent = await createEphemeralAgent({ systemPrompt: 'x' }, { cwd, env: { HOME: home } });
    expect(existsSync(agent.path)).toBe(true);
    await agent.dispose();
  });

  test('concurrent turns get distinct agents', async () => {
    const agents = await Promise.all(Array.from({ length: 8 }, () => createEphemeralAgent({ systemPrompt: 'x' }, { cwd, env: { HOME: home } })));
    expect(new Set(agents.map(agent => agent.name)).size).toBe(8);
    await Promise.all(agents.map(agent => agent.dispose()));
  });
});

describe('sweepStaleAgents', () => {
  test('removes only stale archon-run-* files', async () => {
    const old = new Date(Date.now() - STALE_AGENT_MS - 60_000);
    for (const name of [`${EPHEMERAL_PREFIX}old.json`, `${EPHEMERAL_PREFIX}fresh.json`, 'user-agent.json', `${EPHEMERAL_PREFIX}old.md`]) {
      await writeFile(join(globalDir, name), '{}');
    }
    await utimes(join(globalDir, `${EPHEMERAL_PREFIX}old.json`), old, old);
    await utimes(join(globalDir, 'user-agent.json'), old, old);
    await utimes(join(globalDir, `${EPHEMERAL_PREFIX}old.md`), old, old);
    expect(await sweepStaleAgents(globalDir)).toEqual([`${EPHEMERAL_PREFIX}old.json`]);
    expect((await readdir(globalDir)).sort()).toEqual([`${EPHEMERAL_PREFIX}fresh.json`, `${EPHEMERAL_PREFIX}old.md`, 'user-agent.json']);
  });

  test('a missing directory is not an error', async () => {
    expect(await sweepStaleAgents(join(root, 'nope'))).toEqual([]);
  });
});
