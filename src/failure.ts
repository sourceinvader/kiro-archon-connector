import type { ProviderFailureClass } from '@archon/provider-contract';

/**
 * Kiro's structured error identity for a failed run. `errorType` is the vendor's exception
 * or error class name (`ThrottlingException`, `InvalidModelError`), `retryErrorType` its
 * retry category (`THROTTLING`, `TRANSIENT`, `SERVER_ERROR`, `CLIENT_ERROR`, quota windows).
 * Both come from Kiro's typed error payload, never from its prose.
 */
export interface KiroErrorIdentity {
  errorType?: string;
  retryErrorType?: string;
  /** `runError.stage`: `init`, `prompt`, `interrupted`, ... */
  stage?: string;
  exitCode?: number | null;
}

// Names taken from the error classes Kiro's agent server (KAS) raises. Unknown names fall
// through to the retry category, then to `unknown`.
const AUTH = new Set([
  'AccessDeniedException',
  'ExpiredTokenException',
  'UnauthorizedException',
  'UnauthorizedClientException',
  'UnauthorizedError',
  'ForbiddenException',
  'InvalidIdentityTokenException',
  'ProviderConnectionExpiredException',
  'TokenExpiredError',
  'TokenInvalidError',
  'TokenProviderError',
  'OAuthError',
  'ModelRegistryUnauthenticatedError',
]);
const QUOTA = new Set([
  'ServiceQuotaExceededException',
  'UsageLimitReachedError',
  'QuotaExceededError',
  'OverageLimitReachedError',
]);
const RATE_LIMITED = new Set([
  'ThrottlingException',
  'ThrottledException',
  'RequestThrottledException',
  'ModelThrottleError',
  'ServiceThrottleError',
  'ClientThrottleError',
]);
const OVERLOADED = new Set(['InsufficientModelCapacityError', 'ServiceUnavailableException']);
const MISCONFIGURED = new Set([
  'InvalidModelError',
  'ProxyAuthenticationRequiredError',
  'ModelRoutingConfigParseError',
]);
const TRANSIENT = new Set(['ConnectionResetError', 'ModelRefreshTimeoutError']);

const RETRY_CATEGORY: Record<string, ProviderFailureClass> = {
  THROTTLING: 'rate_limited',
  TRANSIENT: 'transient',
  SERVER_ERROR: 'transient',
  HOURLY_REQUEST_COUNT: 'quota_exhausted',
  DAILY_REQUEST_COUNT: 'quota_exhausted',
  WEEKLY_REQUEST_COUNT: 'quota_exhausted',
  ECONNRESET: 'transient',
  ECONNREFUSED: 'transient',
  ECONNABORTED: 'transient',
  ETIMEDOUT: 'transient',
  ENOTFOUND: 'transient',
  ENETUNREACH: 'transient',
  EHOSTUNREACH: 'transient',
  EAI_AGAIN: 'transient',
};

/** Documented `kiro-cli chat` exit code: the requested agent is unavailable. */
export const EXIT_AGENT_UNAVAILABLE = 4;

export function classifyKiroFailure(error: KiroErrorIdentity): ProviderFailureClass {
  const type = error.errorType;
  if (type !== undefined) {
    if (AUTH.has(type)) return 'auth';
    if (QUOTA.has(type)) return 'quota_exhausted';
    if (RATE_LIMITED.has(type)) return 'rate_limited';
    if (OVERLOADED.has(type)) return 'overloaded';
    if (MISCONFIGURED.has(type)) return 'misconfigured';
    if (TRANSIENT.has(type)) return 'transient';
  }
  const category = error.retryErrorType !== undefined ? RETRY_CATEGORY[error.retryErrorType] : undefined;
  if (category) return category;
  if (error.stage === 'init' && error.exitCode === EXIT_AGENT_UNAVAILABLE) return 'misconfigured';
  // A signal from outside this plugin ended the run (our own cancellation never reports).
  if (error.stage === 'interrupted') return 'transient';
  return 'unknown';
}

/**
 * Kiro appends its JSON-RPC error data to a run error's message as
 * `... (code -32000): {"errorType":"...","retryErrorType":"..."}`. That suffix is a
 * serialized structured payload, so it is parsed as JSON, never pattern-matched as prose.
 */
export function errorIdentityFromMessage(message: string): Pick<KiroErrorIdentity, 'errorType' | 'retryErrorType'> {
  const marker = /\(code -?\d+\): (\{[\s\S]*\})\s*$/.exec(message);
  if (!marker?.[1]) return {};
  try {
    const data: unknown = JSON.parse(marker[1]);
    if (data === null || typeof data !== 'object') return {};
    const { errorType, retryErrorType } = data as Record<string, unknown>;
    return {
      ...(typeof errorType === 'string' ? { errorType } : {}),
      ...(typeof retryErrorType === 'string' ? { retryErrorType } : {}),
    };
  } catch {
    return {};
  }
}
