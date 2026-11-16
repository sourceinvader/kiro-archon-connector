import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { providerEventSchema, type ProviderEvent } from '@archon/provider-contract';
import { KiroStreamMapper } from '../../src/stream';

const FIXTURES = join(import.meta.dir, '..', 'fixtures');

function replay(name: string, interrupted = false, now?: () => number): { events: ProviderEvent[]; mapper: KiroStreamMapper } {
  const mapper = new KiroStreamMapper(now);
  const events: ProviderEvent[] = [];
  for (const line of readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8').trim().split('\n')) {
    events.push(...mapper.push(JSON.parse(line)));
  }
  events.push(...mapper.finish(interrupted));
  return { events, mapper };
}

const content = (events: ProviderEvent[]): ProviderEvent[] => events.filter(event => event.type !== 'heartbeat');

describe('KiroStreamMapper on recorded Kiro streams', () => {
  test('every event of every fixture is a valid provider event', () => {
    for (const name of ['text', 'tools', 'interrupted', 'bad-model', 'resume-missing', 'structured', 'denied-tool', 'resume-first', 'resume-second', 'throttled', 'mcp', 'mcp-startup-failure', 'skill']) {
      for (const event of replay(name).events) expect(providerEventSchema.safeParse(event).success).toBe(true);
    }
  });

  test('text turn: coalesces deltas into one reply block and reports the session', () => {
    const { events, mapper } = replay('text');
    const messages = events.filter(event => event.type === 'agent_message_chunk');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ text: expect.stringContaining('FIXTURE-TEXT-OK') });
    expect(events.some(event => event.type === 'agent_thought_chunk')).toBe(true);
    expect(mapper.summary.sessionId).toMatch(/^sess_/);
    expect(mapper.summary.finishedStatus).toBe('success');
    expect(mapper.stopReason()).toBe('end_turn');
    expect(mapper.summary.credits).toBeGreaterThan(0);
  });

  test('reply blocks never start or end with blank lines', () => {
    for (const name of ['text', 'tools', 'structured']) {
      for (const event of replay(name).events) {
        if (event.type === 'agent_message_chunk' || event.type === 'agent_thought_chunk') {
          expect(event.text).not.toMatch(/^\s*\n/);
          expect(event.text).not.toMatch(/\n\s*$/);
        }
      }
    }
  });

  test('tool turn: overlapping calls each get one start and one closing update with output', () => {
    const { events } = replay('tools');
    const calls = events.filter(event => event.type === 'tool_call');
    const updates = events.filter(event => event.type === 'tool_call_update');
    expect(calls.map(call => call.type === 'tool_call' && call.name)).toEqual(['read', 'execute']);
    expect(updates).toHaveLength(2);
    for (const update of updates) expect(update).toMatchObject({ status: 'completed' });
    const shell = updates.find(update => update.type === 'tool_call_update' && update.exitCode !== undefined);
    expect(shell).toMatchObject({ exitCode: 0 });
    const read = updates.find(update => update.type === 'tool_call_update' && update.output?.includes('hello from the fixture workspace'));
    expect(read).toBeDefined();
    // Each update follows its own start.
    for (const update of updates) {
      const startIndex = events.findIndex(event => event.type === 'tool_call' && event.toolCallId === (update as { toolCallId: string }).toolCallId);
      expect(startIndex).toBeLessThan(events.indexOf(update));
    }
  });

  test('tool_call carries Kiro title and raw input', () => {
    const call = replay('tools').events.find(event => event.type === 'tool_call' && event.name === 'execute');
    expect(call).toMatchObject({ title: expect.any(String), rawInput: { command: expect.stringContaining('tools-ok') } });
  });

  test('externally interrupted turn: the unfinished call closes as cancelled, the finished one stays completed', () => {
    const { events, mapper } = replay('interrupted', true);
    const updates = content(events).filter(event => event.type === 'tool_call_update');
    expect(updates.map(update => update.type === 'tool_call_update' && update.status)).toEqual(['completed', 'cancelled']);
    expect(mapper.summary.runError).toMatchObject({ stage: 'interrupted' });
    expect(mapper.errorIdentity(null)).toMatchObject({ stage: 'interrupted' });
  });

  test('a call to a tool the agent lacks is closed as failed', () => {
    const { events } = replay('denied-tool');
    const updates = events.filter(event => event.type === 'tool_call_update');
    expect(updates).toEqual([
      { type: 'tool_call_update', toolCallId: expect.any(String), status: 'failed', output: 'Tool "bash" is not available.' },
    ]);
  });

  test('a call Kiro never closes is closed by finish(): failed normally, cancelled when interrupted', () => {
    for (const [interrupted, status] of [[false, 'failed'], [true, 'cancelled']] as const) {
      const mapper = new KiroStreamMapper();
      mapper.push({ type: 'sessionUpdate', data: { sessionId: 'sess_x', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'run_shell_command', status: 'in_progress' } } });
      expect(mapper.finish(interrupted)).toEqual([{ type: 'tool_call_update', toolCallId: 't1', status }]);
    }
  });

  test('an update for an unseen call gets a synthetic start; duplicates are ignored', () => {
    const mapper = new KiroStreamMapper();
    const update = { sessionUpdate: 'tool_call_update', toolCallId: 'late', status: 'completed', title: 'Read File', content: [{ type: 'content', content: { type: 'text', text: 'x' } }] };
    const first = mapper.push({ type: 'sessionUpdate', data: { update } });
    expect(first.map(event => event.type)).toEqual(['tool_call', 'tool_call_update']);
    expect(mapper.push({ type: 'sessionUpdate', data: { update } })).toEqual([]);
    expect(mapper.push({ type: 'sessionUpdate', data: { update: { sessionUpdate: 'tool_call', toolCallId: 'late' } } })).toEqual([]);
  });

  test('tool output is truncated to the contract limit', () => {
    const mapper = new KiroStreamMapper();
    mapper.push({ type: 'sessionUpdate', data: { update: { sessionUpdate: 'tool_call', toolCallId: 'big', kind: 'read' } } });
    const [update] = mapper.push({
      type: 'sessionUpdate',
      data: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'big', status: 'completed', rawOutput: { output: 'y'.repeat(40_000) } } },
    });
    expect(update).toMatchObject({ outputTruncated: true });
    expect((update as { output: string }).output.length).toBe(16_384);
  });

  test('invalid-model failure: typed error fields come from display_error and the run error payload', () => {
    const { mapper } = replay('bad-model');
    expect(mapper.summary.finishedStatus).toBeUndefined();
    expect(mapper.summary.runError?.stage).toBe('prompt');
    expect(mapper.errorIdentity(1)).toEqual({ errorType: 'InvalidModelError', retryErrorType: 'CLIENT_ERROR', stage: 'prompt', exitCode: 1 });
    expect(mapper.stopReason()).toBeUndefined(); // Kiro's native "error" has no ACP name.
  });

  test('MCP turn: the tool-loader update without a start gets one; the MCP call closes with its result', () => {
    const { events, mapper } = replay('mcp');
    expect(mapper.summary.turnStarted).toBe(true);
    const calls = events.filter(event => event.type === 'tool_call');
    const updates = events.filter(event => event.type === 'tool_call_update');
    expect(calls.length).toBe(updates.length);
    expect(calls.some(call => call.type === 'tool_call' && call.title === '@secret/get_secret')).toBe(true);
    expect(updates.some(update => update.type === 'tool_call_update' && update.output === 'MCP-SECRET-77')).toBe(true);
  });

  test('MCP startup failure: typed error before the turn starts', () => {
    const { mapper } = replay('mcp-startup-failure');
    expect(mapper.summary.turnStarted).toBe(false);
    expect(mapper.errorIdentity(3)).toMatchObject({ errorType: 'mcp_connection_error', stage: 'init', exitCode: 3 });
  });

  test('missing resume session: init-stage error without a session id', () => {
    const { mapper } = replay('resume-missing');
    expect(mapper.summary.runError).toMatchObject({ stage: 'init' });
    expect(mapper.summary.sessionId).toBeUndefined();
  });

  test('a new reply message flushes the previous block', () => {
    const mapper = new KiroStreamMapper();
    const chunk = (text: string, replayId: string) => ({ type: 'sessionUpdate', data: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, _meta: { kiro: { replayId } } } } });
    expect(mapper.push(chunk('first', 'a'))).toEqual([]);
    expect(mapper.push(chunk(' block', 'a'))).toEqual([]);
    expect(mapper.push(chunk('second', 'b'))).toEqual([{ type: 'agent_message_chunk', text: 'first block' }]);
    expect(mapper.finish(false)).toEqual([{ type: 'agent_message_chunk', text: 'second' }]);
  });

  test('housekeeping updates become heartbeats at most every 10s', () => {
    let clock = 100_000;
    const mapper = new KiroStreamMapper(() => clock);
    const info = { type: 'sessionUpdate', data: { update: { sessionUpdate: 'session_info_update', _meta: { kiro: { kind: 'context_usage' } } } } };
    expect(mapper.push(info)).toEqual([{ type: 'heartbeat' }]);
    expect(mapper.push(info)).toEqual([]);
    clock += 10_000;
    expect(mapper.push(info)).toEqual([{ type: 'heartbeat' }]);
  });

  test('non-envelope input is ignored', () => {
    const mapper = new KiroStreamMapper();
    for (const junk of [null, 42, 'text', [], { type: 'sessionUpdate' }, { type: 'mystery', data: {} }]) {
      expect(mapper.push(junk)).toEqual([]);
    }
  });
});
