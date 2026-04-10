/**
 * Pong drafts live in the user's Outlook Drafts folder, not in the portal
 * database. Pong-specific metadata (confidence, reasoning, source docs) is
 * embedded as a visible header at the top of the draft body. The professor
 * sees it when reviewing and strips it before sending.
 *
 * Listing: query inbox for messages categorized "Pong Draft Ready", then
 * match each to the corresponding draft in the Drafts folder by conversationId.
 *
 * State machine is Exchange: draft exists = pending, draft gone = sent or
 * discarded. No local status column.
 */

import type { PrismaClient } from '../../generated/prisma/index.js';
import {
  listInboxMessages,
  listDraftMessages,
  createDraftReply,
  updateDraft,
  sendDraft,
  deleteDraft,
  categorizeMessage,
  flagMessage,
  getMessage,
  type GraphMessage,
} from '../exchange/exchange.js';
import { getPongSettings } from './settings.js';

export const PONG_CATEGORY = 'Pong Draft Ready';

const META_START = '[Pong draft';
const META_END_MARKER = '\n---\n\n';

interface PongMeta {
  confidence: number;
  reasoning: string | null;
  sourceDocs: string[];
}

/** Build the visible meta-block that prepends the draft body. */
export function encodeMetaBlock(meta: PongMeta): string {
  const pct = Math.round(meta.confidence * 100);
  const sources = meta.sourceDocs.length > 0 ? ` · sources: ${meta.sourceDocs.join(', ')}` : '';
  const reasoning = meta.reasoning ? ` · reasoning: ${meta.reasoning.replace(/\s+/g, ' ').trim()}` : '';
  return `${META_START} · confidence ${pct}%${sources}${reasoning}]${META_END_MARKER}`;
}

/** Prepend a meta-block to a reply body. */
export function applyMetaBlock(body: string, meta: PongMeta): string {
  return encodeMetaBlock(meta) + body;
}

/** Parse the meta-block out of a draft body. Returns nulls if none found. */
export function decodeMetaBlock(body: string): { meta: PongMeta | null; bodyWithoutMeta: string } {
  // Strip HTML tags for parsing — Outlook wraps the body in <html><body>...</body></html>.
  const text = body.replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ');
  const start = text.indexOf(META_START);
  if (start === -1) return { meta: null, bodyWithoutMeta: body };
  const endBracket = text.indexOf(']', start);
  if (endBracket === -1) return { meta: null, bodyWithoutMeta: body };

  const block = text.slice(start + META_START.length, endBracket);
  const confidenceMatch = block.match(/confidence\s+(\d+)%/);
  const reasoningMatch = block.match(/reasoning:\s*([^·]+?)(?:$|·)/);
  const sourcesMatch = block.match(/sources:\s*([^·]+?)(?:$|·)/);

  if (!confidenceMatch) return { meta: null, bodyWithoutMeta: body };

  return {
    meta: {
      confidence: parseInt(confidenceMatch[1], 10) / 100,
      reasoning: reasoningMatch?.[1]?.trim() ?? null,
      sourceDocs: sourcesMatch?.[1]?.split(',').map((s) => s.trim()).filter(Boolean) ?? [],
    },
    bodyWithoutMeta: body,
  };
}

async function getRefreshToken(db: PrismaClient, connectionId: string): Promise<string> {
  // Minimal inline version of the resolver's getExchangeRefreshToken helper —
  // imports the decrypt function locally to avoid a cross-module dependency.
  const { createDecipheriv } = await import('crypto');
  const connection = await db.exchangeConnection.findUniqueOrThrow({
    where: { id: connectionId },
    select: { refreshTokenEncrypted: true },
  });
  const keyHex = process.env.HADRON_ENCRYPTION_KEY;
  if (!keyHex) throw new Error('HADRON_ENCRYPTION_KEY env var is required');
  const key = Buffer.from(keyHex, 'hex');
  const buf = Buffer.from(connection.refreshTokenEncrypted, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export interface PongDraftRecord {
  id: string;                    // outlook draft id
  exchangeConnectionId: string;
  userId: string;
  messageId: string;             // original inbox message id
  messageSubject: string | null;
  messageFrom: string | null;
  messageReceivedAt: string | null;
  draftBody: string;
  editedBody: string | null;
  confidence: number;
  status: 'PENDING';             // always PENDING — drafts only exist while pending
  sourceDocs: string[];
  reasoning: string | null;
  outlookDraftId: string;
  sentAt: null;
  createdAt: string;
  updatedAt: string;
}

function messageFromAddress(msg: GraphMessage): string | null {
  return msg.from?.emailAddress?.address ?? null;
}

/**
 * Create a new Pong draft for an inbox message. Writes nothing to the DB.
 * Creates an Outlook draft with the meta-block embedded, categorizes the
 * original message, optionally auto-sends if confidence ≥ threshold.
 */
export async function createPongDraft(
  db: PrismaClient,
  args: {
    connectionId: string;
    userId: string;
    messageId: string;
    messageSubject: string | null;
    messageFrom: string | null;
    draftBody: string;
    confidence: number;
    reasoning: string | null;
    sourceDocs: string[];
  },
): Promise<PongDraftRecord> {
  const refreshToken = await getRefreshToken(db, args.connectionId);

  const bodyWithMeta = applyMetaBlock(args.draftBody, {
    confidence: args.confidence,
    reasoning: args.reasoning,
    sourceDocs: args.sourceDocs,
  });

  // Create the Outlook draft
  const { data: outlookDraft } = await createDraftReply(refreshToken, args.messageId, bodyWithMeta);

  // Categorize and flag the original message
  await categorizeMessage(refreshToken, args.messageId, [PONG_CATEGORY]).catch(() => {});
  await flagMessage(refreshToken, args.messageId, 'flagged').catch(() => {});

  // Auto-send check
  const settings = await getPongSettings(db, args.connectionId).catch(() => null);
  const shouldAutoSend =
    settings?.autoSendEnabled && args.confidence >= (settings.confidenceThreshold ?? 0.95);

  if (shouldAutoSend && outlookDraft.id) {
    await sendDraft(refreshToken, outlookDraft.id);
    await categorizeMessage(refreshToken, args.messageId, []).catch(() => {});
    await flagMessage(refreshToken, args.messageId, 'complete').catch(() => {});
  }

  const nowIso = new Date().toISOString();
  return {
    id: outlookDraft.id ?? '',
    exchangeConnectionId: args.connectionId,
    userId: args.userId,
    messageId: args.messageId,
    messageSubject: args.messageSubject,
    messageFrom: args.messageFrom,
    messageReceivedAt: null,
    draftBody: args.draftBody,
    editedBody: null,
    confidence: args.confidence,
    status: 'PENDING',
    sourceDocs: args.sourceDocs,
    reasoning: args.reasoning,
    outlookDraftId: outlookDraft.id ?? '',
    sentAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
}

/**
 * List all Pong drafts currently in the user's Drafts folder. Works by
 * listing inbox messages with the Pong category, then matching each to its
 * draft reply in the Drafts folder via conversationId.
 */
export async function listPongDrafts(
  db: PrismaClient,
  connectionId: string,
  limit = 50,
): Promise<PongDraftRecord[]> {
  const refreshToken = await getRefreshToken(db, connectionId);
  const connection = await db.exchangeConnection.findUniqueOrThrow({
    where: { id: connectionId },
    select: { userId: true },
  });

  const [categorizedResult, draftsResult] = await Promise.all([
    listInboxMessages(refreshToken, {
      top: limit,
      filter: `categories/any(c: c eq '${PONG_CATEGORY}')`,
    }).catch(() => ({ data: [] as GraphMessage[] })),
    listDraftMessages(refreshToken, { top: Math.max(limit * 2, 100) }).catch(() => ({ data: [] as GraphMessage[] })),
  ]);

  const draftsByConversation = new Map<string, GraphMessage>();
  for (const draft of draftsResult.data) {
    if (draft.conversationId) {
      const existing = draftsByConversation.get(draft.conversationId);
      if (!existing || new Date(draft.receivedDateTime) > new Date(existing.receivedDateTime)) {
        draftsByConversation.set(draft.conversationId, draft);
      }
    }
  }

  const results: PongDraftRecord[] = [];
  for (const msg of categorizedResult.data) {
    if (!msg.conversationId) continue;
    const draft = draftsByConversation.get(msg.conversationId);
    if (!draft) continue;

    const bodyRaw = draft.body?.content ?? '';
    const { meta } = decodeMetaBlock(bodyRaw);

    results.push({
      id: draft.id,
      exchangeConnectionId: connectionId,
      userId: connection.userId,
      messageId: msg.id,
      messageSubject: msg.subject ?? null,
      messageFrom: messageFromAddress(msg),
      messageReceivedAt: msg.receivedDateTime,
      draftBody: bodyRaw,
      editedBody: null,
      confidence: meta?.confidence ?? 0,
      status: 'PENDING',
      sourceDocs: meta?.sourceDocs ?? [],
      reasoning: meta?.reasoning ?? null,
      outlookDraftId: draft.id,
      sentAt: null,
      createdAt: draft.receivedDateTime,
      updatedAt: draft.receivedDateTime,
    });
  }

  return results;
}

/**
 * Read a single Pong draft by its Outlook draft id.
 */
export async function readPongDraft(
  db: PrismaClient,
  connectionId: string,
  outlookDraftId: string,
): Promise<PongDraftRecord | null> {
  const refreshToken = await getRefreshToken(db, connectionId);
  const connection = await db.exchangeConnection.findUniqueOrThrow({
    where: { id: connectionId },
    select: { userId: true },
  });

  const { data: draft } = await getMessage(refreshToken, outlookDraftId).catch(() => ({ data: null as GraphMessage | null }));
  if (!draft) return null;

  // Try to resolve the original inbound message via conversationId
  let originalMessage: GraphMessage | null = null;
  if (draft.conversationId) {
    const { data: inboxMatches } = await listInboxMessages(refreshToken, {
      top: 1,
      filter: `conversationId eq '${draft.conversationId}'`,
    }).catch(() => ({ data: [] as GraphMessage[] }));
    originalMessage = inboxMatches[0] ?? null;
  }

  const bodyRaw = draft.body?.content ?? '';
  const { meta } = decodeMetaBlock(bodyRaw);

  return {
    id: draft.id,
    exchangeConnectionId: connectionId,
    userId: connection.userId,
    messageId: originalMessage?.id ?? '',
    messageSubject: originalMessage?.subject ?? null,
    messageFrom: originalMessage ? messageFromAddress(originalMessage) : null,
    messageReceivedAt: originalMessage?.receivedDateTime ?? null,
    draftBody: bodyRaw,
    editedBody: null,
    confidence: meta?.confidence ?? 0,
    status: 'PENDING',
    sourceDocs: meta?.sourceDocs ?? [],
    reasoning: meta?.reasoning ?? null,
    outlookDraftId: draft.id,
    sentAt: null,
    createdAt: draft.receivedDateTime,
    updatedAt: draft.receivedDateTime,
  };
}

/**
 * Edit the body of an existing Pong draft (no send). The new body replaces
 * the draft content in Outlook. The professor can keep iterating.
 */
export async function editPongDraft(
  db: PrismaClient,
  connectionId: string,
  outlookDraftId: string,
  newBody: string,
): Promise<void> {
  const refreshToken = await getRefreshToken(db, connectionId);
  await updateDraft(refreshToken, outlookDraftId, newBody);
}

/**
 * Approve (send) a Pong draft. If editedBody is provided, the draft body is
 * updated first. The category and flag on the original message are cleared.
 */
export async function approvePongDraft(
  db: PrismaClient,
  connectionId: string,
  outlookDraftId: string,
  editedBody: string | null,
): Promise<void> {
  const refreshToken = await getRefreshToken(db, connectionId);

  // Find the original message via the draft's conversationId so we can clear
  // its category/flag after send.
  const { data: draft } = await getMessage(refreshToken, outlookDraftId).catch(() => ({ data: null as GraphMessage | null }));

  if (editedBody !== null) {
    await updateDraft(refreshToken, outlookDraftId, editedBody);
  }

  await sendDraft(refreshToken, outlookDraftId);

  if (draft?.conversationId) {
    const { data: inboxMatches } = await listInboxMessages(refreshToken, {
      top: 1,
      filter: `conversationId eq '${draft.conversationId}'`,
    }).catch(() => ({ data: [] as GraphMessage[] }));
    const original = inboxMatches[0];
    if (original) {
      await categorizeMessage(refreshToken, original.id, []).catch(() => {});
      await flagMessage(refreshToken, original.id, 'complete').catch(() => {});
    }
  }
}

/**
 * Reject a Pong draft. Deletes it from the Drafts folder and clears the
 * category/flag on the original message.
 */
export async function rejectPongDraft(
  db: PrismaClient,
  connectionId: string,
  outlookDraftId: string,
): Promise<void> {
  const refreshToken = await getRefreshToken(db, connectionId);

  const { data: draft } = await getMessage(refreshToken, outlookDraftId).catch(() => ({ data: null as GraphMessage | null }));

  if (draft?.conversationId) {
    const { data: inboxMatches } = await listInboxMessages(refreshToken, {
      top: 1,
      filter: `conversationId eq '${draft.conversationId}'`,
    }).catch(() => ({ data: [] as GraphMessage[] }));
    const original = inboxMatches[0];
    if (original) {
      await categorizeMessage(refreshToken, original.id, []).catch(() => {});
      await flagMessage(refreshToken, original.id, 'notFlagged').catch(() => {});
    }
  }

  await deleteDraft(refreshToken, outlookDraftId);
}

/**
 * Count current Pong drafts in the Drafts folder. Used by pongStatus.
 * Historical counts (sent, edited, rejected) are not tracked without a DB.
 */
export async function countCurrentPongDrafts(
  db: PrismaClient,
  connectionId: string,
): Promise<number> {
  const refreshToken = await getRefreshToken(db, connectionId);
  const { data } = await listInboxMessages(refreshToken, {
    top: 100,
    filter: `categories/any(c: c eq '${PONG_CATEGORY}')`,
  }).catch(() => ({ data: [] as GraphMessage[] }));
  return data.length;
}
