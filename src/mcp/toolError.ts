import { isPrismaClientError, REDACTED_DB_ERROR_MESSAGE } from '../lib/prismaErrors.js';
import { mcpLog } from './mcp-log.js';

/** Wrappers must not turn an ORM fault into caller-visible domain prose. */
function containsPrismaError(error: unknown): boolean {
  const seen = new Set<unknown>();
  const pending = [error];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    if (isPrismaClientError(current)) return true;
    const wrapped = current as { originalError?: unknown; cause?: unknown };
    pending.push(wrapped.originalError, wrapped.cause);
  }
  return false;
}

/**
 * The MCP fallback boundary (#1695). Classify before reading a message/code:
 * a Prisma error may contain arguments, paths and internal ids. The complete
 * exception stays in operator logs; only the fixed text leaves this boundary.
 * Existing domain refusals retain their wording and result shape.
 */
export function toolErrorResult(error: unknown, domainText: () => string) {
  if (containsPrismaError(error)) {
    mcpLog('error', 'tool_database_error', { error });
    return {
      isError: true as const,
      content: [{ type: 'text' as const, text: `[internal_server_error] ${REDACTED_DB_ERROR_MESSAGE}` }],
    };
  }
  return { content: [{ type: 'text' as const, text: domainText() }] };
}
