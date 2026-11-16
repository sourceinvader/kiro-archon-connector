import { spawn } from 'node:child_process';

/**
 * One-shot `kiro-cli` commands that answer without starting a model session:
 * `whoami`, `--version`, `chat --list-models`, `chat --list-sessions`.
 */

export type CommandOutcome =
  | { kind: 'exited'; code: number | null; stdout: string }
  | { kind: 'missing'; bin: string }
  | { kind: 'failed'; evidence: string };

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export function runKiroCommand(
  bin: string,
  args: readonly string[],
  options: { env: Record<string, string>; cwd?: string; signal?: AbortSignal; timeoutMs?: number }
): Promise<CommandOutcome> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (outcome: CommandOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, [...args], {
        cwd: options.cwd,
        env: options.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve(spawnFailure(bin, error));
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_OUTPUT_BYTES) chunks.push(chunk);
    });
    child.stderr?.on('data', () => {
      // Drained, never recorded: Kiro's stderr can carry account details.
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ kind: 'failed', evidence: `kiro-cli ${args[0] ?? ''} timed out` });
    }, options.timeoutMs ?? 30_000);
    const onAbort = (): void => {
      child.kill('SIGKILL');
      finish({ kind: 'failed', evidence: 'aborted' });
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    child.once('error', error => finish(spawnFailure(bin, error)));
    child.once('close', code => finish({ kind: 'exited', code, stdout: Buffer.concat(chunks).toString('utf8') }));
  });
}

function spawnFailure(bin: string, error: unknown): CommandOutcome {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'EACCES') return { kind: 'missing', bin };
  return { kind: 'failed', evidence: `could not start ${bin}: ${code ?? String(error)}` };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return undefined;
  }
}

export type LoginState =
  | { state: 'signed_in'; accountType?: string }
  | { state: 'signed_out' }
  | { state: 'missing'; bin: string }
  | { state: 'unknown'; evidence: string };

/** `kiro-cli whoami --format json`: `{"account":null}` when signed out. Never prints the email. */
export async function readLoginState(
  bin: string,
  env: Record<string, string>,
  signal?: AbortSignal
): Promise<LoginState> {
  const outcome = await runKiroCommand(bin, ['whoami', '--format', 'json'], { env, signal });
  if (outcome.kind === 'missing') return { state: 'missing', bin: outcome.bin };
  if (outcome.kind === 'failed') return { state: 'unknown', evidence: outcome.evidence };
  const parsed = parseJson(outcome.stdout);
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    if ('account' in record && record.account === null) return { state: 'signed_out' };
    if (typeof record.accountType === 'string') return { state: 'signed_in', accountType: record.accountType };
    if (record.account !== null && typeof record.account === 'object') return { state: 'signed_in' };
  }
  return {
    state: 'unknown',
    evidence: `kiro-cli whoami exited ${String(outcome.code)} without a recognisable account record`,
  };
}

export interface KiroModel {
  id: string;
  name?: string;
  description?: string;
  rateMultiplier?: number;
  rateUnit?: string;
  contextWindowTokens?: number;
}

export type ModelListOutcome =
  | { kind: 'ok'; models: KiroModel[]; defaultModel?: string }
  | { kind: 'missing'; bin: string }
  | { kind: 'failed'; evidence: string };

/** `kiro-cli chat --list-models --format json`. */
export async function listKiroModels(
  bin: string,
  env: Record<string, string>,
  signal?: AbortSignal
): Promise<ModelListOutcome> {
  const outcome = await runKiroCommand(bin, ['chat', '--list-models', '--format', 'json'], { env, signal });
  if (outcome.kind !== 'exited') return outcome;
  const parsed = parseJson(outcome.stdout) as { models?: unknown; default_model?: unknown } | undefined;
  if (!parsed || !Array.isArray(parsed.models)) {
    return { kind: 'failed', evidence: `kiro-cli --list-models exited ${String(outcome.code)} without a model list` };
  }
  const models: KiroModel[] = [];
  for (const entry of parsed.models) {
    if (entry === null || typeof entry !== 'object') continue;
    const model = entry as Record<string, unknown>;
    if (typeof model.model_id !== 'string') continue;
    models.push({
      id: model.model_id,
      ...(typeof model.model_name === 'string' ? { name: model.model_name } : {}),
      ...(typeof model.description === 'string' ? { description: model.description } : {}),
      ...(typeof model.rate_multiplier === 'number' ? { rateMultiplier: model.rate_multiplier } : {}),
      ...(typeof model.rate_unit === 'string' ? { rateUnit: model.rate_unit } : {}),
      ...(typeof model.context_window_tokens === 'number' ? { contextWindowTokens: model.context_window_tokens } : {}),
    });
  }
  return {
    kind: 'ok',
    models,
    ...(typeof parsed.default_model === 'string' ? { defaultModel: parsed.default_model } : {}),
  };
}

/**
 * Whether Kiro still has `sessionId` for `cwd`, from `kiro-cli chat --list-sessions
 * --format json`. `undefined` when the list could not be read or Kiro marks it incomplete:
 * only a complete list that lacks the id proves the session is gone.
 */
export async function kiroSessionExists(
  bin: string,
  cwd: string,
  sessionId: string,
  env: Record<string, string>,
  signal?: AbortSignal
): Promise<boolean | undefined> {
  const outcome = await runKiroCommand(bin, ['chat', '--list-sessions', '--format', 'json'], { env, cwd, signal });
  if (outcome.kind !== 'exited' || outcome.code !== 0) return undefined;
  const parsed = parseJson(outcome.stdout);
  if (!Array.isArray(parsed)) return undefined;
  let complete = true;
  for (const group of parsed) {
    if (group === null || typeof group !== 'object') return undefined;
    const { sessions, complete: groupComplete } = group as { sessions?: unknown; complete?: unknown };
    if (groupComplete !== true) complete = false;
    if (!Array.isArray(sessions)) continue;
    for (const session of sessions) {
      if (session !== null && typeof session === 'object' && (session as { sessionId?: unknown }).sessionId === sessionId) {
        return true;
      }
    }
  }
  return complete ? false : undefined;
}

/** `kiro-cli --version` → `2.37.1`. */
export async function readKiroVersion(
  bin: string,
  env: Record<string, string>,
  signal?: AbortSignal
): Promise<{ kind: 'ok'; version: string } | { kind: 'missing'; bin: string } | { kind: 'failed'; evidence: string }> {
  const outcome = await runKiroCommand(bin, ['--version'], { env, signal, timeoutMs: 15_000 });
  if (outcome.kind !== 'exited') return outcome;
  const version = /(\d+\.\d+\.\d+[\w.-]*)/.exec(outcome.stdout)?.[1];
  return version
    ? { kind: 'ok', version }
    : { kind: 'failed', evidence: `kiro-cli --version exited ${String(outcome.code)} without a version` };
}
