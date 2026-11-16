/**
 * Live MCP and skills tests against real Kiro (opt-in: KIRO_LIVE=1). Every turn pins
 * KIRO_LIVE_MODEL (default minimax-m2.5). The Playwright cases need network access and
 * Google Chrome or Playwright's Chromium; skip them with KIRO_LIVE_SKIP_PLAYWRIGHT=1.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessageChunk, ResultChunk, SendQueryOptions } from '@archon/provider-contract';
import { KiroProvider } from '../../src/provider';
import { collect } from '../support/fake-kiro';

const LIVE = process.env.KIRO_LIVE === '1';
const PLAYWRIGHT = LIVE && process.env.KIRO_LIVE_SKIP_PLAYWRIGHT !== '1';
const MODEL = process.env.KIRO_LIVE_MODEL ?? 'minimax-m2.5';
const SECRET_SERVER = join(import.meta.dir, '..', 'fixtures', 'mcp', 'secret-server.ts');
const PLAYWRIGHT_MCP = '@playwright/mcp@0.0.85';
const PLAYWRIGHT_CLI = '@playwright/cli@0.1.24';
const provider = new KiroProvider();
const roots: string[] = [];

function workspace(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kiro-live-mcp-')));
  roots.push(dir);
  Bun.spawnSync(['git', 'init', '-q'], { cwd: dir });
  return dir;
}

function writeJson(path: string, value: unknown): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

function writeSkill(cwd: string, root: string, name: string, body: string): void {
  mkdirSync(join(cwd, root, name), { recursive: true });
  writeFileSync(join(cwd, root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${body.split('.')[0]}.\n---\n\n${body}\n`);
}

const secretServer = (value: string) => ({ command: process.execPath, args: [SECRET_SERVER], env: { SECRET_VALUE: value } });

function turn(prompt: string, cwd: string, options: SendQueryOptions = {}): Promise<MessageChunk[]> {
  return collect(provider.sendQuery(prompt, cwd, undefined, { model: MODEL, ...options }));
}
const resultOf = (chunks: MessageChunk[]): ResultChunk => chunks.find((chunk): chunk is ResultChunk => chunk.type === 'result')!;
const succeeded = (chunks: MessageChunk[]): ResultChunk => {
  expect(chunks.at(-1)).toEqual({ type: 'settled' });
  const result = resultOf(chunks);
  if (result.isError) throw new Error(`turn failed: ${JSON.stringify(result.failure)}`);
  return result;
};

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!LIVE)(`live MCP and skills (${MODEL})`, () => {
  test('mcp: the declared server starts, is reported connected, and its tool is really called', async () => {
    const cwd = workspace();
    const mcp = writeJson(join(cwd, '.archon/mcp/secret.json'), { secret: secretServer('LIVE-SECRET-4821') });
    const chunks = await turn('Call the get_secret tool and reply with exactly the value it returns.', cwd, { nodeConfig: { mcp } });
    const result = succeeded(chunks);
    expect(chunks).toContainEqual({ type: 'mcp_server_status', server: 'secret', status: 'connected' });
    expect(result.text).toContain('LIVE-SECRET-4821');
  });

  test('mcp: a server that does not start fails the node as misconfigured before any model work', async () => {
    const cwd = workspace();
    const mcp = writeJson(join(cwd, 'mcp.json'), { secret: { ...secretServer('x'), env: { FAIL_AT_START: '1' } } });
    const chunks = await turn('Call the get_secret tool.', cwd, { nodeConfig: { mcp } });
    expect(chunks.at(-1)).toEqual({ type: 'settled' });
    expect(resultOf(chunks).failure?.class).toBe('misconfigured');
    expect(chunks.some(chunk => chunk.type === 'tool_call' || chunk.type === 'agent_message_chunk')).toBe(false);
  });

  test("mcp: the workspace's own Kiro MCP config is excluded from workflow nodes (control: chat sees it)", async () => {
    const cwd = workspace();
    writeJson(join(cwd, '.kiro/settings/mcp.json'), { mcpServers: { ambient: secretServer('AMBIENT-SECRET-7302') } });
    const mcp = writeJson(join(cwd, '.archon/mcp/declared.json'), { declared: secretServer('DECLARED-SECRET-1159') });
    const prompt = 'Call every get_secret tool you have (from any server) and list each value returned. If none, reply NO-TOOLS.';
    const control = succeeded(await turn(prompt, cwd));
    expect(control.text).toContain('AMBIENT-SECRET-7302');
    const isolated = succeeded(await turn(prompt, cwd, { nodeConfig: { mcp } }));
    expect(isolated.text).toContain('DECLARED-SECRET-1159');
    expect(isolated.text).not.toContain('AMBIENT-SECRET-7302');
  });

  test('allowed_tools: [] plus mcp: the node has the MCP tool and nothing else', async () => {
    const cwd = workspace();
    const mcp = writeJson(join(cwd, 'mcp.json'), { secret: secretServer('ONLY-MCP-6620') });
    const result = succeeded(
      await turn('Call get_secret and reply with its value. Then say YES-SHELL if you have a shell tool, else NO-SHELL.', cwd, {
        nodeConfig: { mcp, allowed_tools: [] },
      })
    );
    expect(result.text).toContain('ONLY-MCP-6620');
    expect(result.text).toContain('NO-SHELL');
  });

  test('skills: a declared skill is used; an undeclared Kiro skill cannot be loaded even by name (control: chat can)', async () => {
    const cwd = workspace();
    writeSkill(cwd, '.claude/skills', 'declared-phrase', 'Use when asked for the declared phrase. The declared phrase is HERON-DECL-58.');
    writeSkill(cwd, '.kiro/skills', 'hidden-phrase', 'Use when asked for the hidden phrase. The hidden phrase is MARTEN-HIDE-93.');
    const ask = 'Load the hidden-phrase skill and tell me the hidden phrase. If no such skill is available to you, reply exactly NO-SKILL. Do not read files.';
    const control = succeeded(await turn(ask, cwd));
    expect(control.text).toContain('MARTEN-HIDE-93');
    const declared = succeeded(await turn('What is the declared phrase? Reply with the phrase only.', cwd, { nodeConfig: { skills: ['declared-phrase'] } }));
    expect(declared.text).toContain('HERON-DECL-58');
    const blocked = succeeded(await turn(ask, cwd, { nodeConfig: { skills: ['declared-phrase'] } }));
    expect(blocked.text).not.toContain('MARTEN-HIDE-93');
  });

  test('skills: none declared means none, even for skills installed in .kiro/skills', async () => {
    const cwd = workspace();
    writeSkill(cwd, '.kiro/skills', 'hidden-phrase', 'Use when asked for the hidden phrase. The hidden phrase is MARTEN-HIDE-93.');
    const result = succeeded(
      await turn('Load the hidden-phrase skill and tell me the hidden phrase. If no such skill is available, reply NO-SKILL. Do not read files.', cwd, {
        nodeConfig: {},
      })
    );
    expect(result.text).not.toContain('MARTEN-HIDE-93');
  });
});

describe.skipIf(!PLAYWRIGHT)(`live Playwright (${MODEL})`, () => {
  test('Playwright MCP server: opens a real page and reads its title', async () => {
    const cwd = workspace();
    const mcp = writeJson(join(cwd, '.archon/mcp/playwright.json'), {
      playwright: { command: 'npx', args: ['-y', PLAYWRIGHT_MCP, '--headless', '--isolated'] },
    });
    const chunks = await turn('Use the browser to open https://example.com and tell me the page title. Then close the browser.', cwd, {
      nodeConfig: { mcp, allowed_tools: [] },
    });
    const result = succeeded(chunks);
    expect(chunks).toContainEqual({ type: 'mcp_server_status', server: 'playwright', status: 'connected' });
    expect(chunks.some(chunk => chunk.type === 'tool_call' && chunk.title?.includes('browser_navigate'))).toBe(true);
    expect(result.text).toContain('Example Domain');
  }, 300_000);

  test('Playwright CLI driven by its skill (playwright-cli install --skills)', async () => {
    const cwd = workspace();
    const install = Bun.spawnSync(['npx', '-y', PLAYWRIGHT_CLI, 'install', '--skills'], { cwd, stdout: 'ignore', stderr: 'pipe' });
    expect(install.exitCode).toBe(0);
    // Stand-in for a global `npm i -g @playwright/cli`: a playwright-cli on PATH for this turn only.
    const bin = join(cwd, '.bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'playwright-cli'), `#!/bin/sh\nexec npx -y ${PLAYWRIGHT_CLI} "$@"\n`);
    chmodSync(join(bin, 'playwright-cli'), 0o755);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    env.PATH = `${bin}:${env.PATH ?? ''}`;
    const chunks = await turn(
      'Use playwright-cli to open https://example.com and tell me the page title. Close the browser when done.',
      cwd,
      { env, nodeConfig: { skills: ['playwright-cli'] } }
    );
    const result = succeeded(chunks);
    const commands = chunks.filter(chunk => chunk.type === 'tool_call').map(chunk => JSON.stringify((chunk as { rawInput?: unknown }).rawInput ?? ''));
    expect(commands.some(command => command.includes('playwright-cli'))).toBe(true);
    expect(result.text).toContain('Example Domain');
  }, 300_000);
});
