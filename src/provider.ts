import {
  buildProviderSubprocessEnv,
  type CredentialStatus,
  type IAgentProvider,
  type MessageChunk,
  type ProviderCapabilities,
  type ProviderDiagnostics,
  type ProviderFailureClass,
  type ProviderModelList,
  type ResultChunk,
  type SendQueryOptions,
  type SystemPromptInput,
} from '@archon/provider-contract';
import type { ProviderLogSink } from '@archon/provider-contract/plugin';
import {
  AgentConfigError,
  createEphemeralAgent,
  needsEphemeralAgent,
  type EphemeralAgent,
  type EphemeralAgentSpec,
} from './agent-file';
import { kiroEffort, readAssistantConfig, type KiroEffort } from './config';
import { KIRO_CAPABILITIES, PROVIDER_ID } from './descriptor';
import { classifyKiroFailure } from './failure';
import { kiroSessionExists, listKiroModels, readKiroVersion, readLoginState } from './kiro-cli';
import { runKiroProcess } from './process';
import { KiroStreamMapper } from './stream';
import { augmentPromptForJsonSchema, tryParseStructuredOutput } from './structured-output';

export interface TurnSettings {
  bin: string;
  model?: string;
  agent?: string;
  effort?: KiroEffort;
  trustAllTools: boolean;
  agentSpec: EphemeralAgentSpec;
}

type Env = Record<string, string>;

function subprocessEnv(options: Pick<SendQueryOptions, 'env' | 'execContext'>): Env {
  const env: Env = {};
  for (const [key, value] of Object.entries(buildProviderSubprocessEnv(options))) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map(entry => entry.trim());
}

function promptText(input: SystemPromptInput | undefined): string | undefined {
  if (input === undefined) return undefined;
  const text = Array.isArray(input) ? input.join('\n\n') : input;
  return text.trim().length > 0 ? text : undefined;
}

/** Everything one turn needs from the request, the node and `assistants.kiro`. */
export function resolveTurnSettings(options: SendQueryOptions, env: Env): TurnSettings {
  const config = readAssistantConfig(options.assistantConfig);
  const node = options.nodeConfig;
  const model = options.model?.trim() || config.model;
  const effort = kiroEffort(node?.effort) ?? config.effort;
  const allowedTools = stringList(node?.allowed_tools);
  const deniedTools = stringList(node?.denied_tools);
  const systemPrompt = promptText(options.systemPrompt) ?? promptText(node?.systemPrompt);
  const appendSystemPrompt = options.appendSystemPrompt?.trim() ? options.appendSystemPrompt : undefined;
  return {
    bin: config.kiroPath ?? (env.KIRO_CLI_PATH?.trim() || 'kiro-cli'),
    ...(model ? { model } : {}),
    ...(config.agent ? { agent: config.agent } : {}),
    ...(effort ? { effort } : {}),
    trustAllTools: config.trustAllTools ?? true,
    agentSpec: {
      ...(config.agent ? { baseAgent: config.agent } : {}),
      ...(allowedTools ? { allowedTools } : {}),
      ...(deniedTools ? { deniedTools } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
    },
  };
}

/** `kiro-cli chat` arguments for one headless turn. The instruction goes to stdin. */
export function buildChatArgs(settings: {
  model?: string;
  agent?: string;
  effort?: KiroEffort;
  trustAllTools: boolean;
  resumeSessionId?: string;
}): string[] {
  const args = ['chat', '--v3', '--no-interactive', '--output-format', 'stream-json'];
  if (settings.resumeSessionId) args.push('--resume-id', settings.resumeSessionId);
  if (settings.model) args.push('--model', settings.model);
  if (settings.agent) args.push('--agent', settings.agent);
  if (settings.effort) args.push('--effort', settings.effort);
  if (settings.trustAllTools) args.push('--trust-all-tools');
  return args;
}

function failureResult(failureClass: ProviderFailureClass, evidence: string, extra: Partial<ResultChunk> = {}): ResultChunk {
  const result: ResultChunk = { type: 'result', ...extra };
  result.isError = true;
  result.failure = { class: failureClass, evidence };
  result.errors = [evidence];
  return result;
}

function trimBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/(?:\r?\n[ \t]*)+$/, '');
}

export class KiroProvider implements IAgentProvider {
  constructor(private readonly log?: ProviderLogSink) {}

  getType(): string {
    return PROVIDER_ID;
  }

  getCapabilities(): ProviderCapabilities {
    return KIRO_CAPABILITIES;
  }

  async *sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options: SendQueryOptions = {}
  ): AsyncGenerator<MessageChunk> {
    const env = subprocessEnv(options);
    const settings = resolveTurnSettings(options, env);
    const signal = options.abortSignal;

    if (options.execContext?.kind === 'container') {
      yield* this.failTurn('misconfigured', 'The Kiro provider runs on the host only; container execution is not supported');
      return;
    }
    if (prompt.trim().length === 0) {
      yield* this.failTurn('misconfigured', 'Kiro needs a non-empty instruction');
      return;
    }

    // Signed-out headless Kiro starts an interactive browser login instead of failing,
    // so check the login first. An API key needs no login.
    if (!env.KIRO_API_KEY) {
      const login = await readLoginState(settings.bin, env, signal);
      if (signal?.aborted) return;
      if (login.state === 'missing') {
        yield* this.failTurn('misconfigured', `kiro-cli was not found at '${login.bin}'; install Kiro CLI or set assistants.kiro.kiroPath`);
        return;
      }
      if (login.state === 'signed_out') {
        yield* this.failTurn('auth', 'kiro-cli whoami reports no signed-in account (account: null); run `kiro-cli login` or set KIRO_API_KEY');
        return;
      }
    }

    let agent: EphemeralAgent | undefined;
    if (needsEphemeralAgent(settings.agentSpec)) {
      try {
        agent = await createEphemeralAgent(settings.agentSpec, { cwd, env });
      } catch (error) {
        if (!(error instanceof AgentConfigError)) throw error;
        yield* this.failTurn('misconfigured', error.message);
        return;
      }
    }

    try {
      const input = options.outputFormat
        ? augmentPromptForJsonSchema(prompt, options.outputFormat.schema)
        : prompt;
      const args = buildChatArgs({
        ...settings,
        ...(agent ? { agent: agent.name } : {}),
        ...(resumeSessionId ? { resumeSessionId } : {}),
      });
      const mapper = new KiroStreamMapper();
      let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      let spawnError: { code: string | undefined; bin: string } | undefined;
      for await (const item of runKiroProcess({ bin: settings.bin, args, cwd, env, input, signal })) {
        if (item.kind === 'line') yield* mapper.push(item.value);
        else if (item.kind === 'exit') exit = item;
        else spawnError = item;
      }

      if (signal?.aborted) {
        // Cancelled: close what the stream opened, but never claim the turn settled.
        yield* mapper.finish(true);
        return;
      }
      if (spawnError) {
        yield* this.failTurn(
          'misconfigured',
          spawnError.code === 'ENOENT' || spawnError.code === 'EACCES'
            ? `kiro-cli was not found at '${spawnError.bin}'; install Kiro CLI or set assistants.kiro.kiroPath`
            : `kiro-cli could not start (${spawnError.code ?? 'unknown error'})`
        );
        return;
      }

      const summary = mapper.summary;
      const interrupted = summary.runError?.stage === 'interrupted' || (exit?.signal ?? null) !== null;
      yield* mapper.finish(interrupted);
      if (exit && (exit.code !== 0 || exit.signal !== null)) {
        await this.log?.({ level: 'warn', msg: 'kiro.process_abnormal_exit', bindings: { lifecycle: 'process_abnormal_exit' } });
      }

      const result = await this.buildResult({ mapper, exit, resumeSessionId, cwd, env, settings, options });
      if (result.failure) {
        await this.log?.({ level: 'warn', msg: 'kiro.turn_failed', bindings: { failureClass: result.failure.class } });
      }
      yield result;
      yield { type: 'settled' };
    } finally {
      await agent?.dispose();
    }
  }

  private async buildResult(turn: {
    mapper: KiroStreamMapper;
    exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    resumeSessionId: string | undefined;
    cwd: string;
    env: Env;
    settings: TurnSettings;
    options: SendQueryOptions;
  }): Promise<ResultChunk> {
    const { mapper, exit, resumeSessionId } = turn;
    const summary = mapper.summary;
    const text = trimBlankLines(summary.finalText ?? '') || trimBlankLines(summary.streamedText);
    const stopReason = mapper.stopReason();
    const base: Partial<ResultChunk> = {
      ...(summary.sessionId ? { sessionId: summary.sessionId } : {}),
      ...(text ? { text } : {}),
      ...(stopReason ? { stopReason } : {}),
    };

    if (summary.finishedStatus === 'success' && !summary.runError) {
      const result: ResultChunk = { type: 'result', ...base };
      if (resumeSessionId) result.resumed = summary.sessionId === resumeSessionId;
      if (turn.options.outputFormat) {
        const structured = tryParseStructuredOutput(text);
        if (structured !== undefined) result.structuredOutput = structured;
      }
      return result;
    }

    if (!summary.runError && summary.finishedStatus === undefined) {
      const how = exit?.signal ? `signal ${exit.signal}` : `code ${String(exit?.code ?? null)}`;
      return failureResult('transient', `kiro-cli exited (${how}) before reporting the end of the run`, base);
    }

    const identity = mapper.errorIdentity(exit?.code ?? null);
    const message =
      summary.runError?.message ?? summary.displayError?.message ?? `Kiro run ended with status ${summary.finishedStatus ?? 'unknown'}`;
    const evidence = identity.errorType ? `${identity.errorType}: ${message}` : message;
    const result = failureResult(classifyKiroFailure(identity), evidence, base);
    const subtype = identity.errorType ?? identity.stage;
    if (subtype) result.errorSubtype = subtype;

    // A resume Kiro rejected at startup did no model work. Only a complete session list
    // that lacks the id (a structured check, not the error text) marks it as missing.
    if (resumeSessionId && summary.runError?.stage === 'init' && !summary.sessionId) {
      const exists = await kiroSessionExists(turn.settings.bin, turn.cwd, resumeSessionId, turn.env, turn.options.abortSignal);
      if (exists === false) result.sessionNotFound = true;
    }
    return result;
  }

  private async *failTurn(failureClass: ProviderFailureClass, evidence: string): AsyncGenerator<MessageChunk> {
    await this.log?.({ level: 'warn', msg: 'kiro.turn_failed', bindings: { failureClass } });
    yield failureResult(failureClass, evidence);
    yield { type: 'settled' };
  }

  async checkCredential(request: {
    env: Record<string, string>;
    signal: AbortSignal;
    assistantConfig?: Record<string, unknown>;
    execContext?: SendQueryOptions['execContext'];
  }): Promise<CredentialStatus> {
    if (request.execContext?.kind === 'container') return { state: 'not_checked', source: 'native' };
    if (request.env.KIRO_API_KEY && request.env.KIRO_API_KEY.trim().length > 0) {
      return { state: 'usable', source: 'native' };
    }
    const config = readAssistantConfig(request.assistantConfig);
    const bin = config.kiroPath ?? (request.env.KIRO_CLI_PATH?.trim() || 'kiro-cli');
    const login = await readLoginState(bin, request.env, request.signal);
    switch (login.state) {
      case 'signed_in':
        return { state: 'usable', source: 'native' };
      case 'signed_out':
        return { state: 'not_connected', source: 'native' };
      case 'missing':
        return { state: 'check_failed', source: 'native', evidence: `kiro-cli was not found at '${login.bin}'` };
      case 'unknown':
        return { state: 'check_failed', source: 'native', evidence: login.evidence };
    }
  }

  async listModels(request: { signal: AbortSignal }): Promise<ProviderModelList> {
    const env = subprocessEnv({});
    const bin = env.KIRO_CLI_PATH?.trim() || 'kiro-cli';
    const outcome = await listKiroModels(bin, env, request.signal);
    if (outcome.kind === 'missing') throw new Error(`kiro-cli was not found at '${outcome.bin}'`);
    if (outcome.kind === 'failed') throw new Error(outcome.evidence);
    return {
      models: outcome.models.map(model => ({
        id: model.id,
        label:
          model.rateMultiplier !== undefined
            ? `${model.name ?? model.id} (${String(model.rateMultiplier)}x ${model.rateUnit ?? 'Credit'})`
            : (model.name ?? model.id),
      })),
    };
  }

  async diagnose(request: {
    signal: AbortSignal;
    assistantConfig?: Record<string, unknown>;
  }): Promise<ProviderDiagnostics> {
    const env = subprocessEnv({});
    const config = readAssistantConfig(request.assistantConfig);
    const bin = config.kiroPath ?? (env.KIRO_CLI_PATH?.trim() || 'kiro-cli');
    const checks: ProviderDiagnostics['checks'] = [];

    const version = await readKiroVersion(bin, env, request.signal);
    if (version.kind !== 'ok') {
      checks.push({
        id: 'kiro-cli',
        label: 'Kiro CLI',
        status: 'fail',
        message: version.kind === 'missing' ? `kiro-cli was not found at '${version.bin}'` : version.evidence,
        remedy: 'Install Kiro CLI (https://kiro.dev/docs/cli/) or set assistants.kiro.kiroPath',
      });
      return { checks };
    }
    checks.push({ id: 'kiro-cli', label: 'Kiro CLI', status: 'ok', message: `kiro-cli ${version.version} at ${bin}` });

    if (env.KIRO_API_KEY) {
      checks.push({ id: 'login', label: 'Kiro login', status: 'ok', message: 'KIRO_API_KEY is set (headless API key)' });
    } else {
      const login = await readLoginState(bin, env, request.signal);
      checks.push(
        login.state === 'signed_in'
          ? { id: 'login', label: 'Kiro login', status: 'ok', message: `Signed in${login.accountType ? ` (${login.accountType})` : ''}` }
          : login.state === 'signed_out'
            ? { id: 'login', label: 'Kiro login', status: 'fail', message: 'No signed-in Kiro account', remedy: 'Run `kiro-cli login`, or set KIRO_API_KEY' }
            : { id: 'login', label: 'Kiro login', status: 'warn', message: login.state === 'missing' ? 'kiro-cli not found' : login.evidence }
      );
    }

    if (config.model) {
      const models = await listKiroModels(bin, env, request.signal);
      if (models.kind !== 'ok') {
        checks.push({ id: 'model', label: 'Kiro model', status: 'warn', message: models.kind === 'missing' ? 'kiro-cli not found' : models.evidence });
      } else if (models.models.some(model => model.id === config.model)) {
        checks.push({ id: 'model', label: 'Kiro model', status: 'ok', message: `Model '${config.model}' is available` });
      } else {
        checks.push({
          id: 'model',
          label: 'Kiro model',
          status: 'fail',
          message: `Model '${config.model}' is not offered to this account`,
          remedy: `Pick one of: ${models.models.map(model => model.id).join(', ')}`,
        });
      }
    } else {
      checks.push({ id: 'model', label: 'Kiro model', status: 'skip', message: "No model configured; Kiro's default applies" });
    }
    return { checks };
  }
}
