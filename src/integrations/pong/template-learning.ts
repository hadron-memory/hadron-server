/**
 * Template learning from professor edits.
 *
 * Disabled in Phase 3 of the Pong-to-memory migration. The previous
 * implementation matched a sent email back to a PongDraft row in Postgres via
 * conversationId, then compared the stored "original AI draft" against the
 * professor's sent version to extract a template. With PongDraft gone, there
 * is no stored original to compare against.
 *
 * To re-enable, stash the original AI draft somewhere retrievable at send
 * time. Options: a transient node in memory keyed by conversationId, or a
 * Graph API extended property on the draft itself that survives the send.
 */

import type { GraphMessage } from '../exchange/exchange.js';

export async function processSentEmail(
  _connectionId: string,
  _sentMessage: GraphMessage,
): Promise<void> {
  // No-op. See module comment.
}
