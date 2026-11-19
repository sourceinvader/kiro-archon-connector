import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  budgetOverruns,
  budgetRefusal,
  currentRunId,
  formatCredits,
  formatUsd,
  readSpend,
  recordUsage,
  usageLogPath,
  type UsageEntry,
} from '../../src/budget';

let dir: string;
let log: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'kiro-budget-'));
  log = join(dir, 'archon-home', 'kiro-usage.jsonl');
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const entry = (overrides: Partial<UsageEntry>): UsageEntry => ({
  time: '2026-11-19T00:00:00.000Z',
  run: 'r1',
  cwd: '/w',
  workflow: true,
  credits: 1,
  usd: 0.04,
  status: 'success',
  ...overrides,
});

describe('usageLogPath', () => {
  test('ARCHON_HOME wins, else ~/.archon', () => {
    expect(usageLogPath({ ARCHON_HOME: '/a', HOME: '/h' })).toBe('/a/kiro-usage.jsonl');
    expect(usageLogPath({ HOME: '/h' })).toBe('/h/.archon/kiro-usage.jsonl');
  });
});

describe('currentRunId', () => {
  test('names the parent process, with its start time when ps can tell', () => {
    expect(currentRunId()).toMatch(new RegExp(`^${String(process.ppid)}(@.+)?$`));
    expect(currentRunId()).toBe(currentRunId());
  });
});

describe('readSpend / recordUsage', () => {
  test('no log yet means nothing spent', () => {
    expect(readSpend(log, { run: 'r1', cwd: '/w', node: 'a' })).toEqual({ runCredits: 0, nodeCredits: 0 });
  });

  test('sums the same run and working directory; the node total only that node', async () => {
    recordUsage(log, entry({ node: 'a', credits: 1 }));
    recordUsage(log, entry({ node: 'a', credits: 0.5 }));
    recordUsage(log, entry({ node: 'b', credits: 2 }));
    recordUsage(log, entry({ run: 'r2', node: 'a', credits: 10 })); // another run
    recordUsage(log, entry({ cwd: '/other', node: 'a', credits: 20 })); // another worktree
    recordUsage(log, entry({ workflow: false, credits: 40 })); // a chat turn
    await writeFile(log, `${await readFile(log, 'utf8')}not json "run":"r1"\n`);
    expect(readSpend(log, { run: 'r1', cwd: '/w', node: 'a' })).toEqual({ runCredits: 3.5, nodeCredits: 1.5 });
    expect(readSpend(log, { run: 'r1', cwd: '/w' })).toEqual({ runCredits: 3.5, nodeCredits: 0 });
  });

  test('a log that cannot be read is an error, not an empty log', async () => {
    await mkdir(log, { recursive: true });
    expect(() => readSpend(log, { run: 'r1', cwd: '/w' })).toThrow();
  });
});

describe('budgetRefusal / budgetOverruns', () => {
  const price = 0.04;

  test('refuses once spend reaches a cap, run first', () => {
    expect(budgetRefusal({ runCredits: 49, nodeCredits: 49 }, { runUsd: 2, nodeUsd: 2 }, price, 'a')).toBeUndefined();
    expect(budgetRefusal({ runCredits: 50, nodeCredits: 0 }, { runUsd: 2 }, price, 'a')).toContain('assistants.kiro.runBudgetUsd is $2.00');
    const node = budgetRefusal({ runCredits: 50, nodeCredits: 50 }, { nodeUsd: 2 }, price, 'repair');
    expect(node).toContain("node 'repair' spent $2.00 (50.00 credits)");
    expect(budgetRefusal({ runCredits: 1e6, nodeCredits: 1e6 }, {}, price)).toBeUndefined();
  });

  test('warns only for the caps a turn took the totals past', () => {
    const before = { runCredits: 40, nodeCredits: 5 };
    expect(budgetOverruns(before, 5, { runUsd: 2, nodeUsd: 2 }, price, 'a')).toEqual([]);
    expect(budgetOverruns(before, 15, { runUsd: 2, nodeUsd: 2 }, price, 'a').map(w => w.code)).toEqual(['kiro.run_budget_exceeded']);
    expect(budgetOverruns(before, 50, { runUsd: 3, nodeUsd: 2 }, price, 'a').map(w => w.code)).toEqual([
      'kiro.run_budget_exceeded',
      'kiro.node_budget_exceeded',
    ]);
  });

  test('formats small dollar amounts with enough digits to be useful', () => {
    expect(formatUsd(0.0038723)).toBe('$0.0039');
    expect(formatUsd(2)).toBe('$2.00');
    expect(formatCredits(1)).toBe('1.00 credit');
    expect(formatCredits(0.0968)).toBe('0.10 credits');
  });
});
