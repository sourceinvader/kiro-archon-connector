import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakeKiro {
  /** Executable shim to pass as `kiroPath` / KIRO_CLI_PATH. */
  bin: string;
  /** Throwaway HOME, so ephemeral agents land in `<home>/.kiro/agents`. */
  home: string;
  /** A git-less workspace directory to run turns in. */
  cwd: string;
  /** Throwaway ARCHON_HOME, where the plugin keeps its Kiro usage log. */
  archonHome: string;
  logFile: string;
  stateDir: string;
  /** Environment for a turn: HOME, ARCHON_HOME, PATH, log/state locations, plus overrides. */
  env(overrides?: Record<string, string>): Record<string, string>;
  invocations(): Promise<{ args: string[]; cwd: string; prompt: string; agentFile?: Record<string, unknown> }[]>;
  cleanup(): Promise<void>;
}

const FAKE_ENTRY = join(import.meta.dir, '..', 'fake-kiro', 'fake-kiro.ts');

export async function createFakeKiro(): Promise<FakeKiro> {
  const root = await mkdtemp(join(tmpdir(), 'fake-kiro-'));
  const binDir = join(root, 'bin');
  const home = join(root, 'home');
  const cwd = join(root, 'work');
  const stateDir = join(root, 'state');
  const archonHome = join(root, 'archon-home');
  await Promise.all([binDir, home, cwd, stateDir].map(dir => mkdir(dir, { recursive: true })));
  const bin = join(binDir, 'kiro-cli');
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(bin, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(FAKE_ENTRY)} "$@"\n`);
  await chmod(bin, 0o755);
  const logFile = join(root, 'invocations.jsonl');
  return {
    bin,
    home,
    cwd,
    archonHome,
    logFile,
    stateDir,
    env(overrides = {}) {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !key.startsWith('KIRO_') && !key.startsWith('FAKE_KIRO_')) env[key] = value;
      }
      return { ...env, HOME: home, ARCHON_HOME: archonHome, FAKE_KIRO_LOG: logFile, FAKE_KIRO_STATE: stateDir, ...overrides };
    },
    async invocations() {
      try {
        return (await readFile(logFile, 'utf8'))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line));
      } catch {
        return [];
      }
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** Drain a provider stream into an array. */
export async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
