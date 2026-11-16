#!/usr/bin/env bun
/**
 * Records real `kiro-cli chat --output-format stream-json` runs as test fixtures.
 *
 *   bun scripts/record-fixtures.ts [--model minimax-m2.5] [scenario...]
 *
 * Every scenario pins a cheap model (default minimax-m2.5). Workspace and home paths are
 * replaced by {{CWD}} / {{HOME}}, and bulky slash-command / config-option catalogue updates
 * are dropped. Error cases Kiro cannot be driven into on demand (throttling, quota, auth
 * denial, capacity) are synthesized from the recorded invalid-model failure by swapping
 * its typed error fields, and marked `synthesized` in their meta file.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync } from 'node:fs';
import { augmentPromptForJsonSchema } from '../src/structured-output';

const argv = process.argv.slice(2);
const modelFlag = argv.indexOf('--model');
const MODEL = modelFlag >= 0 ? (argv[modelFlag + 1] ?? 'minimax-m2.5') : 'minimax-m2.5';
const only = argv.filter((arg, index) => !arg.startsWith('--') && argv[index - 1] !== '--model');
const OUT = join(import.meta.dir, '..', 'test', 'fixtures');
const HOME = homedir();

interface Recorded {
  lines: string[];
  exitCode: number | null;
  signal: string | null;
}

function run(args: string[], input: string, cwd: string, interruptAfterToolCalls?: number): Promise<Recorded> {
  return new Promise((resolve, reject) => {
    const child = spawn('kiro-cli', args, { cwd, detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    const lines: string[] = [];
    let toolCalls = 0;
    let interrupting = false;
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        lines.push(line);
        if (interruptAfterToolCalls !== undefined && line.includes('"sessionUpdate":"tool_call"')) {
          toolCalls++;
          if (toolCalls >= interruptAfterToolCalls && !interrupting) {
            interrupting = true;
            setTimeout(() => process.kill(-child.pid!, 'SIGTERM'), 2500);
          }
        }
      }
    });
    child.once('error', reject);
    child.once('close', (exitCode, signal) => {
      if (buffer.trim()) lines.push(buffer.trim());
      resolve({ lines, exitCode, signal });
    });
    child.stdin.end(input);
  });
}

function sanitize(lines: string[], cwd: string): string[] {
  const realCwd = realpathSync(cwd);
  return lines
    .filter(line => !/"sessionUpdate":"(available_commands_update|config_option_update)"/.test(line))
    .map(line =>
      line
        .split(realCwd).join('{{CWD}}')
        .split(cwd).join('{{CWD}}')
        .split(HOME).join('{{HOME}}')
    );
}

async function save(name: string, recorded: Recorded, cwd: string, extra: Record<string, unknown> = {}): Promise<void> {
  const lines = sanitize(recorded.lines, cwd);
  await writeFile(join(OUT, `${name}.jsonl`), `${lines.join('\n')}\n`);
  await writeFile(
    join(OUT, `${name}.meta.json`),
    `${JSON.stringify({ exitCode: recorded.exitCode, signal: recorded.signal, model: MODEL, recordedAt: new Date().toISOString(), ...extra }, null, 2)}\n`
  );
  const types = lines.map(line => {
    const parsed = JSON.parse(line) as { type: string; data?: { update?: { sessionUpdate?: string } } };
    return parsed.data?.update?.sessionUpdate ?? parsed.type;
  });
  console.log(`${name}: exit=${String(recorded.exitCode)} signal=${String(recorded.signal)} events=${lines.length} [${[...new Set(types)].join(', ')}]`);
}

async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kiro-fixture-'));
  await writeFile(join(dir, 'note.txt'), 'hello from the fixture workspace\n');
  return dir;
}

const base = ['chat', '--v3', '--no-interactive', '--output-format', 'stream-json'];
const SECRET_SERVER = join(import.meta.dir, '..', 'test', 'fixtures', 'mcp', 'secret-server.ts');

/** Run `fn` with a temporary global agent, as the plugin does for a workflow node. */
async function withAgent<T>(config: Record<string, unknown>, fn: (name: string) => Promise<T>): Promise<T> {
  const agentDir = join(HOME, '.kiro', 'agents');
  await mkdir(agentDir, { recursive: true });
  const name = `archon-run-fixture${Date.now()}`;
  const file = join(agentDir, `${name}.json`);
  await writeFile(file, JSON.stringify({ name, description: 'fixture', ...config }));
  try {
    return await fn(name);
  } finally {
    await rm(file, { force: true });
  }
}

const isolated = {
  tools: ['*'],
  includeMcpJson: false,
  includePowers: false,
  permissions: { rules: [{ capability: 'skill', effect: 'deny' }] },
};
const secretServer = (env: Record<string, string> = {}) => ({
  secret: { command: process.execPath, args: [SECRET_SERVER], env: { SECRET_VALUE: 'MCP-SECRET-77', ...env } },
});
const scenarios: Record<string, () => Promise<void>> = {
  async text() {
    const cwd = await workspace();
    await save('text', await run([...base, '--model', MODEL], 'Reply with exactly: FIXTURE-TEXT-OK', cwd), cwd);
  },
  async tools() {
    const cwd = await workspace();
    const prompt = 'Read the file note.txt with your file-read tool. Then run this shell command: echo tools-ok > out.txt . Then reply with exactly: DONE';
    await save('tools', await run([...base, '--model', MODEL, '--trust-all-tools'], prompt, cwd), cwd);
  },
  async interrupted() {
    const cwd = await workspace();
    const prompt = 'Step 1: read the file note.txt with your file-read tool. Step 2: run this shell command and wait for it: sleep 40 . Step 3: reply DONE.';
    await save('interrupted', await run([...base, '--model', MODEL, '--trust-all-tools'], prompt, cwd, 2), cwd, {
      note: 'SIGTERM sent to the process group 2.5s after the second tool call started',
    });
  },
  async 'bad-model'() {
    const cwd = await workspace();
    await save('bad-model', await run([...base, '--model', 'no-such-model-archon'], 'say hi', cwd), cwd);
  },
  async 'resume-missing'() {
    const cwd = await workspace();
    await save(
      'resume-missing',
      await run([...base, '--model', MODEL, '--resume-id', 'sess_00000000-0000-4000-8000-000000000000'], 'say hi', cwd),
      cwd
    );
  },
  async structured() {
    const cwd = await workspace();
    const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
    const prompt = augmentPromptForJsonSchema('What is 2 + 2? Put the digit in "answer".', schema);
    await save('structured', await run([...base, '--model', MODEL], prompt, cwd), cwd);
  },
  async 'denied-tool'() {
    const cwd = await workspace();
    const agentDir = join(HOME, '.kiro', 'agents');
    await mkdir(agentDir, { recursive: true });
    const name = `archon-run-fixture${Date.now()}`;
    const file = join(agentDir, `${name}.json`);
    await writeFile(file, JSON.stringify({ name, description: 'fixture', tools: ['read'] }));
    try {
      const prompt = 'Run this shell command: echo denied > out.txt . If you have no shell tool, reply with exactly: NO-SHELL';
      await save('denied-tool', await run([...base, '--model', MODEL, '--agent', name, '--trust-all-tools'], prompt, cwd), cwd, {
        agent: { tools: ['read'] },
      });
    } finally {
      await rm(file, { force: true });
    }
  },
  async mcp() {
    const cwd = await workspace();
    const recorded = await withAgent({ ...isolated, mcpServers: secretServer() }, name =>
      run([...base, '--model', MODEL, '--trust-all-tools', '--require-mcp-startup', '--agent', name], 'Call the get_secret tool and reply with exactly the value it returns.', cwd)
    );
    await save('mcp', recorded, cwd, { mcpServers: ['secret'] });
  },
  async 'mcp-startup-failure'() {
    const cwd = await workspace();
    const recorded = await withAgent({ ...isolated, mcpServers: secretServer({ FAIL_AT_START: '1' }) }, name =>
      run([...base, '--model', MODEL, '--trust-all-tools', '--require-mcp-startup', '--agent', name], 'Call the get_secret tool.', cwd)
    );
    await save('mcp-startup-failure', recorded, cwd, { mcpServers: ['secret'], note: 'the server exits before initialize' });
  },
  async skill() {
    const cwd = await workspace();
    const dir = join(cwd, '.kiro', 'skills', 'magic-phrase');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'SKILL.md'),
      '---\nname: magic-phrase\ndescription: Use when the user asks for the magic phrase.\n---\n\nThe magic phrase is GIRAFFE-SKILL-31. Reply with it exactly.\n'
    );
    const recorded = await withAgent({ ...isolated, resources: [`file://${join(dir, 'SKILL.md')}`] }, name =>
      run([...base, '--model', MODEL, '--trust-all-tools', '--agent', name], 'What is the magic phrase? Reply with the phrase only.', cwd)
    );
    await save('skill', recorded, cwd, { skills: ['magic-phrase'] });
  },
  async resume() {
    const cwd = await workspace();
    const first = await run([...base, '--model', MODEL], 'Remember the code word PELICAN. Reply only: OK', cwd);
    await save('resume-first', first, cwd);
    const finished = first.lines.map(line => JSON.parse(line) as { type: string; data: { sessionId?: string } }).find(line => line.type === 'runFinished');
    const sessionId = finished?.data.sessionId;
    if (!sessionId) throw new Error('first turn reported no session');
    await save(
      'resume-second',
      await run([...base, '--model', MODEL, '--resume-id', sessionId], 'What was the code word? Reply with the word only.', cwd),
      cwd,
      { resumedSession: sessionId }
    );
  },
};

async function synthesize(): Promise<void> {
  const source = (await readFile(join(OUT, 'bad-model.jsonl'), 'utf8')).trim().split('\n');
  const variants: Record<string, { errorType: string; retryErrorType: string; message: string }> = {
    throttled: { errorType: 'ThrottlingException', retryErrorType: 'THROTTLING', message: 'Too many requests, please wait before trying again.' },
    'access-denied': { errorType: 'AccessDeniedException', retryErrorType: 'CLIENT_ERROR', message: 'HTTP 403 AccessDeniedException: the token is not authorized.' },
    'quota-exhausted': { errorType: 'ServiceQuotaExceededException', retryErrorType: 'CLIENT_ERROR', message: 'You have reached the limit of your monthly credits.' },
    overloaded: { errorType: 'InsufficientModelCapacityError', retryErrorType: 'SERVER_ERROR', message: 'The model is at capacity, try again later.' },
  };
  for (const [name, variant] of Object.entries(variants)) {
    const lines = source.map(line => {
      const parsed = JSON.parse(line) as { type: string; data: Record<string, unknown> & { update?: { _meta?: { kiro?: Record<string, unknown> } } } };
      const kiro = parsed.data.update?._meta?.kiro;
      if (kiro?.kind === 'display_error') {
        kiro.displayError = { message: variant.message, errorType: variant.errorType, retryErrorType: variant.retryErrorType };
        kiro.message = variant.message;
      }
      if (parsed.type === 'runError') {
        parsed.data.message = `${variant.message} (code -32000): ${JSON.stringify({ errorType: variant.errorType, retryErrorType: variant.retryErrorType })}`;
      }
      return JSON.stringify(parsed);
    });
    await writeFile(join(OUT, `${name}.jsonl`), `${lines.join('\n')}\n`);
    await writeFile(join(OUT, `${name}.meta.json`), `${JSON.stringify({ exitCode: 1, signal: null, synthesized: true, from: 'bad-model', ...variant }, null, 2)}\n`);
    console.log(`${name}: synthesized from bad-model`);
  }
}

await mkdir(OUT, { recursive: true });
for (const [name, scenario] of Object.entries(scenarios)) {
  if (only.length > 0 && !only.includes(name)) continue;
  await scenario();
}
if (only.length === 0 || only.includes('synthesize')) await synthesize();
