/**
 * Live tests against the real `kiro-cli` and a real Kiro account. Opt-in (`KIRO_LIVE=1`,
 * or `bun run test:live`) because each turn spends Kiro credits. Every turn pins a cheap
 * model: KIRO_LIVE_MODEL, default `minimax-m2.5`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { providerChunkSchema, type MessageChunk, type ResultChunk, type SendQueryOptions } from '@archon/provider-contract';
import { KiroProvider } from '../../src/provider';
import { collect } from '../support/fake-kiro';

const LIVE = process.env.KIRO_LIVE === '1';
const MODEL = process.env.KIRO_LIVE_MODEL ?? 'minimax-m2.5';
const provider = new KiroProvider();
const roots: string[] = [];

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kiro-live-'));
  roots.push(dir);
  await writeFile(join(dir, 'note.txt'), 'The secret fruit is RAMBUTAN.\n');
  Bun.spawnSync(['git', 'init', '-q'], { cwd: dir });
  return dir;
}

function turn(prompt: string, cwd: string, options: SendQueryOptions = {}, resume?: string): Promise<MessageChunk[]> {
  return collect(provider.sendQuery(prompt, cwd, resume, { model: MODEL, ...options }));
}

const resultOf = (chunks: MessageChunk[]): ResultChunk => chunks.find((chunk): chunk is ResultChunk => chunk.type === 'result')!;

function expectHealthy(chunks: MessageChunk[]): ResultChunk {
  for (const chunk of chunks) expect(providerChunkSchema.safeParse(chunk).success).toBe(true);
  expect(chunks.at(-1)).toEqual({ type: 'settled' });
  const result = resultOf(chunks);
  if (result.isError) throw new Error(`turn failed: ${JSON.stringify(result.failure)}`);
  expect(result.sessionId).toMatch(/^sess_/);
  // Every tool call closed before the result.
  const open = new Set<string>();
  for (const chunk of chunks.slice(0, chunks.indexOf(result))) {
    if (chunk.type === 'tool_call') open.add(chunk.toolCallId);
    if (chunk.type === 'tool_call_update') open.delete(chunk.toolCallId);
  }
  expect([...open]).toEqual([]);
  return result;
}

const ephemeralAgents = async (): Promise<string[]> => {
  try {
    return (await readdir(join(homedir(), '.kiro', 'agents'))).filter(name => name.startsWith('archon-run-'));
  } catch {
    return [];
  }
};

describe.skipIf(!LIVE)(`live Kiro (${MODEL})`, () => {
  let agentsBefore: string[];
  beforeAll(async () => {
    agentsBefore = await ephemeralAgents();
  });
  afterAll(async () => {
    expect(await ephemeralAgents()).toEqual(agentsBefore);
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  });

  test('plain reply', async () => {
    const result = expectHealthy(await turn('Reply with exactly: LIVE-OK', await workspace()));
    expect(result.text).toContain('LIVE-OK');
    expect(result.stopReason).toBe('end_turn');
  });

  test('tools run and report: read + shell', async () => {
    const cwd = await workspace();
    const chunks = await turn('Read note.txt, then run this shell command: echo live-tools > out.txt . Then reply with the secret fruit only.', cwd);
    const result = expectHealthy(chunks);
    expect(chunks.filter(chunk => chunk.type === 'tool_call').length).toBeGreaterThanOrEqual(2);
    expect(existsSync(join(cwd, 'out.txt'))).toBe(true);
    expect(result.text).toContain('RAMBUTAN');
  });

  test('resume continues the same Kiro session', async () => {
    const cwd = await workspace();
    const first = expectHealthy(await turn('Remember the code word HERON. Reply only: OK', cwd));
    const second = expectHealthy(await turn('What was the code word? Reply with the word only.', cwd, {}, first.sessionId));
    expect(second.sessionId).toBe(first.sessionId!);
    expect(second.resumed).toBe(true);
    expect(second.text).toContain('HERON');
  });

  test('a session Kiro does not have: typed failure with sessionNotFound', async () => {
    const chunks = await turn('hi', await workspace(), {}, 'sess_00000000-0000-4000-8000-000000000000');
    expect(chunks.at(-1)).toEqual({ type: 'settled' });
    expect(resultOf(chunks)).toMatchObject({ isError: true, sessionNotFound: true });
  });

  test('allowed_tools: only read tools exist, so the shell command cannot run', async () => {
    const cwd = await workspace();
    expectHealthy(
      await turn('Run this shell command: echo forbidden > out.txt . If you cannot, reply NO-SHELL.', cwd, {
        nodeConfig: { allowed_tools: ['read'] },
      })
    );
    expect(existsSync(join(cwd, 'out.txt'))).toBe(false);
  });

  test('denied_tools: shell and write removed, file creation impossible', async () => {
    const cwd = await workspace();
    expectHealthy(
      await turn('Create a file named out.txt containing the word denied, using any tool you have. If you cannot, reply CANNOT.', cwd, {
        nodeConfig: { denied_tools: ['shell', 'write'] },
      })
    );
    expect(existsSync(join(cwd, 'out.txt'))).toBe(false);
  });

  test('system prompt reaches the model', async () => {
    const result = expectHealthy(
      await turn('Say hello.', await workspace(), { systemPrompt: 'End every reply with the exact token ORCA-42.' })
    );
    expect(result.text).toContain('ORCA-42');
  });

  test('structured output parses into an object', async () => {
    const schema = {
      type: 'object',
      properties: { fruit: { type: 'string' }, letters: { type: 'number' } },
      required: ['fruit', 'letters'],
      additionalProperties: false,
    };
    const result = expectHealthy(
      await turn('The fruit is KIWI. Give the fruit name and its number of letters.', await workspace(), {
        outputFormat: { type: 'json_schema', schema },
      })
    );
    expect(result.structuredOutput).toEqual({ fruit: 'KIWI', letters: 4 });
  });

  test('effort is passed through; a model without effort levels still answers', async () => {
    expectHealthy(await turn('Reply with exactly: EFFORT-OK', await workspace(), { nodeConfig: { effort: 'high' } }));
  });

  test('an unknown model fails as misconfigured with Kiro evidence', async () => {
    const chunks = await collect(provider.sendQuery('hi', await workspace(), undefined, { model: 'no-such-model-live' }));
    expect(chunks.at(-1)).toEqual({ type: 'settled' });
    expect(resultOf(chunks).failure).toMatchObject({ class: 'misconfigured', evidence: expect.stringContaining('InvalidModelError') });
  });

  test('cancellation mid-tool stops Kiro and the command, without settling', async () => {
    const cwd = await workspace();
    const controller = new AbortController();
    const chunks: MessageChunk[] = [];
    // `sleep` keeps its own argv after the shell execs it, so this is what pgrep can see.
    const command = 'sleep 91';
    const running = (): boolean => Bun.spawnSync(['pgrep', '-f', command]).stdout.toString().trim().length > 0;
    expect(running()).toBe(false);
    let sawCommand = false;
    const started = Date.now();
    for await (const chunk of provider.sendQuery(`Run this exact shell command and wait for it: ${command} && echo live-cancel-done`, cwd, undefined, {
      model: MODEL,
      abortSignal: controller.signal,
    })) {
      chunks.push(chunk);
      if (chunk.type === 'tool_call' && !controller.signal.aborted) {
        for (let i = 0; i < 40 && !sawCommand; i++) {
          await Bun.sleep(250);
          sawCommand = running();
        }
        controller.abort();
      }
    }
    expect(sawCommand).toBe(true);
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(chunks.some(chunk => chunk.type === 'settled')).toBe(false);
    for (let i = 0; i < 20 && running(); i++) await Bun.sleep(250);
    expect(running()).toBe(false);
  });

  test('credential, models and diagnostics read the real CLI', async () => {
    const signal = new AbortController().signal;
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    expect(await provider.checkCredential({ env, signal })).toEqual({ state: 'usable', source: 'native' });
    expect((await provider.listModels({ signal })).models.map(model => model.id)).toContain(MODEL);
    const diagnostics = await provider.diagnose({ signal, assistantConfig: { model: MODEL } });
    expect(diagnostics.checks.map(check => check.status)).toEqual(['ok', 'ok', 'ok']);
  });
});
