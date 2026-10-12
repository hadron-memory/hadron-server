import { isPrismaClientError, REDACTED_DB_ERROR_MESSAGE } from '../lib/prismaErrors.js';
import { mcpLog } from './mcp-log.js';
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

/**
 * The MCP fallback boundary (#1695). Classify before reading a message/code:
 * a Prisma error may contain arguments, paths and internal ids. The complete
 * exception stays in operator logs; only the fixed text leaves this boundary.
 * Existing domain refusals retain their wording and result shape.
 */
export function toolErrorResult(
  error: unknown,
  domainText: () => string,
  site = 'mcp_tool',
): ReturnType<typeof textResult> & { isError?: true } {
  if (containsDatabaseDiagnostic(error)) {
    mcpLog('error', 'tool_database_error', { site, error });
    return {
      isError: true as const,
      ...textResult(`[internal_server_error] ${REDACTED_DB_ERROR_MESSAGE}`),
    };
  }
  return textResult(domainText());
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
      // Unrelated domain exceptions retain the SDK's existing error handling.
      return toolErrorResult(error, () => { throw error; }, `${name}:handler`);
    }
  };
}
