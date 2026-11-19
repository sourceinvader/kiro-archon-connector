/**
 * What Kiro turns cost, and the spending caps a workflow run and a workflow node may set.
 *
 * Kiro reports usage in credits once per turn (`turn_completion`). The plugin prices them
 * at `creditPriceUsd` for Archon's cost figures, and appends every turn to a JSON Lines log
 * (`<Archon home>/kiro-usage.jsonl`). Archon starts a new plugin process for every turn, so
 * the log is also where earlier turns of the same run are added up before the next turn.
 *
 * Archon gives a provider no run id. Every turn of one `archon workflow run` is started by
 * the same Archon process, so a run is that process (pid plus its start time, because pids
 * are reused) together with the working directory (the run's worktree, which keeps runs
 * apart under one long-lived Archon server).
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Kiro's price for a credit beyond a plan's monthly allowance, in US dollars. */
export const DEFAULT_CREDIT_PRICE_USD = 0.04;

export const USAGE_LOG_NAME = 'kiro-usage.jsonl';

/** One line of the usage log. */
export interface UsageEntry {
  time: string;
  /** The Archon process that started the turn: `<pid>@<start time>`. */
  run: string;
  cwd: string;
  /** Workflow node id; absent for chat turns. */
  node?: string;
  /** A workflow turn. Only these count against run and node budgets. */
  workflow: boolean;
  credits: number;
  usd: number;
  model?: string;
  sessionId?: string;
  status: 'success' | 'failed' | 'cancelled';
}

export interface BudgetCaps {
  /** `assistants.kiro.runBudgetUsd`. */
  runUsd?: number;
  /** The node's `maxBudgetUsd`. */
  nodeUsd?: number;
}

export interface Spend {
  runCredits: number;
  nodeCredits: number;
}

/** Where the usage log lives: `$ARCHON_HOME`, else `~/.archon`. */
export function usageLogPath(env: Record<string, string | undefined>): string {
  const archonHome = env.ARCHON_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.archon');
  return join(archonHome, USAGE_LOG_NAME);
}

let cachedRunId: string | undefined;

/** The Archon process that started this plugin process, as `<pid>@<start time>`. */
export function currentRunId(): string {
  if (cachedRunId !== undefined) return cachedRunId;
  const ppid = process.ppid;
  let started = '';
  try {
    const ps = spawnSync('ps', ['-o', 'lstart=', '-p', String(ppid)], { encoding: 'utf8', timeout: 5_000 });
    if (ps.status === 0) started = ps.stdout.trim().replace(/\s+/g, ' ');
  } catch {
    // No `ps`: the pid alone still separates runs that do not reuse it.
  }
  cachedRunId = started ? `${String(ppid)}@${started}` : String(ppid);
  return cachedRunId;
}

/**
 * Credits already logged for this run and this node. A missing log means nothing was spent;
 * any other read error is thrown, so the caller can say the budget went unchecked.
 */
export function readSpend(path: string, scope: { run: string; cwd: string; node?: string }): Spend {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { runCredits: 0, nodeCredits: 0 };
    throw error;
  }
  const spend: Spend = { runCredits: 0, nodeCredits: 0 };
  const runField = `"run":${JSON.stringify(scope.run)}`;
  for (const line of text.split('\n')) {
    // Cheap filter first: the log holds every run on this machine.
    if (!line.includes(runField)) continue;
    let entry: Partial<UsageEntry>;
    try {
      entry = JSON.parse(line) as Partial<UsageEntry>;
    } catch {
      continue;
    }
    if (entry.run !== scope.run || entry.cwd !== scope.cwd || entry.workflow !== true) continue;
    if (typeof entry.credits !== 'number' || !Number.isFinite(entry.credits)) continue;
    spend.runCredits += entry.credits;
    if (scope.node !== undefined && entry.node === scope.node) spend.nodeCredits += entry.credits;
  }
  return spend;
}

/** Append one turn. A single short line per write keeps concurrent turns from interleaving. */
export function recordUsage(path: string, entry: UsageEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

export function formatUsd(usd: number): string {
  return `$${usd < 1 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

export function formatCredits(credits: number): string {
  return `${credits.toFixed(2)} credit${credits.toFixed(2) === '1.00' ? '' : 's'}`;
}

function spendText(credits: number, price: number): string {
  return `${formatUsd(credits * price)} (${formatCredits(credits)})`;
}

/** Why a turn may not start, or undefined when every cap still has room. */
export function budgetRefusal(spend: Spend, caps: BudgetCaps, price: number, node?: string): string | undefined {
  if (caps.runUsd !== undefined && spend.runCredits * price >= caps.runUsd) {
    return (
      `Run budget reached: this run spent ${spendText(spend.runCredits, price)} on Kiro, ` +
      `and assistants.kiro.runBudgetUsd is ${formatUsd(caps.runUsd)}. No further Kiro turn starts in this run.`
    );
  }
  if (caps.nodeUsd !== undefined && spend.nodeCredits * price >= caps.nodeUsd) {
    return (
      `Node budget reached: node '${node ?? '?'}' spent ${spendText(spend.nodeCredits, price)} on Kiro in this run, ` +
      `and its maxBudgetUsd is ${formatUsd(caps.nodeUsd)}. No further Kiro turn starts for this node.`
    );
  }
  return undefined;
}

/** Warnings for the caps a finished turn took the totals past (it was under them when it started). */
export function budgetOverruns(
  before: Spend,
  credits: number,
  caps: BudgetCaps,
  price: number,
  node?: string
): { code: string; message: string }[] {
  const warnings: { code: string; message: string }[] = [];
  const runAfter = before.runCredits + credits;
  if (caps.runUsd !== undefined && runAfter * price > caps.runUsd) {
    warnings.push({
      code: 'kiro.run_budget_exceeded',
      message:
        `This turn took the run past its budget: ${spendText(runAfter, price)} spent, ` +
        `runBudgetUsd ${formatUsd(caps.runUsd)}. Later Kiro turns in this run will be refused.`,
    });
  }
  const nodeAfter = before.nodeCredits + credits;
  if (caps.nodeUsd !== undefined && nodeAfter * price > caps.nodeUsd) {
    warnings.push({
      code: 'kiro.node_budget_exceeded',
      message:
        `This turn took node '${node ?? '?'}' past its budget: ${spendText(nodeAfter, price)} spent, ` +
        `maxBudgetUsd ${formatUsd(caps.nodeUsd)}. Later Kiro turns of this node will be refused.`,
    });
  }
  return warnings;
}
