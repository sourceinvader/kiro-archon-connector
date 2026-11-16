import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { KiroMcpServer } from './mcp-config';
import type { ResolvedSkill } from './skills';

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
  /** Set for a workflow node: exactly its MCP servers and skills, nothing ambient. */
  workflow?: WorkflowIsolation;
}

/**
 * What a workflow node may load. Archon requires exact selection: the node gets the MCP
 * servers of its `mcp:` file and the skills of its `skills:` list, and none of the user's
 * own. Kiro would otherwise add the user's `mcp.json` servers and powers, and its
 * `disclose_context` tool would load any `.kiro/skills` skill named in the conversation,
 * whatever the agent's resources say. Denying the `skill` capability closes that loader;
 * declared skills are delivered as `file://` resources instead, which Kiro loads up front.
 */
export interface WorkflowIsolation {
  mcpServers: Record<string, KiroMcpServer>;
  skills: readonly ResolvedSkill[];
}

/** Kiro's capability for its skill loader (`disclose_context`). */
export const SKILL_LOADER_DENY_RULE = { capability: 'skill', effect: 'deny' } as const;

export interface EphemeralAgent {
  name: string;
  path: string;
  dispose(): Promise<void>;
}

export function needsEphemeralAgent(spec: EphemeralAgentSpec): boolean {
  return (
    spec.workflow !== undefined ||
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

  if (spec.workflow) isolateWorkflowNode(config, spec.workflow);

  const basePrompt = base ? await resolvePrompt(base.config.prompt, base.dir) : undefined;
  const prompt = joinPrompts(
    spec.systemPrompt ?? basePrompt,
    spec.appendSystemPrompt,
    spec.workflow ? skillsNote(spec.workflow.skills) : undefined
  );
  if (prompt) config.prompt = prompt;
  else delete config.prompt;
  return config;
}

/**
 * A workflow node's tool list. Kiro starts the workspace and global `mcp.json` servers
 * whatever the agent says, and `includeMcpJson: false` only stops their tools being added on
 * top of `tools`, so `*` would still match them. `*` therefore becomes `@builtin`, a
 * reference to an undeclared server is dropped, and each declared server is added, as
 * Claude adds `mcp__<server>__*`. `allowed_tools: []` plus `mcp:` makes an MCP-only node.
 */
export function workflowTools(tools: readonly string[], declaredServers: readonly string[]): string[] {
  const declared = new Set(declaredServers);
  const kept = tools.flatMap(tool => {
    if (tool === '*') return ['@builtin'];
    if (tool === '@builtin' || !tool.startsWith('@')) return [tool];
    return declared.has(tool.slice(1).split('/')[0] ?? '') ? [tool] : [];
  });
  return [...new Set([...kept, ...declaredServers.map(server => `@${server}`)])];
}

function isolateWorkflowNode(config: Record<string, unknown>, workflow: WorkflowIsolation): void {
  const serverNames = Object.keys(workflow.mcpServers);
  config.includeMcpJson = false;
  config.includePowers = false;
  config.mcpServers = { ...workflow.mcpServers };
  // Kiro accepts `tools: "*"` as well as a list; either way unset means every tool.
  const tools = Array.isArray(config.tools) ? (config.tools as unknown[]).filter(isString) : ['*'];
  config.tools = workflowTools(tools, serverNames);
  // A base agent's own skills are dropped with the rest of its ambient skill access.
  const resources = [
    ...(Array.isArray(config.resources)
      ? (config.resources as unknown[]).filter(resource => !(isString(resource) && resource.startsWith('skill://')))
      : []),
    ...workflow.skills.map(skill => `file://${skill.file}`),
  ];
  if (resources.length > 0) config.resources = resources;
  else delete config.resources;
  const permissions = isRecord(config.permissions) ? config.permissions : {};
  const rules = Array.isArray(permissions.rules) ? permissions.rules : [];
  config.permissions = { ...permissions, rules: [...rules, { ...SKILL_LOADER_DENY_RULE }] };
}

/** Tells the model which skills it has and where their relative paths resolve. */
function skillsNote(skills: readonly ResolvedSkill[]): string | undefined {
  if (skills.length === 0) return undefined;
  return [
    'Skills selected for this task. Each skill\'s SKILL.md is loaded in your context; follow it when it applies.',
    'Resolve relative paths in a SKILL.md (references, scripts, assets) against that skill\'s directory:',
    ...skills.map(skill => `- ${skill.name}: ${skill.dir}`),
  ].join('\n');
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
      `Kiro built-in agent '${agent}' cannot run workflow nodes or take allowed_tools, denied_tools or a system prompt; use a JSON agent in .kiro/agents or ~/.kiro/agents`
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
      'workflow nodes, allowed_tools, denied_tools and system prompts need a JSON agent to build on (Markdown agents are not supported)'
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
