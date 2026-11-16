import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * One `kiro-cli chat --output-format stream-json` process per turn.
 *
 * The child runs in its own process group (`detached`), because Kiro starts a Node agent
 * server and tool subprocesses beneath it, and ignores SIGINT when it has no terminal.
 * Cancellation sends SIGTERM to the whole group, which Kiro answers with an `interrupted`
 * run error and a clean exit; SIGKILL follows if the group is still alive after a grace period.
 */

export type KiroProcessItem =
  | { kind: 'line'; value: unknown }
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null }
  | { kind: 'spawn_error'; code: string | undefined; bin: string };

export interface KiroProcessOptions {
  bin: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  /** The instruction, written to stdin so it never appears in argv or `ps`. */
  input: string;
  signal?: AbortSignal;
  killGraceMs?: number;
}

export async function* runKiroProcess(options: KiroProcessOptions): AsyncGenerator<KiroProcessItem> {
  let child: ChildProcess;
  try {
    child = spawn(options.bin, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    yield { kind: 'spawn_error', code: (error as NodeJS.ErrnoException).code, bin: options.bin };
    return;
  }

  let spawnError: NodeJS.ErrnoException | undefined;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('error', error => {
      spawnError = error as NodeJS.ErrnoException;
      resolve({ code: null, signal: null });
    });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let running = true;
  void exited.then(() => {
    running = false;
  });

  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const killGroup = (): void => {
    if (!running || child.pid === undefined) return;
    signalGroup(child.pid, 'SIGTERM');
    killTimer ??= setTimeout(() => {
      if (running && child.pid !== undefined) signalGroup(child.pid, 'SIGKILL');
    }, options.killGraceMs ?? 5_000);
  };
  options.signal?.addEventListener('abort', killGroup, { once: true });
  if (options.signal?.aborted) killGroup();

  child.stdin?.on('error', () => {
    // EPIPE when Kiro exits before reading the prompt; the exit reports the failure.
  });
  child.stdin?.end(options.input);
  child.stderr?.on('data', () => {
    // Drained, never recorded: Kiro's stderr can carry account details and prompt text.
  });

  try {
    if (child.stdout) {
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      for await (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        let value: unknown;
        try {
          value = JSON.parse(trimmed);
        } catch {
          continue; // Not a stream-json event (for example a stray log line).
        }
        yield { kind: 'line', value };
      }
    }
    const exit = await exited;
    if (spawnError) {
      yield { kind: 'spawn_error', code: spawnError.code, bin: options.bin };
      return;
    }
    yield { kind: 'exit', ...exit };
  } finally {
    // The consumer stopped early (or we finished): make sure nothing of this turn survives.
    killGroup();
    options.signal?.removeEventListener('abort', killGroup);
    if (running) await exited;
    if (killTimer) clearTimeout(killTimer);
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}
