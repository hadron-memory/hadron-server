import { Prisma } from '../../generated/prisma/index.js';

// D-2026-08-07-006, Vera/Xan on #1282: only per-turn text is raw chat.
// The loc mechanism is deliberate: both chatbot turn writers allocate a single
// atom immediately below :messages. Roots, the messages container, and abstract
// summaries (even summaries below :messages) remain eligible.
export const RAW_CHAT_TURN_LOC_PATTERN = ':messages:[^:]+$';
const rawTurnLoc = new RegExp(RAW_CHAT_TURN_LOC_PATTERN);
export function isRawChatNode(node: { nodeType: string; loc: string }): boolean {
  return node.nodeType === 'chat-message' || (node.nodeType === 'record' && rawTurnLoc.test(node.loc));
}

/** Same predicate for set-based stampers. Alias is internal, never request input. */
export function embeddingEligibleSql(alias: 'nodes' | 'n' = 'nodes'): Prisma.Sql {
  const type = alias === 'n' ? Prisma.sql`n.node_type` : Prisma.sql`nodes.node_type`;
  const loc = alias === 'n' ? Prisma.sql`n.loc` : Prisma.sql`nodes.loc`;
  return Prisma.sql`NOT (${type} = 'chat-message' OR (${type} = 'record' AND ${loc} ~ ${RAW_CHAT_TURN_LOC_PATTERN}))`;
}
