import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Kiro has no flag for a system prompt or a tool allow/deny list, and `--agent` takes only
 * a name. Its custom agents carry all three (`prompt`, `tools`, `excludedTools`), and V3
 * enforces `tools` by removing everything else from the session. So a node that needs
 * them runs on an ephemeral agent written to Kiro's global agent directory under a unique
 * `archon-run-*` name, and deleted when the turn ends. A crash can leave one behind; each
 * new turn sweeps leftovers older than {@link STALE_AGENT_MS}.
 *
 * The workspace `.kiro/agents` is never written: Archon runs in git worktrees, and a file
 * there would show up in the run's diff.
 */

export const EPHEMERAL_PREFIX = 'archon-run-';
export const STALE_AGENT_MS = 6 * 60 * 60 * 1000;
/** Kiro's built-in agents. Only the default one can be replaced by an ephemeral agent. */
const BUILT_IN_AGENTS = new Set(['kiro_default', 'kiro_help', 'kiro_planner']);

export class AgentConfigError extends Error {
  override name = 'AgentConfigError';
}

export interface EphemeralAgentSpec {
  /** Agent configured in `assistants.kiro.agent`; its JSON becomes the base. */
  baseAgent?: string;
  /** Node `allowed_tools`: the only tools the session gets. */
  allowedTools?: readonly string[];
  /** Node `denied_tools`: removed even when `allowedTools` (or the base) includes them. */
  deniedTools?: readonly string[];
  /** Replaces the base agent's prompt. */
  systemPrompt?: string;
  /** Added after the base agent's prompt. */
  appendSystemPrompt?: string;
}

export interface EphemeralAgent {
  name: string;
  path: string;
  dispose(): Promise<void>;
}

export function needsEphemeralAgent(spec: EphemeralAgentSpec): boolean {
  return (
    spec.allowedTools !== undefined ||
    (spec.deniedTools !== undefined && spec.deniedTools.length > 0) ||
    Boolean(spec.systemPrompt) ||
    Boolean(spec.appendSystemPrompt)
  );
}

/** `$KIRO_HOME/agents` when KIRO_HOME is set, else `~/.kiro/agents`. */
export function globalAgentDir(env: Record<string, string | undefined>): string {
  const home = env.KIRO_HOME && env.KIRO_HOME.length > 0 ? env.KIRO_HOME : join(env.HOME ?? homedir(), '.kiro');
  return join(home, 'agents');
}

export async function createEphemeralAgent(
  spec: EphemeralAgentSpec,
  context: { cwd: string; env: Record<string, string | undefined> }
): Promise<EphemeralAgent> {
  const dir = globalAgentDir(context.env);
  await mkdir(dir, { recursive: true });
  await sweepStaleAgents(dir);

  const name = `${EPHEMERAL_PREFIX}${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const config = await buildAgentConfig(name, spec, context.cwd, dir);
  const path = join(dir, `${name}.json`);
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return {
    name,
    path,
    dispose: async () => {
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    },
  };
}

export async function buildAgentConfig(
  name: string,
  spec: EphemeralAgentSpec,
  cwd: string,
  globalDir: string
): Promise<Record<string, unknown>> {
  const base = spec.baseAgent && spec.baseAgent !== 'kiro_default'
    ? await loadBaseAgent(spec.baseAgent, cwd, globalDir)
    : undefined;

  const config: Record<string, unknown> = base
    ? { ...base.config }
    : {
        // Mirror Kiro's default agent: every tool, the user's MCP servers and powers.
        // Project guidance (AGENTS.md, .kiro/steering) loads for custom agents as well.
        tools: ['*'],
        includeMcpJson: true,
        includePowers: true,
      };
  config.name = name;
  config.description = `Ephemeral agent for one Archon workflow turn${spec.baseAgent ? ` (based on ${spec.baseAgent})` : ''}; deleted when the turn ends.`;

  if (spec.allowedTools !== undefined) config.tools = [...spec.allowedTools];
  if (spec.deniedTools && spec.deniedTools.length > 0) {
    const existing = Array.isArray(config.excludedTools) ? (config.excludedTools as unknown[]).filter(isString) : [];
    config.excludedTools = [...new Set([...existing, ...spec.deniedTools])];
  }

  const basePrompt = base ? await resolvePrompt(base.config.prompt, base.dir) : undefined;
  const prompt = spec.systemPrompt
    ? joinPrompts(spec.systemPrompt, spec.appendSystemPrompt)
    : joinPrompts(basePrompt, spec.appendSystemPrompt);
  if (prompt) config.prompt = prompt;
  else delete config.prompt;
  return config;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function joinPrompts(...parts: (string | undefined)[]): string | undefined {
  const present = parts.filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
  return present.length > 0 ? present.join('\n\n') : undefined;
}

async function loadBaseAgent(
  agent: string,
  cwd: string,
  globalDir: string
): Promise<{ config: Record<string, unknown>; dir: string }> {
  if (BUILT_IN_AGENTS.has(agent)) {
    throw new AgentConfigError(
      `Kiro built-in agent '${agent}' cannot be combined with allowed_tools, denied_tools or a system prompt; use a JSON agent in .kiro/agents or ~/.kiro/agents`
    );
  }
  if (!/^[\w.-]+$/.test(agent)) throw new AgentConfigError(`Kiro agent name '${agent}' is not a plain agent name`);
  for (const dir of [join(cwd, '.kiro', 'agents'), globalDir]) {
    const file = join(dir, `${agent}.json`);
    let raw: string;
    try {
      raw = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new AgentConfigError(`Kiro agent '${agent}' could not be read (${(error as NodeJS.ErrnoException).code ?? 'error'})`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AgentConfigError(`Kiro agent '${agent}' (${file}) is not valid JSON`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new AgentConfigError(`Kiro agent '${agent}' (${file}) is not a JSON object`);
    }
    return { config: parsed as Record<string, unknown>, dir };
  }
  throw new AgentConfigError(
    `Kiro agent '${agent}' has no JSON definition in ${join(cwd, '.kiro', 'agents')} or ${globalDir}; ` +
      'allowed_tools, denied_tools and system prompts need a JSON agent to build on (Markdown agents are not supported)'
  );
}

/** An agent prompt is inline text or a `file://` URI relative to the agent's directory. */
async function resolvePrompt(prompt: unknown, agentDir: string): Promise<string | undefined> {
  if (typeof prompt !== 'string' || prompt.length === 0) return undefined;
  if (!prompt.startsWith('file://')) return prompt;
  const target = prompt.slice('file://'.length);
  const path = isAbsolute(target) ? target : resolve(agentDir, target);
  try {
    return await readFile(path, 'utf8');
  } catch {
    throw new AgentConfigError(`Kiro agent prompt file ${path} could not be read`);
  }
}

/** Remove `archon-run-*.json` files a crashed turn left behind. Never touches other agents. */
export async function sweepStaleAgents(dir: string, now = Date.now()): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(EPHEMERAL_PREFIX) || !entry.endsWith('.json')) continue;
    const path = join(dir, entry);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs > STALE_AGENT_MS) {
        await unlink(path);
        removed.push(entry);
      }
    } catch {
      // Raced with another turn's cleanup.
    }
  }
  return removed;
}
