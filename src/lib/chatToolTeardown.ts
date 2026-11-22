/**
 * #4828 (#597 follow-up; hrn:node:hadronmemory.com:specs:cor:dmo:080:04, "no tool connection is ever left that no live row
 * points to"): the ONE teardown path for the chat tool registrations (Telegram and Slack) of an App or an organization that is
 * being deleted.
 *
 * Two steps, split on purpose. {@link softDeleteChatToolConnections} runs INSIDE the deleting transaction: it soft-deletes every
 * LIVE row in scope with one guarded statement (`WHERE deleted_at IS NULL ... RETURNING`), so a row already deleted is neither
 * touched nor returned (never asked of the tool twice), and no live row survives the commit. {@link dispatchChatToolTeardown}
 * runs AFTER the commit, once per returned connection: authorization has already been judged, and a rolled-back delete asks the
 * tool nothing. The tool calls keep the disconnect doors' contract (best-effort, never throw, a failure is logged): the rows keep
 * their tool connection id once soft-deleted, but nothing retries an unreachable tool today (a durable retry is its own issue).
 */
import type { Prisma } from '../generated/prisma/index.js';
import { deleteSlackToolConnection } from './slackClient.js';
import { deleteTelegramToolConnection } from './telegramClient.js';

export interface ChatToolTeardown { kind: 'slack' | 'telegram'; provider: string; toolConnectionId: string }
/** An organization (every connection it holds) or an App (its Telegram bot, and the Slack workspaces it is the default App of). */
export type ChatToolScope = { organizationId: string } | { appId: string };

export async function softDeleteChatToolConnections(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  scope: ChatToolScope,
  deletedBy: string | null,
): Promise<ChatToolTeardown[]> {
  const telegram = 'organizationId' in scope
    ? await tx.$queryRaw<Array<{ provider: string; tool_connection_id: string }>>`
        UPDATE telegram_connections SET deleted_at = (clock_timestamp() AT TIME ZONE 'UTC'), deleted_by = ${deletedBy}
        WHERE organization_id = ${scope.organizationId} AND deleted_at IS NULL RETURNING provider, tool_connection_id`
    : await tx.$queryRaw<Array<{ provider: string; tool_connection_id: string }>>`
        UPDATE telegram_connections SET deleted_at = (clock_timestamp() AT TIME ZONE 'UTC'), deleted_by = ${deletedBy}
        WHERE app_id = ${scope.appId} AND deleted_at IS NULL RETURNING provider, tool_connection_id`;
  const slack = 'organizationId' in scope
    ? await tx.$queryRaw<Array<{ provider: string; tool_connection_id: string }>>`
        UPDATE slack_connections SET deleted_at = (clock_timestamp() AT TIME ZONE 'UTC'), deleted_by = ${deletedBy}
        WHERE organization_id = ${scope.organizationId} AND deleted_at IS NULL RETURNING provider, tool_connection_id`
    : await tx.$queryRaw<Array<{ provider: string; tool_connection_id: string }>>`
        UPDATE slack_connections SET deleted_at = (clock_timestamp() AT TIME ZONE 'UTC'), deleted_by = ${deletedBy}
        WHERE default_app_id = ${scope.appId} AND deleted_at IS NULL RETURNING provider, tool_connection_id`;
  return [
    ...telegram.map((r) => ({ kind: 'telegram' as const, provider: r.provider, toolConnectionId: r.tool_connection_id })),
    ...slack.map((r) => ({ kind: 'slack' as const, provider: r.provider, toolConnectionId: r.tool_connection_id })),
  ];
}

/** After the commit: ask each tool to drop its side. Fire-and-forget; one tool failing never stops another and never fails the delete. */
export function dispatchChatToolTeardown(teardowns: readonly ChatToolTeardown[]): void {
  for (const t of teardowns) {
    const call = t.kind === 'slack' ? deleteSlackToolConnection : deleteTelegramToolConnection;
    void Promise.resolve().then(() => call(t.provider, t.toolConnectionId)).catch((error: unknown) => {
      console.error(`[chatToolTeardown] ${t.kind} tool disconnect failed for ${t.provider}/${t.toolConnectionId}:`, error);
    });
  }
}
