import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { mcpServerMap } from '@archon/provider-contract';

/**
 * A node's `mcp:` file, loaded the way Archon's maintained providers load it
 * (packages/providers/src/mcp/config.ts, v0.14.0): a server map, or `{ "mcpServers": {...} }`;
 * `$VAR` / `${VAR}` references expanded in `env` and `headers` values only, undefined ones
 * becoming empty strings and reported back. The engine has already resolved the path
 * (checkout first, then a home workflow's directory); a relative path resolves against cwd.
 *
 * Each server is translated to Kiro's agent `mcpServers` entry: `command`/`args`/`env` for
 * stdio, `url`/`headers` for a remote server.
 */

export class McpConfigError extends Error {
  override name = 'McpConfigError';
}

export interface KiroMcpServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface LoadedNodeMcp {
  servers: Record<string, KiroMcpServer>;
  names: string[];
  missingVars: string[];
}

const VAR_PATTERN = /\$(?:\{([A-Z_][A-Z0-9_]*)\}|([A-Z_][A-Z0-9_]*))/g;

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function expandRecord(
  value: unknown,
  field: string,
  env: Record<string, string | undefined>,
  missing: string[]
): Record<string, string> {
  if (!isRecord(value)) {
    throw new McpConfigError(`MCP config ${field} must be a JSON object of string values (got ${describe(value)})`);
  }
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') throw new McpConfigError(`MCP config ${field}.${key} must be a string (got ${describe(raw)})`);
    result[key] = raw.replace(VAR_PATTERN, (_match, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare ?? '';
      const found = env[name];
      if (found === undefined) missing.push(name);
      return found ?? '';
    });
  }
  return result;
}

function translateServer(
  name: string,
  config: unknown,
  env: Record<string, string | undefined>,
  missing: string[]
): KiroMcpServer {
  if (!isRecord(config)) throw new McpConfigError(`MCP server "${name}" must be a JSON object (got ${describe(config)})`);
  const type = config.type ?? 'stdio';
  if (type === 'stdio') {
    if (typeof config.command !== 'string' || config.command.length === 0) {
      throw new McpConfigError(`MCP server "${name}" needs a "command" string`);
    }
    const server: KiroMcpServer = { command: config.command };
    if (config.args !== undefined) {
      if (!Array.isArray(config.args) || !config.args.every(arg => typeof arg === 'string')) {
        throw new McpConfigError(`MCP server "${name}" args must be an array of strings`);
      }
      server.args = [...config.args];
    }
    if (config.env !== undefined) server.env = expandRecord(config.env, `${name}.env`, env, missing);
    return server;
  }
  if (type === 'http' || type === 'sse') {
    if (typeof config.url !== 'string' || config.url.length === 0) {
      throw new McpConfigError(`MCP server "${name}" (${type}) needs a "url" string`);
    }
    const server: KiroMcpServer = { url: config.url };
    if (config.headers !== undefined) server.headers = expandRecord(config.headers, `${name}.headers`, env, missing);
    return server;
  }
  throw new McpConfigError(`MCP server "${name}" has unsupported type ${JSON.stringify(type)}; use stdio, http or sse`);
}

export function parseNodeMcp(parsed: unknown, env: Record<string, string | undefined>): LoadedNodeMcp {
  const map = mcpServerMap(parsed);
  if (!map.ok) throw new McpConfigError(map.error);
  const missing: string[] = [];
  const servers: Record<string, KiroMcpServer> = {};
  for (const [name, config] of Object.entries(map.servers)) {
    servers[name] = translateServer(name, config, env, missing);
  }
  return { servers, names: Object.keys(servers), missingVars: [...new Set(missing)] };
}

/** The node's declared path: the engine passes a string; tolerate `{ path }` defensively. */
export function nodeMcpPath(declared: unknown): string | undefined {
  if (typeof declared === 'string' && declared.trim().length > 0) return declared.trim();
  if (isRecord(declared) && typeof declared.path === 'string' && declared.path.trim().length > 0) return declared.path.trim();
  return undefined;
}

export async function loadNodeMcp(
  mcpPath: string,
  cwd: string,
  env: Record<string, string | undefined>
): Promise<LoadedNodeMcp> {
  const fullPath = isAbsolute(mcpPath) ? mcpPath : resolve(cwd, mcpPath);
  let raw: string;
  try {
    raw = await readFile(fullPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new McpConfigError(
      code === 'ENOENT'
        ? `MCP config file not found: ${mcpPath} (resolved to ${fullPath})`
        : `MCP config file ${fullPath} could not be read (${code ?? 'error'})`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new McpConfigError(`MCP config file ${fullPath} is not valid JSON: ${(error as Error).message}`);
  }
  return parseNodeMcp(parsed, env);
}
