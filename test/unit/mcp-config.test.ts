import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadNodeMcp, McpConfigError, nodeMcpPath, parseNodeMcp } from '../../src/mcp-config';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mcp-config-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('parseNodeMcp', () => {
  test('stdio server → Kiro command/args/env; type defaults to stdio', () => {
    expect(parseNodeMcp({ pw: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.85', '--headless'] } }, {})).toEqual({
      servers: { pw: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.85', '--headless'] } },
      names: ['pw'],
      missingVars: [],
    });
    expect(parseNodeMcp({ s: { type: 'stdio', command: 'x' } }, {}).servers).toEqual({ s: { command: 'x' } });
  });

  test('http and sse servers → Kiro url/headers', () => {
    const loaded = parseNodeMcp(
      { api: { type: 'http', url: 'https://mcp.example.com/v1', headers: { Authorization: 'Bearer $TOKEN' } }, live: { type: 'sse', url: 'https://x/sse' } },
      { TOKEN: 't0k' }
    );
    expect(loaded.servers).toEqual({
      api: { url: 'https://mcp.example.com/v1', headers: { Authorization: 'Bearer t0k' } },
      live: { url: 'https://x/sse' },
    });
  });

  test('accepts the { "mcpServers": {...} } wrapper', () => {
    expect(parseNodeMcp({ mcpServers: { a: { command: 'a' } } }, {}).names).toEqual(['a']);
  });

  test('expands $VAR and ${VAR} in env and headers only; reports undefined vars once', () => {
    const loaded = parseNodeMcp(
      {
        db: { command: '$NOT_EXPANDED', args: ['$ALSO_NOT'], env: { URL: '${DB_URL}', POOL: '$POOL', KEY: '$MISSING', AGAIN: '$MISSING' } },
      },
      { DB_URL: 'postgres://x', POOL: '5' }
    );
    expect(loaded.servers.db).toEqual({ command: '$NOT_EXPANDED', args: ['$ALSO_NOT'], env: { URL: 'postgres://x', POOL: '5', KEY: '', AGAIN: '' } });
    expect(loaded.missingVars).toEqual(['MISSING']);
  });

  test('lower-case $vars are left alone, as in Archon', () => {
    expect(parseNodeMcp({ s: { command: 'x', env: { A: '$lower' } } }, { lower: 'nope' }).servers.s?.env).toEqual({ A: '$lower' });
  });

  test('malformed configs fail as McpConfigError', () => {
    const bad: unknown[] = [
      [],
      'text',
      { mcpServers: {}, other: {} },
      { mcpServers: [] },
      { s: 'not an object' },
      { s: {} },
      { s: { command: 'x', args: 'not-an-array' } },
      { s: { command: 'x', env: { A: 1 } } },
      { s: { command: 'x', env: [] } },
      { s: { type: 'http' } },
      { s: { type: 'websocket', url: 'ws://x' } },
    ];
    for (const config of bad) expect(() => parseNodeMcp(config, {})).toThrow(McpConfigError);
  });
});

describe('loadNodeMcp', () => {
  test('reads an absolute path, or a path relative to cwd', async () => {
    await writeFile(join(dir, 'pw.json'), JSON.stringify({ pw: { command: 'npx' } }));
    expect((await loadNodeMcp(join(dir, 'pw.json'), '/elsewhere', {})).names).toEqual(['pw']);
    expect((await loadNodeMcp('pw.json', dir, {})).names).toEqual(['pw']);
  });

  test('missing file and invalid JSON are misconfigurations with the path', async () => {
    await expect(loadNodeMcp('nope.json', dir, {})).rejects.toThrow(/not found: nope\.json/);
    await writeFile(join(dir, 'bad.json'), '{nope');
    await expect(loadNodeMcp('bad.json', dir, {})).rejects.toThrow(/not valid JSON/);
  });
});

describe('nodeMcpPath', () => {
  test('string or { path }, trimmed; anything else is no declaration', () => {
    expect(nodeMcpPath(' /a/b.json ')).toBe('/a/b.json');
    expect(nodeMcpPath({ path: '/a/b.json', optional: true })).toBe('/a/b.json');
    for (const value of [undefined, '', '  ', 42, {}, { path: '' }]) expect(nodeMcpPath(value)).toBeUndefined();
  });
});
