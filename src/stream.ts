import { truncateToolOutput, type ProviderEvent, type ProviderStopReason } from '@archon/provider-contract';
import { errorIdentityFromMessage, type KiroErrorIdentity } from './failure';

/**
 * Translates `kiro-cli chat --output-format stream-json` into Archon provider events.
 *
 * Kiro wraps ACP session updates in an envelope, one JSON object per line:
 *   {"type":"runStarted","data":{"payloadSchema":"acp","acpProtocolVersion":1,"engine":"v3"}}
 *   {"type":"sessionUpdate","data":{"sessionId":"sess_…","update":{"sessionUpdate":"tool_call",…}}}
 *   {"type":"runFinished","data":{"sessionId":"sess_…","status":"success","stopReason":"end_turn","finalText":"…"}}
 *   {"type":"runError","data":{"sessionId":"sess_…"|null,"stage":"init"|"prompt"|"interrupted","message":"…"}}
 *
 * Kiro streams reply text as token deltas; the contract wants whole blocks, so deltas are
 * coalesced and flushed at a tool call, a switch between reply and reasoning, a new reply
 * message, or the end of the turn. Tool calls get exactly one closing update each.
 */

const ACP_STOP_REASONS: ReadonlySet<string> = new Set([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
]);

/** How often non-content activity may reset Archon's idle watchdog. */
const HEARTBEAT_INTERVAL_MS = 10_000;

export interface KiroRunSummary {
  sessionId?: string;
  /** `runFinished.status` (`success`, …) when the run finished. */
  finishedStatus?: string;
  /** Kiro's native stop reason (`end_turn`, `refusal`, `error`, …). */
  nativeStopReason?: string;
  finalText?: string;
  /** The whole reply as streamed, for when `runFinished` carries no final text. */
  streamedText: string;
  runError?: { stage?: string; message: string };
  /** The latest structured error Kiro displayed during the turn. */
  displayError?: { message: string; errorType?: string; retryErrorType?: string };
  /** Kiro credits the turn used, summed over its turn summaries. */
  credits?: number;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Strip the blank lines Kiro puts around reply blocks; keep everything else verbatim. */
function trimBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/(?:\r?\n[ \t]*)+$/, '');
}

export class KiroStreamMapper {
  private text = '';
  private textMessageId: string | undefined;
  private thought = '';
  private readonly openTools = new Set<string>();
  private readonly seenTools = new Set<string>();
  private lastHeartbeat = 0;
  readonly summary: KiroRunSummary = { streamedText: '' };

  constructor(private readonly now: () => number = Date.now) {}

  /** Feed one parsed stdout line; returns the events it completes, in order. */
  push(line: unknown): ProviderEvent[] {
    if (!isObject(line) || !isObject(line.data)) return [];
    const data = line.data;
    switch (line.type) {
      case 'sessionUpdate':
        this.noteSession(data.sessionId);
        return isObject(data.update) ? this.onUpdate(data.update) : [];
      case 'runFinished':
        this.noteSession(data.sessionId);
        this.summary.finishedStatus = str(data.status);
        this.summary.nativeStopReason = str(data.stopReason) ?? this.summary.nativeStopReason;
        this.summary.finalText = str(data.finalText);
        return [];
      case 'runError':
        this.noteSession(data.sessionId);
        this.summary.runError = { stage: str(data.stage), message: str(data.message) ?? 'Kiro reported a run error' };
        return [];
      default:
        return [];
    }
  }

  /**
   * End of the turn: flush buffered text and close every tool call Kiro left open.
   * `interrupted` closes them as `cancelled`; otherwise a call Kiro never finished
   * (for example a tool the session does not have) closes as `failed`.
   */
  finish(interrupted: boolean): ProviderEvent[] {
    const events = this.flush();
    const status = interrupted ? 'cancelled' : 'failed';
    for (const toolCallId of this.openTools) {
      events.push({ type: 'tool_call_update', toolCallId, status });
    }
    this.openTools.clear();
    return events;
  }

  /** Error identity for classification: the displayed error first, then the run error payload. */
  errorIdentity(exitCode: number | null): KiroErrorIdentity {
    const fromMessage = this.summary.runError ? errorIdentityFromMessage(this.summary.runError.message) : {};
    return {
      errorType: this.summary.displayError?.errorType ?? fromMessage.errorType,
      retryErrorType: this.summary.displayError?.retryErrorType ?? fromMessage.retryErrorType,
      stage: this.summary.runError?.stage,
      exitCode,
    };
  }

  stopReason(): ProviderStopReason | undefined {
    const reason = this.summary.nativeStopReason;
    return reason !== undefined && ACP_STOP_REASONS.has(reason) ? (reason as ProviderStopReason) : undefined;
  }

  private noteSession(sessionId: unknown): void {
    if (typeof sessionId === 'string' && sessionId.length > 0) this.summary.sessionId = sessionId;
  }

  private onUpdate(update: Json): ProviderEvent[] {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        return this.onMessageChunk(update);
      case 'agent_thought_chunk': {
        const events = this.flushText();
        const content = isObject(update.content) ? update.content : undefined;
        if (content?.type === 'text' && typeof content.text === 'string') this.thought += content.text;
        return events;
      }
      case 'tool_call':
        return this.onToolCall(update);
      case 'tool_call_update':
        return this.onToolCallUpdate(update);
      case 'session_info_update':
        return this.onSessionInfo(update);
      default:
        // available_commands_update, config_option_update, plan, current_mode_update, …
        return this.heartbeat();
    }
  }

  private onMessageChunk(update: Json): ProviderEvent[] {
    const content = isObject(update.content) ? update.content : undefined;
    if (content?.type !== 'text' || typeof content.text !== 'string') return [];
    const events = this.flushThought();
    const meta = isObject(update._meta) && isObject(update._meta.kiro) ? update._meta.kiro : undefined;
    const messageId = str(meta?.replayId) ?? str(meta?.turnId);
    if (messageId !== undefined && this.textMessageId !== undefined && messageId !== this.textMessageId) {
      events.push(...this.flushText());
    }
    if (messageId !== undefined) this.textMessageId = messageId;
    this.text += content.text;
    this.summary.streamedText += content.text;
    return events;
  }

  private onToolCall(update: Json): ProviderEvent[] {
    const toolCallId = str(update.toolCallId);
    if (!toolCallId || this.seenTools.has(toolCallId)) return [];
    const events = this.flush();
    events.push(this.startTool(toolCallId, update));
    const status = str(update.status);
    if (status === 'completed' || status === 'failed') events.push(this.closeTool(toolCallId, status, update));
    return events;
  }

  private onToolCallUpdate(update: Json): ProviderEvent[] {
    const toolCallId = str(update.toolCallId);
    const status = str(update.status);
    if (!toolCallId || (status !== 'completed' && status !== 'failed')) return this.heartbeat();
    const events: ProviderEvent[] = [];
    if (!this.seenTools.has(toolCallId)) {
      events.push(...this.flush(), this.startTool(toolCallId, update));
    }
    if (this.openTools.has(toolCallId)) events.push(this.closeTool(toolCallId, status, update));
    return events;
  }

  private startTool(toolCallId: string, update: Json): ProviderEvent {
    this.seenTools.add(toolCallId);
    this.openTools.add(toolCallId);
    const title = str(update.title);
    // ACP's `kind` (read, edit, execute, search, fetch, …) is the stable programmatic
    // name Kiro gives every call; the title is its human label.
    const name = str(update.kind) ?? title ?? 'tool';
    const event: ProviderEvent = { type: 'tool_call', toolCallId, name };
    if (title) event.title = title;
    if (update.rawInput !== undefined) event.rawInput = update.rawInput as never;
    return event;
  }

  private closeTool(toolCallId: string, status: 'completed' | 'failed', update: Json): ProviderEvent {
    this.openTools.delete(toolCallId);
    const event: ProviderEvent = { type: 'tool_call_update', toolCallId, status };
    const output = toolOutputText(update);
    if (output !== undefined && output.length > 0) Object.assign(event, truncateToolOutput(output));
    const raw = isObject(update.rawOutput) ? update.rawOutput : undefined;
    if (typeof raw?.exitCode === 'number' && Number.isInteger(raw.exitCode)) event.exitCode = raw.exitCode;
    return event;
  }

  private onSessionInfo(update: Json): ProviderEvent[] {
    const kiro = isObject(update._meta) && isObject(update._meta.kiro) ? update._meta.kiro : undefined;
    switch (kiro?.kind) {
      case 'turn_end': {
        const turnEnd = isObject(kiro.turnEnd) ? kiro.turnEnd : undefined;
        this.summary.nativeStopReason = str(turnEnd?.stopReason) ?? str(kiro.stopReason) ?? this.summary.nativeStopReason;
        return [];
      }
      case 'turn_completion': {
        const summaries = Array.isArray(kiro.promptTurnSummaries) ? kiro.promptTurnSummaries : [];
        for (const summary of summaries) {
          if (isObject(summary) && summary.unit === 'credit' && typeof summary.usage === 'number') {
            this.summary.credits = (this.summary.credits ?? 0) + summary.usage;
          }
        }
        return [];
      }
      case 'display_error': {
        const shown = isObject(kiro.displayError) ? kiro.displayError : kiro;
        this.summary.displayError = {
          message: str(shown.message) ?? 'Kiro displayed an error',
          errorType: str(shown.errorType),
          retryErrorType: str(shown.retryErrorType),
        };
        return [];
      }
      default:
        return this.heartbeat();
    }
  }

  private heartbeat(): ProviderEvent[] {
    const now = this.now();
    if (now - this.lastHeartbeat < HEARTBEAT_INTERVAL_MS) return [];
    this.lastHeartbeat = now;
    return [{ type: 'heartbeat' }];
  }

  private flush(): ProviderEvent[] {
    return [...this.flushThought(), ...this.flushText()];
  }

  private flushText(): ProviderEvent[] {
    const text = trimBlankLines(this.text);
    this.text = '';
    this.textMessageId = undefined;
    return text.trim().length > 0 ? [{ type: 'agent_message_chunk', text }] : [];
  }

  private flushThought(): ProviderEvent[] {
    const text = trimBlankLines(this.thought);
    this.thought = '';
    return text.trim().length > 0 ? [{ type: 'agent_thought_chunk', text }] : [];
  }
}

/** A tool's output as text: ACP `content` text blocks, else Kiro's `rawOutput`. */
function toolOutputText(update: Json): string | undefined {
  const parts: string[] = [];
  if (Array.isArray(update.content)) {
    for (const block of update.content) {
      if (!isObject(block)) continue;
      if (block.type === 'content' && isObject(block.content) && typeof block.content.text === 'string') {
        parts.push(block.content.text);
      } else if (block.type === 'diff' && typeof block.path === 'string') {
        parts.push(`Edited ${block.path}`);
      }
    }
  }
  if (parts.length > 0) return parts.join('\n');
  const raw = update.rawOutput;
  if (typeof raw === 'string') return raw;
  if (isObject(raw)) return str(raw.message) ?? str(raw.output);
  return undefined;
}
