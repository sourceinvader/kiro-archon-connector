/**
 * A stand-in for `kiro-cli` that replays recorded stream-json fixtures, so unit and
 * conformance tests exercise the real process, stdin, line and exit-code paths without
 * a Kiro account. Not a mock of the mapper: the provider spawns this exactly as it
 * spawns Kiro.
 *
 * Environment:
 *   FAKE_KIRO_ACCOUNT=none          whoami reports `{"account":null}`
 *   FAKE_KIRO_SESSIONS=a,b          sessions `--list-sessions` reports (and resume accepts)
 *   FAKE_KIRO_LOG=/path/log.jsonl   append one record per chat invocation
 *   FAKE_KIRO_STATE=/path/dir       where the `hang` scenario records its child pid
 *
 * The prompt picks the fixture: `fixture:<name>` anywhere in it, else `text`. Special
 * scenarios: `hang` (starts a real `sleep` grandchild and waits for SIGTERM, as Kiro
 * does), `slow-text` (text fixture with a pause between lines).
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const FIXTURES = join(import.meta.dir, '..', 'fixtures');
const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const out = (line: unknown): void => {
  process.stdout.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`);
};
const sessions = (process.env.FAKE_KIRO_SESSIONS ?? '').split(',').filter(Boolean);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function fixtureLines(name: string, cwd: string): string[] {
  const home = process.env.HOME ?? homedir();
  return readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map(line => line.split('{{CWD}}').join(cwd).split('{{HOME}}').join(home));
}

function fixtureExit(name: string): number {
  const meta = JSON.parse(readFileSync(join(FIXTURES, `${name}.meta.json`), 'utf8')) as {
    exitCode: number | null;
    signal: string | null;
  };
  return meta.exitCode ?? (meta.signal ? 143 : 1);
}

function agentExists(name: string, cwd: string): boolean {
  if (['kiro_default', 'kiro_help', 'kiro_planner'].includes(name)) return true;
  const kiroHome = process.env.KIRO_HOME || join(process.env.HOME ?? homedir(), '.kiro');
  return [join(cwd, '.kiro', 'agents'), join(kiroHome, 'agents')].some(
    dir => existsSync(join(dir, `${name}.json`)) || existsSync(join(dir, `${name}.md`))
  );
}

function agentFile(name: string, cwd: string): unknown {
  const kiroHome = process.env.KIRO_HOME || join(process.env.HOME ?? homedir(), '.kiro');
  for (const dir of [join(cwd, '.kiro', 'agents'), join(kiroHome, 'agents')]) {
    const file = join(dir, `${name}.json`);
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  }
  return undefined;
}

async function replay(name: string, cwd: string, delayMs: number, sessionOverride?: string): Promise<never> {
  for (const line of fixtureLines(name, cwd)) {
    out(sessionOverride ? line.replace(/sess_[0-9a-f-]{36}/g, sessionOverride) : line);
    if (delayMs > 0) await Bun.sleep(delayMs);
  }
  process.exit(fixtureExit(name));
}

async function hang(cwd: string): Promise<void> {
  const sessionId = 'sess_11111111-2222-4333-8444-555555555555';
  out({ type: 'runStarted', data: { payloadSchema: 'acp', acpProtocolVersion: 1, engine: 'v3' } });
  out({
    type: 'sessionUpdate',
    data: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Starting a long command.' } } },
  });
  // Start the tool's process before announcing the call, as Kiro does, so a cancellation
  // that reacts to the announcement always finds a live grandchild in the group.
  const child = spawn('sleep', ['300'], { stdio: 'ignore' });
  if (process.env.FAKE_KIRO_STATE) writeFileSync(join(process.env.FAKE_KIRO_STATE, 'grandchild.pid'), String(child.pid));
  out({
    type: 'sessionUpdate',
    data: {
      sessionId,
      update: { sessionUpdate: 'tool_call', toolCallId: 'tooluse_hang', title: 'sleep 300', kind: 'execute', rawInput: { command: 'sleep 300', cwd } },
    },
  });
  process.on('SIGTERM', () => {
    // Like Kiro: report the interruption, then exit. The grandchild is left to the group signal.
    out({ type: 'runError', data: { sessionId, stage: 'interrupted', message: 'the run was ended by a signal' } });
    process.exit(143);
  });
  process.on('SIGINT', () => {
    // Kiro without a terminal ignores SIGINT.
  });
  await new Promise(() => {});
}

async function chat(): Promise<void> {
  const cwd = process.cwd();
  const prompt = await readStdin();
  const agent = flag('--agent');
  if (process.env.FAKE_KIRO_LOG) {
    appendFileSync(
      process.env.FAKE_KIRO_LOG,
      `${JSON.stringify({ args, cwd, prompt, agentFile: agent ? agentFile(agent, cwd) : undefined })}\n`
    );
  }
  if (prompt.trim().length === 0) {
    process.stderr.write('error: instruction must not be empty\n');
    process.exit(2);
  }
  if (agent && !agentExists(agent, cwd)) {
    out({ type: 'runStarted', data: { payloadSchema: 'acp', acpProtocolVersion: 1, engine: 'v3' } });
    out({ type: 'runError', data: { sessionId: 'sess_99999999-0000-4000-8000-000000000000', stage: 'init', message: `agent "${agent}" not found, stopping (exit 4)` } });
    process.exit(4);
  }
  const resume = flag('--resume-id');
  const requested = /fixture:([\w-]+)/.exec(prompt)?.[1];
  if (requested === 'hang') return hang(cwd);
  if (flag('--model')?.startsWith('no-such-model')) return replay('bad-model', cwd, 0);
  if (resume && !requested) {
    return sessions.includes(resume) ? replay('resume-second', cwd, 0, resume) : replay('resume-missing', cwd, 0);
  }
  if (requested === 'slow-text') return replay('text', cwd, 150);
  return replay(requested ?? 'text', cwd, 0);
}

async function main(): Promise<void> {
  if (args[0] === '--version') {
    out('kiro-cli 2.37.1-fake');
    return;
  }
  if (args[0] === 'whoami') {
    out(process.env.FAKE_KIRO_ACCOUNT === 'none' ? { account: null } : { accountType: 'BuilderId', region: 'us-east-1' });
    return;
  }
  if (args[0] === 'chat' && args.includes('--list-models')) {
    out({
      models: [
        { model_name: 'auto', model_id: 'auto', rate_multiplier: 1, rate_unit: 'Credit', context_window_tokens: 1000000 },
        { model_name: 'minimax-m2.5', model_id: 'minimax-m2.5', rate_multiplier: 0.25, rate_unit: 'Credit', context_window_tokens: 196000 },
      ],
      default_model: 'auto',
    });
    return;
  }
  if (args[0] === 'chat' && args.includes('--list-sessions')) {
    out([{ cwd: process.cwd(), sessions: sessions.map(sessionId => ({ sessionId, source: 'v3', status: 'idle' })), complete: true }]);
    return;
  }
  if (args[0] === 'chat') return chat();
  process.stderr.write(`fake kiro-cli: unsupported ${args.join(' ')}\n`);
  process.exit(2);
}

await main();
