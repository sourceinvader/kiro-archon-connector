/**
 * Archon's own provider conformance suite (`runProviderConformance`,
 * `checkCredentialStatuses`) against the Kiro provider three ways, as the
 * community-provider guide asks:
 *   1. in process,
 *   2. as a plugin process over stdio (`bun src/main.ts`),
 *   3. as the compiled release executable (`dist/archon-provider-kiro`, built on demand).
 * Kiro itself is the fake `kiro-cli`, replaying recorded Kiro streams.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type { IAgentProvider, MessageChunk } from '@archon/provider-contract';
import {
  checkCredentialStatuses,
  runProviderConformance,
  type CredentialStatusCase,
  type ProviderFailureCase,
  type ProviderTurnCase,
} from '@archon/provider-contract/conformance';
import { connectProvider, type ConnectedProvider } from '@archon/provider-contract/plugin';
import { descriptor } from '../../src/descriptor';
import { KiroProvider } from '../../src/provider';
import { collect, createFakeKiro, processAlive, type FakeKiro } from '../support/fake-kiro';

const ROOT = join(import.meta.dir, '..', '..');
const BINARY = join(ROOT, 'dist', 'archon-provider-kiro');
const RESUMABLE = 'sess_abcdefab-0000-4000-8000-00000000c0de';

let fake: FakeKiro;
let MCP_FILE: string;
beforeAll(async () => {
  fake = await createFakeKiro();
  MCP_FILE = join(fake.cwd, 'mcp.json');
  await writeFile(MCP_FILE, JSON.stringify({ secret: { command: 'bun', args: ['server.ts'] } }));
  const skillDir = join(fake.cwd, '.kiro', 'skills', 'magic-phrase');
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: magic-phrase\ndescription: test\n---\nThe magic phrase is GIRAFFE-SKILL-31.\n');
  // Always rebuild: a stale executable would test yesterday's code.
  const build = Bun.spawn([process.execPath, 'scripts/build.ts'], { cwd: ROOT, stdout: 'ignore', stderr: 'inherit' });
  if ((await build.exited) !== 0 || !existsSync(BINARY)) throw new Error('plugin build failed');
}, 180_000);
afterAll(() => fake.cleanup());

interface Target {
  provider: IAgentProvider;
  /** A provider whose Kiro reports no signed-in account. */
  signedOut: IAgentProvider;
  close(): Promise<void>;
}

/** Per-request settings: the fake binary, and an env that only the in-process path uses. */
function requestOptions(env: Record<string, string>) {
  return { env, assistantConfig: { kiroPath: fake.bin } };
}

function suiteFor(target: Target, env: Record<string, string>) {
  const run = (provider: IAgentProvider, prompt: string, resume?: string, extra: Record<string, unknown> = {}) =>
    () => provider.sendQuery(prompt, fake.cwd, resume, { ...requestOptions(env), ...extra });
  const turns: ProviderTurnCase[] = [
    { name: 'text', run: run(target.provider, 'fixture:text') },
    { name: 'tools', run: run(target.provider, 'fixture:tools') },
    { name: 'thinking-and-reply', run: run(target.provider, 'fixture:resume-first') },
    {
      name: 'structured',
      run: run(target.provider, 'fixture:structured', undefined, {
        outputFormat: { type: 'json_schema', schema: { type: 'object', properties: { answer: { type: 'string' } } } },
      }),
    },
    { name: 'resume', run: run(target.provider, 'What was the code word?', RESUMABLE) },
    { name: 'restricted-tools', run: run(target.provider, 'fixture:denied-tool', undefined, { nodeConfig: { allowed_tools: ['read'] } }) },
    { name: 'mcp node', run: run(target.provider, 'fixture:mcp', undefined, { nodeConfig: { mcp: MCP_FILE } }) },
    { name: 'skill node', run: run(target.provider, 'fixture:skill', undefined, { nodeConfig: { skills: ['magic-phrase'] } }) },
  ];
  const failureCases: ProviderFailureCase[] = [
    { name: 'invalid model', expected: 'misconfigured', evidence: 'InvalidModelError', run: run(target.provider, 'fixture:bad-model') },
    { name: 'throttled', expected: 'rate_limited', evidence: 'ThrottlingException', run: run(target.provider, 'fixture:throttled') },
    { name: 'access denied', expected: 'auth', evidence: 'HTTP 403', run: run(target.provider, 'fixture:access-denied') },
    { name: 'quota', expected: 'quota_exhausted', evidence: 'monthly credits', run: run(target.provider, 'fixture:quota-exhausted') },
    { name: 'capacity', expected: 'overloaded', evidence: 'capacity', run: run(target.provider, 'fixture:overloaded') },
    { name: 'signed out', expected: 'auth', evidence: 'kiro-cli login', run: run(target.signedOut, 'fixture:text') },
    { name: 'missing session', expected: 'unknown', evidence: 'not found', run: run(target.provider, 'hi', 'sess_00000000-0000-4000-8000-000000000000') },
    {
      name: 'mcp server does not start',
      expected: 'misconfigured',
      evidence: 'mcp_connection_error',
      run: run(target.provider, 'fixture:mcp-startup-failure', undefined, { nodeConfig: { mcp: MCP_FILE } }),
    },
    {
      name: 'skill not installed',
      expected: 'misconfigured',
      evidence: 'ghost-skill',
      run: run(target.provider, 'fixture:skill', undefined, { nodeConfig: { skills: ['ghost-skill'] } }),
    },
  ];
  return {
    capabilities: target.provider.getCapabilities(),
    turns,
    failureCases,
    toolTurn: { name: 'interrupted tool turn', run: run(target.provider, 'fixture:interrupted') },
  };
}

function inProcess(): Target {
  return { provider: new KiroProvider(), signedOut: new KiroProvider(), close: async () => {} };
}

async function overStdio(command: string[], env: Record<string, string>): Promise<{ client: ConnectedProvider; child: ChildProcess; close(): Promise<void> }> {
  const child = spawn(command[0]!, command.slice(1), { cwd: ROOT, env, stdio: ['pipe', 'pipe', 'inherit'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  const client = await connectProvider({
    readable: Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    writable: Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
  });
  return {
    client,
    child,
    close: async () => {
      await client.close();
      await closed;
    },
  };
}

async function processTarget(command: string[]): Promise<Target> {
  const main = await overStdio(command, fake.env({ FAKE_KIRO_SESSIONS: RESUMABLE, KIRO_CLI_PATH: fake.bin }));
  const signedOut = await overStdio(command, fake.env({ FAKE_KIRO_ACCOUNT: 'none', KIRO_CLI_PATH: fake.bin }));
  return {
    provider: main.client,
    signedOut: signedOut.client,
    close: async () => {
      await main.close();
      await signedOut.close();
    },
  };
}

const variants: [string, () => Promise<Target>][] = [
  ['in process', async () => inProcess()],
  ['plugin process (source)', () => processTarget([process.execPath, 'src/main.ts'])],
  ['compiled executable', () => processTarget([BINARY])],
];

for (const [label, make] of variants) {
  describe(`conformance: ${label}`, () => {
    let target: Target;
    beforeAll(async () => {
      target = await make();
    }, 60_000);
    afterAll(() => target.close());

    test('runProviderConformance reports no violations', async () => {
      // In process, the signed-out provider needs its own env; process targets carry it in the child env.
      const env = fake.env({ FAKE_KIRO_SESSIONS: RESUMABLE });
      const suite = suiteFor(target, env);
      if (label === 'in process') {
        const signedOutEnv = fake.env({ FAKE_KIRO_ACCOUNT: 'none' });
        suite.failureCases = suite.failureCases.map(failureCase =>
          failureCase.name === 'signed out'
            ? { ...failureCase, run: () => target.signedOut.sendQuery('fixture:text', fake.cwd, undefined, requestOptions(signedOutEnv)) }
            : failureCase
        );
      }
      const violations = await runProviderConformance(suite);
      expect(violations).toEqual([]);
    }, 120_000);

    test('checkCredentialStatuses: states are right and the API key never leaks', async () => {
      const secret = 'kiro-api-key-do-not-echo-123';
      const check = (provider: IAgentProvider, env: Record<string, string>, kiroPath = fake.bin) => () =>
        provider.checkCredential({ env, signal: new AbortController().signal, assistantConfig: { kiroPath } });
      const cases: CredentialStatusCase[] = [
        { name: 'native login', expected: 'usable', secret, check: check(target.provider, fake.env()) },
        { name: 'signed out', expected: 'not_connected', secret, check: check(target.signedOut, fake.env({ FAKE_KIRO_ACCOUNT: 'none' })) },
        { name: 'missing kiro-cli', expected: 'check_failed', secret, check: check(target.provider, fake.env(), '/nonexistent/kiro-cli') },
      ];
      if (label === 'in process') {
        cases.push({ name: 'api key', expected: 'usable', secret, check: check(target.provider, fake.env({ FAKE_KIRO_ACCOUNT: 'none', KIRO_API_KEY: secret })) });
      }
      expect(await checkCredentialStatuses(cases)).toEqual([]);
    }, 60_000);

    test('cancellation stops Kiro and its children without settling', async () => {
      const controller = new AbortController();
      const chunks: MessageChunk[] = [];
      for await (const chunk of target.provider.sendQuery('fixture:hang', fake.cwd, undefined, {
        ...requestOptions(fake.env()),
        abortSignal: controller.signal,
      })) {
        chunks.push(chunk);
        if (chunk.type === 'tool_call') controller.abort();
      }
      expect(chunks.some(chunk => chunk.type === 'settled')).toBe(false);
      const pid = Number(await readFile(join(fake.stateDir, 'grandchild.pid'), 'utf8'));
      for (let i = 0; i < 50 && processAlive(pid); i++) await Bun.sleep(100);
      expect(processAlive(pid)).toBe(false);
    }, 30_000);

    if (label !== 'in process') {
      test('handshake carries the descriptor; models and diagnostics answer over RPC', async () => {
        const client = target.provider as ConnectedProvider;
        expect(client.descriptor).toEqual(descriptor);
        expect(client.getCapabilities()).toEqual(descriptor.capabilities);
        const signal = new AbortController().signal;
        const models = await client.listModels({ signal });
        expect(models.models.map(model => model.id)).toContain('minimax-m2.5');
        const diagnostics = await client.diagnose({ signal, assistantConfig: { kiroPath: fake.bin, model: 'minimax-m2.5' } });
        expect(diagnostics.checks.map(check => check.status)).toEqual(['ok', 'ok', 'ok']);
      }, 60_000);

      test('the stdout channel carries only RPC: a full turn round-trips cleanly', async () => {
        const chunks = await collect(target.provider.sendQuery('fixture:tools', fake.cwd, undefined, requestOptions(fake.env())));
        expect(chunks.at(-1)).toEqual({ type: 'settled' });
      }, 60_000);
    }
  });
}
