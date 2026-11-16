import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { providerChunkSchema, type MessageChunk, type ResultChunk, type SendQueryOptions } from '@archon/provider-contract';
import { buildChatArgs, KiroProvider, resolveTurnSettings } from '../../src/provider';
import { collect, createFakeKiro, processAlive, type FakeKiro } from '../support/fake-kiro';

let fake: FakeKiro;
let provider: KiroProvider;

beforeEach(async () => {
  fake = await createFakeKiro();
  provider = new KiroProvider();
});
afterEach(() => fake.cleanup());

function turn(prompt: string, options: SendQueryOptions = {}, resume?: string, envOverrides: Record<string, string> = {}): Promise<MessageChunk[]> {
  return collect(
    provider.sendQuery(prompt, fake.cwd, resume, {
      ...options,
      env: fake.env(envOverrides),
      assistantConfig: { kiroPath: fake.bin, ...options.assistantConfig },
    })
  );
}

const resultOf = (chunks: MessageChunk[]): ResultChunk => chunks.find((chunk): chunk is ResultChunk => chunk.type === 'result')!;

function expectSettledTurn(chunks: MessageChunk[]): void {
  for (const chunk of chunks) expect(providerChunkSchema.safeParse(chunk).success).toBe(true);
  expect(chunks.at(-1)).toEqual({ type: 'settled' });
  expect(chunks.filter(chunk => chunk.type === 'result')).toHaveLength(1);
  expect(chunks.filter(chunk => chunk.type === 'settled')).toHaveLength(1);
}

describe('resolveTurnSettings / buildChatArgs', () => {
  test('request model wins over config; node effort clamps; defaults trust tools', () => {
    const settings = resolveTurnSettings(
      { model: 'claude-haiku-4.5', assistantConfig: { model: 'auto', effort: 'low' }, nodeConfig: { effort: 'ultra' } },
      {}
    );
    expect(settings).toMatchObject({ bin: 'kiro-cli', model: 'claude-haiku-4.5', effort: 'max', trustAllTools: true });
  });

  test('kiroPath beats KIRO_CLI_PATH beats PATH lookup', () => {
    expect(resolveTurnSettings({}, { KIRO_CLI_PATH: '/env/kiro' }).bin).toBe('/env/kiro');
    expect(resolveTurnSettings({ assistantConfig: { kiroPath: '/cfg/kiro' } }, { KIRO_CLI_PATH: '/env/kiro' }).bin).toBe('/cfg/kiro');
  });

  test('node tool lists and prompts become the agent spec', () => {
    const { agentSpec } = resolveTurnSettings(
      {
        systemPrompt: ['Line one.', 'Line two.'],
        appendSystemPrompt: 'Extra.',
        assistantConfig: { agent: 'reviewer' },
        // Raw YAML can carry anything: a non-string entry is dropped, whitespace trimmed.
        nodeConfig: { allowed_tools: ['read', ' grep ', 42] as unknown as string[], denied_tools: ['shell'] },
      },
      {}
    );
    expect(agentSpec).toEqual({
      baseAgent: 'reviewer',
      allowedTools: ['read', 'grep'],
      deniedTools: ['shell'],
      systemPrompt: 'Line one.\n\nLine two.',
      appendSystemPrompt: 'Extra.',
    });
  });

  test('chat arguments: V3 headless stream-json, instruction never in argv', () => {
    expect(buildChatArgs({ trustAllTools: true })).toEqual(['chat', '--v3', '--no-interactive', '--output-format', 'stream-json', '--trust-all-tools']);
    expect(
      buildChatArgs({ trustAllTools: false, model: 'm', agent: 'a', effort: 'high', resumeSessionId: 'sess_1' })
    ).toEqual(['chat', '--v3', '--no-interactive', '--output-format', 'stream-json', '--resume-id', 'sess_1', '--model', 'm', '--agent', 'a', '--effort', 'high']);
  });
});

describe('sendQuery', () => {
  test('text turn: reply, result with session, then settled', async () => {
    const chunks = await turn('fixture:text');
    expectSettledTurn(chunks);
    expect(chunks.some(chunk => chunk.type === 'agent_message_chunk' && chunk.text.includes('FIXTURE-TEXT-OK'))).toBe(true);
    expect(resultOf(chunks)).toMatchObject({ sessionId: expect.stringMatching(/^sess_/), text: expect.stringContaining('FIXTURE-TEXT-OK'), stopReason: 'end_turn' });
    expect(resultOf(chunks).isError).toBeUndefined();
  });

  test('the prompt goes to stdin, never argv, with model and trust flags', async () => {
    await turn('fixture:text secret-prompt-text', { model: 'minimax-m2.5' });
    const [call] = await fake.invocations();
    expect(call?.prompt).toBe('fixture:text secret-prompt-text');
    expect(call?.args.join(' ')).not.toContain('secret-prompt-text');
    expect(call?.args).toEqual(['chat', '--v3', '--no-interactive', '--output-format', 'stream-json', '--model', 'minimax-m2.5', '--trust-all-tools']);
    expect(call?.cwd).toEndWith('/work');
  });

  test('trustAllTools: false drops the flag', async () => {
    await turn('fixture:text', { assistantConfig: { trustAllTools: false } });
    expect((await fake.invocations())[0]?.args).not.toContain('--trust-all-tools');
  });

  test('tool turn: every call closes before the result', async () => {
    const chunks = await turn('fixture:tools');
    expectSettledTurn(chunks);
    const calls = chunks.filter(chunk => chunk.type === 'tool_call');
    const updates = chunks.filter(chunk => chunk.type === 'tool_call_update');
    expect(calls).toHaveLength(2);
    expect(updates).toHaveLength(2);
    expect(chunks.indexOf(updates.at(-1)!)).toBeLessThan(chunks.indexOf(resultOf(chunks)));
  });

  test('structured output: augments the prompt and parses the reply', async () => {
    const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
    const chunks = await turn('fixture:structured', { outputFormat: { type: 'json_schema', schema } });
    expect(resultOf(chunks).structuredOutput).toEqual({ answer: '4' });
    const [call] = await fake.invocations();
    expect(call?.prompt).toContain('"answer"');
    expect(call?.prompt.startsWith('fixture:structured')).toBe(true);
  });

  test('structured output that does not parse is left out, not invented', async () => {
    const chunks = await turn('fixture:text', { outputFormat: { type: 'json_schema', schema: { type: 'object' } } });
    expect(resultOf(chunks).structuredOutput).toBeUndefined();
    expect(resultOf(chunks).isError).toBeUndefined();
  });

  const failures: [string, string, string][] = [
    ['bad-model', 'misconfigured', 'InvalidModelError'],
    ['throttled', 'rate_limited', 'ThrottlingException'],
    ['access-denied', 'auth', 'HTTP 403'],
    ['quota-exhausted', 'quota_exhausted', 'monthly credits'],
    ['overloaded', 'overloaded', 'capacity'],
  ];
  for (const [fixture, failureClass, evidence] of failures) {
    test(`typed failure: ${fixture} → ${failureClass}`, async () => {
      const chunks = await turn(`fixture:${fixture}`);
      expectSettledTurn(chunks);
      const result = resultOf(chunks);
      expect(result.isError).toBe(true);
      expect(result.failure?.class).toBe(failureClass as never);
      expect(result.failure?.evidence).toContain(evidence);
      expect(result.errors?.[0]).toBe(result.failure?.evidence);
    });
  }

  test('bad model via the model setting', async () => {
    const result = resultOf(await turn('say hi', { model: 'no-such-model-x' }));
    expect(result.failure).toMatchObject({ class: 'misconfigured' });
    expect(result.errorSubtype).toBe('InvalidModelError');
  });

  test('externally interrupted turn: open call cancelled, transient failure, settled', async () => {
    const chunks = await turn('fixture:interrupted');
    expectSettledTurn(chunks);
    const updates = chunks.filter(chunk => chunk.type === 'tool_call_update');
    expect(updates.map(update => update.type === 'tool_call_update' && update.status)).toEqual(['completed', 'cancelled']);
    expect(resultOf(chunks).failure).toMatchObject({ class: 'transient', evidence: expect.stringContaining('ended by a signal') });
  });

  test('resume: passes --resume-id and reports the session restored', async () => {
    const session = 'sess_abcdefab-0000-4000-8000-000000000001';
    const chunks = await turn('What was the code word?', {}, session, { FAKE_KIRO_SESSIONS: session });
    expectSettledTurn(chunks);
    expect(resultOf(chunks)).toMatchObject({ sessionId: session, resumed: true, text: 'PELICAN' });
    expect((await fake.invocations())[0]?.args).toContain('--resume-id');
  });

  test('resume of a session Kiro no longer has: sessionNotFound from the session list', async () => {
    const chunks = await turn('hi', {}, 'sess_00000000-0000-4000-8000-000000000000', { FAKE_KIRO_SESSIONS: 'sess_other' });
    expectSettledTurn(chunks);
    expect(resultOf(chunks)).toMatchObject({ isError: true, sessionNotFound: true, failure: { class: 'unknown' } });
  });

  test('missing binary: misconfigured, no hang', async () => {
    const chunks = await turn('hi', { assistantConfig: { kiroPath: join(fake.cwd, 'no-kiro-here') } });
    expectSettledTurn(chunks);
    expect(resultOf(chunks).failure).toMatchObject({ class: 'misconfigured', evidence: expect.stringContaining('not found') });
  });

  test('signed out: auth failure before any chat process (no browser login)', async () => {
    const chunks = await turn('fixture:text', {}, undefined, { FAKE_KIRO_ACCOUNT: 'none' });
    expectSettledTurn(chunks);
    expect(resultOf(chunks).failure).toMatchObject({ class: 'auth', evidence: expect.stringContaining('kiro-cli login') });
    expect(await fake.invocations()).toEqual([]);
  });

  test('with KIRO_API_KEY the login check is skipped', async () => {
    const chunks = await turn('fixture:text', {}, undefined, { FAKE_KIRO_ACCOUNT: 'none', KIRO_API_KEY: 'test-key' });
    expect(resultOf(chunks).isError).toBeUndefined();
  });

  test('empty prompt and container execution are refused up front', async () => {
    expect(resultOf(await turn('   ')).failure).toMatchObject({ class: 'misconfigured' });
    expect(resultOf(await turn('hi', { execContext: { kind: 'container', containerId: 'c1' } })).failure).toMatchObject({ class: 'misconfigured' });
  });
});

describe('tool restrictions and prompts through an ephemeral agent', () => {
  const agentsDir = (): string => join(fake.home, '.kiro', 'agents');

  test('allowed_tools / denied_tools / system prompt reach Kiro as an agent, removed afterwards', async () => {
    const chunks = await turn('fixture:text', {
      systemPrompt: 'Answer tersely.',
      nodeConfig: { allowed_tools: ['read', 'grep'], denied_tools: ['shell'] },
    });
    expectSettledTurn(chunks);
    const [call] = await fake.invocations();
    const agentName = call?.args[call.args.indexOf('--agent') + 1];
    expect(agentName).toMatch(/^archon-run-/);
    expect(call?.agentFile).toMatchObject({ name: agentName, tools: ['read', 'grep'], excludedTools: ['shell'], prompt: 'Answer tersely.' });
    expect((await readdir(agentsDir())).filter(name => name.startsWith('archon-run-'))).toEqual([]);
  });

  test('no restrictions: no agent file, no --agent', async () => {
    await turn('fixture:text');
    const [call] = await fake.invocations();
    expect(call?.args).not.toContain('--agent');
    expect(existsSync(agentsDir())).toBe(false);
  });

  test('a configured agent is passed through as-is when nothing needs overriding', async () => {
    await mkdir(join(fake.cwd, '.kiro', 'agents'), { recursive: true });
    await writeFile(join(fake.cwd, '.kiro', 'agents', 'reviewer.json'), JSON.stringify({ name: 'reviewer', prompt: 'Review.' }));
    await turn('fixture:text', { assistantConfig: { agent: 'reviewer' } });
    const [call] = await fake.invocations();
    expect(call?.args.slice(call.args.indexOf('--agent'), call.args.indexOf('--agent') + 2)).toEqual(['--agent', 'reviewer']);
  });

  test('a configured agent is cloned when the node restricts tools', async () => {
    await mkdir(join(fake.cwd, '.kiro', 'agents'), { recursive: true });
    await writeFile(join(fake.cwd, '.kiro', 'agents', 'reviewer.json'), JSON.stringify({ name: 'reviewer', prompt: 'Review.', tools: ['*'] }));
    await turn('fixture:text', { assistantConfig: { agent: 'reviewer' }, nodeConfig: { denied_tools: ['write'] } });
    const [call] = await fake.invocations();
    expect(call?.agentFile).toMatchObject({ prompt: 'Review.', tools: ['*'], excludedTools: ['write'] });
  });

  test('a configured agent Kiro cannot find fails as misconfigured (exit 4)', async () => {
    const result = resultOf(await turn('fixture:text', { assistantConfig: { agent: 'ghost' } }));
    expect(result.failure).toMatchObject({ class: 'misconfigured', evidence: expect.stringContaining('ghost') });
  });

  test('restrictions on an agent without a JSON definition fail before spawning', async () => {
    const result = resultOf(await turn('fixture:text', { assistantConfig: { agent: 'ghost' }, nodeConfig: { allowed_tools: ['read'] } }));
    expect(result.failure).toMatchObject({ class: 'misconfigured', evidence: expect.stringContaining('ghost') });
    expect(await fake.invocations()).toEqual([]);
  });

  test('the agent file is removed even when the turn fails', async () => {
    await turn('fixture:bad-model', { nodeConfig: { denied_tools: ['shell'] } });
    expect((await readdir(agentsDir())).filter(name => name.startsWith('archon-run-'))).toEqual([]);
  });
});

describe('cancellation', () => {
  test('abort kills the whole process group, closes the open call, never settles', async () => {
    const controller = new AbortController();
    const chunks: MessageChunk[] = [];
    const started = Date.now();
    for await (const chunk of provider.sendQuery('fixture:hang', fake.cwd, undefined, {
      env: fake.env(),
      assistantConfig: { kiroPath: fake.bin },
      nodeConfig: { denied_tools: ['web'] },
      abortSignal: controller.signal,
    })) {
      chunks.push(chunk);
      if (chunk.type === 'tool_call') controller.abort();
    }
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(chunks.some(chunk => chunk.type === 'settled')).toBe(false);
    expect(chunks.some(chunk => chunk.type === 'result')).toBe(false);
    expect(chunks.at(-1)).toEqual({ type: 'tool_call_update', toolCallId: 'tooluse_hang', status: 'cancelled' });
    const grandchild = Number(await readFile(join(fake.stateDir, 'grandchild.pid'), 'utf8'));
    await Bun.sleep(200);
    expect(processAlive(grandchild)).toBe(false);
    expect((await readdir(join(fake.home, '.kiro', 'agents'))).filter(name => name.startsWith('archon-run-'))).toEqual([]);
  });

  test('a consumer that stops reading early also stops Kiro', async () => {
    for await (const chunk of provider.sendQuery('fixture:hang', fake.cwd, undefined, { env: fake.env(), assistantConfig: { kiroPath: fake.bin } })) {
      if (chunk.type === 'tool_call') break;
    }
    const grandchild = Number(await readFile(join(fake.stateDir, 'grandchild.pid'), 'utf8'));
    await Bun.sleep(200);
    expect(processAlive(grandchild)).toBe(false);
  });

  test('already-aborted signal: returns without spawning a chat', async () => {
    const controller = new AbortController();
    controller.abort();
    const chunks = await collect(
      provider.sendQuery('fixture:text', fake.cwd, undefined, { env: fake.env(), assistantConfig: { kiroPath: fake.bin }, abortSignal: controller.signal })
    );
    expect(chunks.some(chunk => chunk.type === 'settled')).toBe(false);
    expect(await fake.invocations()).toEqual([]);
  });
});

describe('credentials, models and diagnostics', () => {
  const check = (env: Record<string, string>, assistantConfig: Record<string, unknown> = { kiroPath: fake.bin }) =>
    provider.checkCredential({ env, signal: new AbortController().signal, assistantConfig });

  test('checkCredential maps the native login', async () => {
    expect(await check(fake.env())).toEqual({ state: 'usable', source: 'native' });
    expect(await check(fake.env({ FAKE_KIRO_ACCOUNT: 'none' }))).toEqual({ state: 'not_connected', source: 'native' });
    expect(await check(fake.env({ FAKE_KIRO_ACCOUNT: 'none', KIRO_API_KEY: 'k-123' }))).toEqual({ state: 'usable', source: 'native' });
    expect(await check(fake.env(), { kiroPath: '/nope/kiro-cli' })).toMatchObject({ state: 'check_failed' });
    expect(
      await provider.checkCredential({ env: fake.env(), signal: new AbortController().signal, execContext: { kind: 'container', containerId: 'c' } })
    ).toEqual({ state: 'not_checked', source: 'native' });
  });

  test('listModels and diagnose read Kiro without a model session', async () => {
    const previous = process.env.KIRO_CLI_PATH;
    process.env.KIRO_CLI_PATH = fake.bin;
    try {
      const models = await provider.listModels({ signal: new AbortController().signal });
      expect(models.models).toContainEqual({ id: 'minimax-m2.5', label: 'minimax-m2.5 (0.25x Credit)' });
      const ok = await provider.diagnose({ signal: new AbortController().signal, assistantConfig: { model: 'minimax-m2.5' } });
      expect(ok.checks.map(c => [c.id, c.status])).toEqual([['kiro-cli', 'ok'], ['login', 'ok'], ['model', 'ok']]);
      const bad = await provider.diagnose({ signal: new AbortController().signal, assistantConfig: { model: 'gpt-nope' } });
      expect(bad.checks.find(c => c.id === 'model')).toMatchObject({ status: 'fail', remedy: expect.stringContaining('minimax-m2.5') });
      const missing = await provider.diagnose({ signal: new AbortController().signal, assistantConfig: { kiroPath: '/nope/kiro-cli' } });
      expect(missing.checks).toEqual([expect.objectContaining({ id: 'kiro-cli', status: 'fail' })]);
    } finally {
      if (previous === undefined) delete process.env.KIRO_CLI_PATH;
      else process.env.KIRO_CLI_PATH = previous;
    }
  });
});
