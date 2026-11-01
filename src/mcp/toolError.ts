import { RateLimited } from '../lib/rateLimit/index.js';
import { isPrismaClientError } from '../lib/prismaErrors.js';
import { isTrustedRefusal } from '../api/graphql/formatError.js';
import { faultRequestId, internalFaultEnvelope, internalFaultText, logInternalFault } from '../lib/internalFault.js';
import { textResult } from './textResult.js';

// Backstop for wrappers that copied the diagnostic and discarded its class.
// Use distinctive ORM signatures, not broad words like "query" or "database",
// so ordinary authoring and permission refusals retain their remedy text.
const DATABASE_DIAGNOSTIC = /\b(?:PrismaClient\w*Error|DriverAdapterError|ConnectorError|PostgresError)\b|\bprisma\.[\w$]+\.[\w$]+|\bInvalid\s+`[^`]+`\s+invocation\b/i;

/** Wrappers must not turn an ORM fault into caller-visible domain prose. */
function containsDatabaseDiagnostic(error: unknown): boolean {
  const seen = new Set<unknown>();
  const pending = [error];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (DATABASE_DIAGNOSTIC.test(current)) return true;
      continue;
    }
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    try {
      if (isPrismaClientError(current)) return true;
      const wrapped = current as { name?: unknown; message?: unknown; originalError?: unknown; cause?: unknown; errors?: unknown };
      if ([wrapped.name, wrapped.message].some((value) => typeof value === 'string' && DATABASE_DIAGNOSTIC.test(value))) return true;
      pending.push(wrapped.originalError, wrapped.cause);
      if (Array.isArray(wrapped.errors)) pending.push(...wrapped.errors);
    } catch {
      // An uninspectable thrown object is not a trusted domain refusal.
      return true;
    }
  }
  return false;
}

/** A refusal is a tool failure, not a success that happens to say "no": isError is set on every one (#1789). */
export function refusalResult(text: string) {
  return { isError: true as const, ...textResult(text) };
}

/**
 * The generic internal-fault result (#1789, cor:api:260:01): fixed code and message plus the request id, as structured
 * data a client reads and as text for one that cannot. The complete exception goes to the log under that id.
 */
export function toolFaultResult(error: unknown, site: string) {
  const requestId = faultRequestId();
  logInternalFault('mcp', site, requestId, error);
  return {
    isError: true as const,
    ...textResult(internalFaultText(requestId)),
    structuredContent: { error: internalFaultEnvelope(requestId) },
  };
}

/** #1793: same structured error carrier as faults, with only caller-safe rate metadata. */
function rateLimitedResult(error: RateLimited) {
  return { isError: true as const, ...textResult(error.message), structuredContent: { error: {
    code: 'RATE_LIMITED' as const, message: error.message, retryAfterSeconds: error.extensions.retryAfterSeconds,
    fieldClass: error.extensions.fieldClass,
  } } };
}

/**
 * The MCP fallback boundary (#1695, #1789). Classify before reading a message/code: a Prisma error may contain
 * arguments, paths and internal ids. A typed domain refusal keeps its wording (and is flagged isError); everything else,
 * including a plain Error however familiar its text, is a fault and returns only the generic envelope.
 */
export function toolErrorResult(
  error: unknown,
  domainText: () => string,
  site = 'mcp_tool',
): ReturnType<typeof refusalResult> | ReturnType<typeof toolFaultResult> | ReturnType<typeof rateLimitedResult> {
  if (error instanceof RateLimited) return rateLimitedResult(error);
  if (containsDatabaseDiagnostic(error) || !isTrustedRefusal(error)) return toolFaultResult(error, site);
  return refusalResult(domainText());
}

/** Catch before the SDK serializes an uncaught tool exception's raw message. */
export function withToolErrorBoundary(
  name: string,
  callback: (args: unknown, extra: unknown) => unknown,
) {
  return async (args: unknown, extra: unknown) => {
    try {
      return await callback(args, extra);
    } catch (error) {
      if (error instanceof RateLimited) return rateLimitedResult(error);
      // A typed refusal retains the SDK's existing error handling; any other throw is a fault.
      if (!containsDatabaseDiagnostic(error) && isTrustedRefusal(error)) throw error;
      return toolFaultResult(error, `${name}:handler`);
    }
  };
}
