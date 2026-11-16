import { describe, expect, test } from 'bun:test';
import { classifyKiroFailure, errorIdentityFromMessage } from '../../src/failure';

describe('classifyKiroFailure', () => {
  const cases: [Parameters<typeof classifyKiroFailure>[0], string][] = [
    [{ errorType: 'AccessDeniedException', retryErrorType: 'CLIENT_ERROR' }, 'auth'],
    [{ errorType: 'ExpiredTokenException' }, 'auth'],
    [{ errorType: 'UnauthorizedException' }, 'auth'],
    [{ errorType: 'ServiceQuotaExceededException', retryErrorType: 'CLIENT_ERROR' }, 'quota_exhausted'],
    [{ errorType: 'UsageLimitReachedError' }, 'quota_exhausted'],
    [{ errorType: 'ThrottlingException', retryErrorType: 'THROTTLING' }, 'rate_limited'],
    [{ errorType: 'ModelThrottleError' }, 'rate_limited'],
    [{ errorType: 'InsufficientModelCapacityError', retryErrorType: 'SERVER_ERROR' }, 'overloaded'],
    [{ errorType: 'InvalidModelError', retryErrorType: 'CLIENT_ERROR' }, 'misconfigured'],
    [{ errorType: 'ConnectionResetError' }, 'transient'],
    // Unknown class name: fall back to the retry category.
    [{ errorType: 'SomethingNewException', retryErrorType: 'THROTTLING' }, 'rate_limited'],
    [{ retryErrorType: 'TRANSIENT' }, 'transient'],
    [{ retryErrorType: 'SERVER_ERROR' }, 'transient'],
    [{ retryErrorType: 'DAILY_REQUEST_COUNT' }, 'quota_exhausted'],
    [{ retryErrorType: 'ETIMEDOUT' }, 'transient'],
    [{ retryErrorType: 'CLIENT_ERROR' }, 'unknown'],
    // Documented exit code 4: the agent is unavailable.
    [{ stage: 'init', exitCode: 4 }, 'misconfigured'],
    // MCP startup (--require-mcp-startup): typed error, or the documented exit code 3.
    [{ errorType: 'mcp_connection_error', stage: 'init', exitCode: 3 }, 'misconfigured'],
    [{ stage: 'init', exitCode: 3 }, 'misconfigured'],
    [{ stage: 'interrupted' }, 'transient'],
    [{ stage: 'init', exitCode: 1 }, 'unknown'],
    [{}, 'unknown'],
  ];
  for (const [identity, expected] of cases) {
    test(`${JSON.stringify(identity)} → ${expected}`, () => {
      expect(classifyKiroFailure(identity)).toBe(expected as never);
    });
  }
});

describe('errorIdentityFromMessage', () => {
  test('parses the JSON-RPC data Kiro appends to a run error', () => {
    const message =
      "The model 'x' is not available. (Request ID: 1) (code -32000): {\"errorType\":\"InvalidModelError\",\"retryErrorType\":\"CLIENT_ERROR\",\"requestId\":\"1\"}";
    expect(errorIdentityFromMessage(message)).toEqual({ errorType: 'InvalidModelError', retryErrorType: 'CLIENT_ERROR' });
  });

  test('ignores prose, malformed payloads and non-string fields', () => {
    expect(errorIdentityFromMessage('Session not found')).toEqual({});
    expect(errorIdentityFromMessage('bad (code -32000): {not json}')).toEqual({});
    expect(errorIdentityFromMessage('bad (code -32000): {"errorType":42}')).toEqual({});
    // Keyword-looking prose never classifies: there is no payload.
    expect(errorIdentityFromMessage('ThrottlingException: slow down')).toEqual({});
  });
});
