#!/usr/bin/env bun
/**
 * End-to-end: the real Archon CLI runs this repository's sample workflows
 * (.archon/workflows/kiro-*.yaml) on real Kiro through the compiled plugin.
 *
 *   ARCHON_BIN=/path/to/archon-v0.14.0 bun e2e/run.ts
 *
 * Everything lives under .e2e/ (an isolated ARCHON_HOME and a throwaway git project that
 * holds copies of the sample workflows), so the operator's ~/.archon is never touched.
 * The samples pin a cheap model (minimax-m2.5).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import packageJson from '../package.json';
import { installLocalPlugin, RECEIPT_ID } from './install';

const ROOT = join(import.meta.dir, '..');
const E2E = join(ROOT, '.e2e');
const HOME = join(E2E, 'archon-home');
const PROJECT = join(E2E, 'project');
const LOGS = join(E2E, 'logs');
const SAMPLES = join(ROOT, '.archon');
/** The command kiro-cancel-demo asks Kiro to run; `sleep` keeps this argv after exec. */
const CANCEL_MARKER = 'sleep 237';
const ARCHON = process.env.ARCHON_BIN;
if (!ARCHON || !existsSync(ARCHON)) {
  console.error('Set ARCHON_BIN to an Archon >= 0.14.0 CLI binary.');
  process.exit(2);
}

const results: { name: string; ok: boolean; detail: string }[] = [];
function record(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const PLAYWRIGHT_CLI = '@playwright/cli@0.1.24';
const SHIM_BIN = join(E2E, 'bin');
const archonEnv = (): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  // The shim stands in for `npm install -g @playwright/cli` without touching global npm.
  return { ...env, PATH: `${SHIM_BIN}:${env.PATH ?? ''}`, ARCHON_HOME: HOME, DO_NOT_TRACK: '1', NO_COLOR: '1' };
};

async function archon(name: string, args: string[], timeoutMs = 900_000): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn([ARCHON!, ...args], { cwd: PROJECT, env: archonEnv(), stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  const out = `${stdout}\n${stderr}`;
  await writeFile(join(LOGS, `${name}.log`), `$ archon ${args.join(' ')}\n(exit ${code})\n\n${out}`);
  return { code, out };
}

function git(...args: string[]): string {
  const identity = { GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.invalid', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.invalid' };
  const result = Bun.spawnSync(['git', ...args], { cwd: PROJECT, env: { ...archonEnv(), ...identity } });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

async function setup(): Promise<string[]> {
  await rm(E2E, { recursive: true, force: true });
  await mkdir(LOGS, { recursive: true });
  await mkdir(HOME, { recursive: true });
  await mkdir(PROJECT, { recursive: true });
  await writeFile(join(HOME, 'config.yaml'), 'defaultAssistant: kiro\nassistants:\n  kiro:\n    model: minimax-m2.5\n');
  // The samples and everything they reference: MCP configs, the demo skill, the demo MCP server.
  await cp(SAMPLES, join(PROJECT, '.archon'), { recursive: true });
  await cp(join(ROOT, '.kiro', 'skills'), join(PROJECT, '.kiro', 'skills'), { recursive: true });
  await cp(join(ROOT, 'test', 'fixtures', 'mcp'), join(PROJECT, 'test', 'fixtures', 'mcp'), { recursive: true });
  await writeFile(join(PROJECT, 'README.md'), '# kiro e2e project\n\nA throwaway repository for the Kiro provider end-to-end run.\n');
  await cp(join(ROOT, '.gitignore'), join(PROJECT, '.gitignore'));
  // kiro-playwright-cli's documented setup: the skill in the repo, playwright-cli on PATH.
  await mkdir(SHIM_BIN, { recursive: true });
  await writeFile(join(SHIM_BIN, 'playwright-cli'), `#!/bin/sh\nexec npx -y ${PLAYWRIGHT_CLI} "$@"\n`, { mode: 0o755 });
  const skill = Bun.spawnSync(['npx', '-y', PLAYWRIGHT_CLI, 'install', '--skills'], { cwd: PROJECT, stdout: 'ignore', stderr: 'pipe' });
  if (skill.exitCode !== 0) throw new Error(`playwright-cli install --skills failed: ${skill.stderr.toString()}`);
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'e2e fixture');
  // Archon creates worktrees only for a repository with a remote; a local bare one keeps it offline.
  Bun.spawnSync(['git', 'init', '-q', '--bare', '-b', 'main', join(E2E, 'origin.git')]);
  git('remote', 'add', 'origin', join(E2E, 'origin.git'));
  git('push', '-q', '-u', 'origin', 'main');
  return readdirSync(join(SAMPLES, 'workflows'))
    .filter(name => name.endsWith('.yaml'))
    .map(name => name.replace(/\.yaml$/, ''));
}

/** `archon workflow runs --json` → the newest run of `workflow`. */
async function latestRun(workflow: string): Promise<Record<string, unknown> | undefined> {
  const { out } = await archon(`runs-${workflow}`, ['workflow', 'runs', '--json', '--limit', '20'], 60_000);
  const start = Math.min(...['[', '{'].map(char => out.indexOf(char)).filter(index => index >= 0));
  if (!Number.isFinite(start)) return undefined;
  const end = out.lastIndexOf(out[start] === '[' ? ']' : '}');
  try {
    const parsed = JSON.parse(out.slice(start, end + 1));
    const runs: Record<string, unknown>[] = Array.isArray(parsed) ? parsed : (parsed.runs ?? []);
    return runs.find(run => run.workflowName === workflow || run.workflow === workflow || JSON.stringify(run).includes(`"${workflow}"`));
  } catch {
    return undefined;
  }
}

const lines = (text: string): string[] => text.split('\n').map(line => line.trim()).filter(Boolean);
const firstLines = (text: string, count: number): string => lines(text).slice(0, count).join(' | ');
const tail = (text: string, count: number): string => lines(text).slice(-count).join(' | ');
const grepLine = (text: string, needle: string): string => lines(text).find(line => line.includes(needle))?.slice(0, 240) ?? '';
const ephemeralAgents = (): string[] => {
  const dir = join(process.env.HOME ?? '', '.kiro', 'agents');
  return existsSync(dir) ? readdirSync(dir).filter(name => name.startsWith('archon-run-')) : [];
};

async function main(): Promise<void> {
  const workflows = await setup();

  // Build and install.
  const build = Bun.spawnSync([process.execPath, 'scripts/build.ts'], { cwd: ROOT, stdout: 'ignore', stderr: 'pipe' });
  record('build plugin executable', build.exitCode === 0, build.exitCode === 0 ? '' : build.stderr.toString().slice(0, 300));
  const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: ROOT }).stdout.toString().trim();
  const installed = await installLocalPlugin({
    archonHome: HOME,
    binary: join(ROOT, 'dist', 'archon-provider-kiro'),
    commit: /^[0-9a-f]{40}$/.test(head) ? head : '0'.repeat(40),
    tag: `v${packageJson.version}`,
  });
  record('install: handshake descriptor', installed.descriptor.id === 'kiro', `protocol ${installed.descriptor.protocol}, version ${installed.descriptor.version}`);

  const version = await archon('version', ['--version'], 60_000);
  record('archon CLI runs', version.code === 0, lines(version.out)[0] ?? '');

  // The host reads and validates the receipt.
  const list = await archon('plugin-list', ['plugin', 'list'], 60_000);
  record('archon plugin list shows the Kiro provider', list.code === 0 && list.out.includes(RECEIPT_ID) && !/broken|invalid|unavailable/i.test(list.out), firstLines(list.out, 4));

  // Doctor runs the provider's own diagnostics through the plugin.
  const doctor = await archon('doctor', ['doctor'], 180_000);
  // Only the provider's own rows: other doctor checks (and paths containing "kiro") are not ours.
  const kiroLines = lines(doctor.out).filter(line => /\bkiro: |providers: kiro\b|support: kiro\b/.test(line));
  record('archon doctor reports the Kiro provider healthy', kiroLines.length >= 5 && kiroLines.every(line => line.startsWith('✓')), kiroLines.slice(0, 6).join(' | '));

  // Every sample validates against the provider's capabilities.
  for (const workflow of workflows) {
    const validate = await archon(`validate-${workflow}`, ['validate', 'workflows', workflow], 120_000);
    const warnings = lines(validate.out).filter(line => /warn|error/i.test(line) && !line.startsWith('{'));
    record(`validate ${workflow}`, validate.code === 0 && !/with errors|ERROR/.test(validate.out.replace(/0 with errors/, '')), warnings.slice(0, 3).join(' | '));
  }

  // kiro-hello: the smallest round trip.
  const hello = await archon('run-kiro-hello', ['workflow', 'run', 'kiro-hello', '--no-worktree'], 600_000);
  record('run kiro-hello', hello.code === 0 && hello.out.includes('KIRO-ARCHON-OK'), grepLine(hello.out, 'Kiro replied') || tail(hello.out, 4));

  // kiro-feature-tour: every declared capability, in a worktree as Archon normally runs.
  const before = ephemeralAgents();
  const tour = await archon('run-kiro-feature-tour', ['workflow', 'run', 'kiro-feature-tour'], 1_500_000);
  // The CLI prints only node status lines; each check node's stdout is in the run transcript.
  const transcriptPath = /Transcript: (\S+\.jsonl)/.exec(tour.out)?.[1];
  const transcript = transcriptPath && existsSync(transcriptPath) ? readFileSync(transcriptPath, 'utf8') : '';
  record('feature tour transcript found', transcript.length > 0, transcriptPath ?? 'no transcript path in output');
  for (const marker of ['HELLO', 'RECALL', 'STRUCTURED', 'TOOLS', 'RESTRICT', 'SYSPROMPT', 'MCP', 'SKILL', 'SKILL-EXACT']) {
    const failure = /([A-Z]+-FAIL[^"\\]*)/.exec(transcript.slice(transcript.indexOf(`${marker}-FAIL`)))?.[1];
    record(`feature tour: ${marker.toLowerCase()}`, transcript.includes(`${marker}-PASS`), transcript.includes(`${marker}-FAIL`) ? (failure ?? '') : '');
  }
  record('feature tour completed', tour.code === 0 && /completed successfully/i.test(tour.out), tour.code === 0 ? '' : tail(tour.out, 6));
  const tourRun = await latestRun('kiro-feature-tour');
  record('feature tour run record', String(tourRun?.status ?? '') === 'completed', `status ${String(tourRun?.status)}`);
  record('ephemeral Kiro agents cleaned up', ephemeralAgents().length === before.length, ephemeralAgents().join(', '));
  const status = git('status', '--porcelain');
  record('nothing written into the project checkout', status === '', status.replace(/\n/g, ', '));

  // Playwright through the MCP server and through the CLI with its skill.
  for (const [workflow, marker] of [['kiro-playwright-mcp', 'PLAYWRIGHT-MCP'], ['kiro-playwright-cli', 'PLAYWRIGHT-CLI']] as const) {
    const run = await archon(`run-${workflow}`, ['workflow', 'run', workflow, '--no-worktree'], 900_000);
    const path = /Transcript: (\S+\.jsonl)/.exec(run.out)?.[1];
    const text = path && existsSync(path) ? readFileSync(path, 'utf8') : '';
    const pass = /PLAYWRIGHT-(?:MCP|CLI)-PASS: [^"\\]*/.exec(text)?.[0];
    record(`${workflow}: real browser, title checked`, run.code === 0 && text.includes(`${marker}-PASS`), pass ?? (grepLine(text, `${marker}-FAIL`) || tail(run.out, 4)));
  }
  const pwStatus = git('status', '--porcelain');
  record('Playwright runs leave the checkout clean', pwStatus === '', pwStatus.replace(/\n/g, ', '));

  // A Kiro configuration error fails the node as misconfigured, without retries.
  const bad = await archon('run-kiro-bad-model', ['workflow', 'run', 'kiro-bad-model', '--no-worktree'], 600_000);
  const failedLine = grepLine(bad.out, '[doomed] Failed');
  record('bad model: run fails', bad.code !== 0 && failedLine.length > 0, failedLine.slice(0, 160));
  record('bad model: engine treats it as misconfigured', failedLine.includes('retrying will not help'), '');
  record('bad model: Kiro evidence reaches the operator', failedLine.includes('InvalidModelError:'), '');
  const attempts = (bad.out.match(/\[doomed\] Started/g) ?? []).length;
  record('bad model: not retried (misconfigured)', attempts <= 1, `${attempts} attempt(s)`);

  // Cancellation: start detached, wait for Kiro's shell command, cancel, verify nothing survives.
  const detached = await archon('run-kiro-cancel-demo', ['workflow', 'run', 'kiro-cancel-demo', '--no-worktree', '--detach'], 120_000);
  let sawSleep = false;
  for (let i = 0; i < 90 && !sawSleep; i++) {
    await Bun.sleep(2000);
    sawSleep = Bun.spawnSync(['pgrep', '-f', CANCEL_MARKER]).stdout.toString().trim().length > 0;
  }
  record('cancel: Kiro started the long command', sawSleep, detached.code === 0 ? '' : tail(detached.out, 3));
  const cancelRun = await latestRun('kiro-cancel-demo');
  const runId = String(cancelRun?.id ?? cancelRun?.runId ?? '');
  const cancel = await archon('cancel', ['workflow', 'cancel', runId], 120_000);
  record('cancel: archon workflow cancel accepted', cancel.code === 0 && runId.length > 0, firstLines(cancel.out, 2));
  let gone = false;
  for (let i = 0; i < 30 && !gone; i++) {
    await Bun.sleep(1000);
    gone = Bun.spawnSync(['pgrep', '-f', CANCEL_MARKER]).stdout.toString().trim().length === 0;
  }
  // Only meaningful when the command was seen running before the cancel.
  record('cancel: the long command died with Kiro', sawSleep && gone, gone ? '' : Bun.spawnSync(['pgrep', '-fl', CANCEL_MARKER]).stdout.toString());
  await Bun.sleep(2000);
  const afterCancel = await latestRun('kiro-cancel-demo');
  record('cancel: run recorded as cancelled', String(afterCancel?.status ?? '') === 'cancelled', `status ${String(afterCancel?.status)}`);

  const failed = results.filter(result => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Logs: ${LOGS}`);
  await writeFile(join(E2E, 'summary.json'), `${JSON.stringify(results, null, 2)}\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

await main().catch(error => {
  console.error(error);
  process.exit(1);
});
