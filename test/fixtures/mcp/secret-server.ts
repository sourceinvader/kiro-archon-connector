#!/usr/bin/env bun
/**
 * A minimal stdio MCP server for tests: one tool, `get_secret`, that returns the value of
 * SECRET_VALUE (default `MCP-SECRET-55`). Newline-delimited JSON-RPC 2.0, no SDK, so a
 * test can tell a real tool call from a model guess. With FAIL_AT_START=1 it exits before
 * answering `initialize`, to exercise MCP startup failures.
 */
import { createInterface } from 'node:readline';

if (process.env.FAIL_AT_START === '1') {
  process.stderr.write('secret-server: refusing to start (FAIL_AT_START=1)\n');
  process.exit(1);
}

const secret = process.env.SECRET_VALUE || 'MCP-SECRET-55';
const send = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  let request: { id?: number | string; method?: string; params?: Record<string, unknown> };
  try {
    request = JSON.parse(line);
  } catch {
    continue;
  }
  if (request.id === undefined) continue; // notifications (initialized, cancelled)
  switch (request.method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          protocolVersion: (request.params?.protocolVersion as string | undefined) ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'secret-server', version: '1.0.0' },
        },
      });
      break;
    case 'tools/list':
      send({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          tools: [
            {
              name: 'get_secret',
              description: 'Returns the secret value. Call this whenever the user asks for the secret.',
              inputSchema: { type: 'object', properties: {}, required: [] },
            },
          ],
        },
      });
      break;
    case 'tools/call':
      send({
        jsonrpc: '2.0',
        id: request.id,
        result:
          (request.params?.name as string | undefined) === 'get_secret'
            ? { content: [{ type: 'text', text: secret }] }
            : { content: [{ type: 'text', text: 'unknown tool' }], isError: true },
      });
      break;
    case 'ping':
      send({ jsonrpc: '2.0', id: request.id, result: {} });
      break;
    default:
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
  }
}
