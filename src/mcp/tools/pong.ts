/**
 * Pong MCP tools — expose Pong email-automation controls via MCP so any LLM
 * host (Claude Code, Cursor, Copilot, etc.) can configure, monitor, and
 * review Pong.
 *
 * The MCP is purely a control panel. It never triggers draft generation —
 * the webhook handler is and remains the only path into processIncomingEmail.
 *
 * All tools are kebab-case with a `pong-` prefix.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { db } from '../../integrations/db/client.js';
import type { AuthContext } from '../../middleware/auth.js';
import {
  getPongSettings,
  upsertPongSettings,
  pausePong,
  resumePong,
} from '../../integrations/pong/settings.js';
import {
  listPongKnowledge,
  addPongKnowledge,
  deletePongKnowledge,
} from '../../integrations/pong/knowledge.js';
import {
  listPongDrafts,
  readPongDraft,
  decodeMetaBlock,
  getRefreshToken,
  approvePongDraft,
  editPongDraft,
  rejectPongDraft,
  type PongDraftRecord,
} from '../../integrations/pong/drafts.js';
import { listInboxMessages, type GraphMessage } from '../../integrations/exchange/client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return textResult(`Error: ${msg}`);
}

/**
 * Verify that the authenticated user owns the given ExchangeConnection.
 * Throws a descriptive error if the connection doesn't exist, is deleted,
 * or belongs to a different user. Only JWT-authenticated users (with
 * auth.userId) are allowed — station API keys are rejected.
 */
async function assertOwnsConnection(
  auth: AuthContext,
  connectionId: string,
): Promise<{
  id: string;
  userId: string;
  mailboxEmail: string;
  pongStationId: string | null;
  syncStatus: string;
  lastSyncAt: Date | null;
}> {
  if (!auth.userId) {
    throw new Error(
      'Pong tools require a user JWT. Station API keys are not supported.',
    );
  }

  const conn = await db.exchangeConnection.findUnique({
    where: { id: connectionId },
    select: {
      id: true,
      userId: true,
      mailboxEmail: true,
      pongStationId: true,
      syncStatus: true,
      lastSyncAt: true,
      deletedAt: true,
    },
  });

  if (!conn || conn.deletedAt) {
    throw new Error(
      `Exchange connection "${connectionId}" not found. Use pong-check-connection to list your connections.`,
    );
  }

  if (conn.userId !== auth.userId) {
    // Intentionally vague to avoid leaking existence of other users' connections
    throw new Error(
      `Exchange connection "${connectionId}" not found. Use pong-check-connection to list your connections.`,
    );
  }

  return {
    id: conn.id,
    userId: conn.userId,
    mailboxEmail: conn.mailboxEmail,
    pongStationId: conn.pongStationId,
    syncStatus: conn.syncStatus,
    lastSyncAt: conn.lastSyncAt,
  };
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatDraftSummary(d: PongDraftRecord): string {
  const pct = Math.round(d.confidence * 100);
  const from = d.messageFrom ?? 'unknown';
  const subj = d.messageSubject ?? '(no subject)';
  const date = d.messageReceivedAt
    ? new Date(d.messageReceivedAt).toISOString().slice(0, 16).replace('T', ' ')
    : '?';
  return `- **${d.outlookDraftId}** — from ${from}, "${subj}" (${date}) · confidence ${pct}%`;
}

function formatDraftFull(d: PongDraftRecord): string {
  const pct = Math.round(d.confidence * 100);
  const { bodyWithoutMeta } = decodeMetaBlock(d.draftBody);
  const sources = d.sourceDocs.length > 0 ? `\n**Sources:** ${d.sourceDocs.join(', ')}` : '';
  const reasoning = d.reasoning ? `\n**Reasoning:** ${d.reasoning}` : '';
  return [
    `**Draft:** ${d.outlookDraftId}`,
    `**Status:** ${d.status}`,
    `**Confidence:** ${pct}%`,
    `**From:** ${d.messageFrom ?? 'unknown'}`,
    `**Subject:** ${d.messageSubject ?? '(no subject)'}`,
    `**Received:** ${d.messageReceivedAt ?? '?'}`,
    sources,
    reasoning,
    '',
    '---',
    '',
    bodyWithoutMeta,
  ].join('\n');
}

function formatMessage(m: GraphMessage): string {
  const from = m.from?.emailAddress?.address ?? 'unknown';
  const name = m.from?.emailAddress?.name ?? '';
  const date = new Date(m.receivedDateTime).toISOString().slice(0, 16).replace('T', ' ');
  const read = m.isRead ? '' : ' [UNREAD]';
  const preview = m.bodyPreview?.slice(0, 120) ?? '';
  return `- **${m.id}** — ${from}${name ? ` (${name})` : ''}, "${m.subject ?? '(no subject)'}" (${date})${read}\n  ${preview}`;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

/**
 * Register all Pong MCP tools on the given server instance.
 * Called once per session from createMcpServerInstance.
 */
export function registerPongTools(server: McpServer, auth: AuthContext): void {
  // ── pong-check-connection ───────────────────────────────────────────────

  server.tool(
    'pong-check-connection',
    'List the authenticated user\'s Exchange connections (IDs, mailbox email, sync status). Use this first to find the connectionId needed by other Pong tools.',
    {},
    async () => {
      if (!auth.userId) {
        return textResult('Pong tools require a user JWT. Station API keys are not supported.');
      }

      const connections = await db.exchangeConnection.findMany({
        where: { userId: auth.userId, deletedAt: null },
        select: {
          id: true,
          mailboxEmail: true,
          displayName: true,
          syncStatus: true,
          lastSyncAt: true,
          pongStationId: true,
        },
        orderBy: { createdAt: 'asc' },
      });

      if (connections.length === 0) {
        return textResult(
          'No Exchange connections found. Connect a mailbox in the Hadron portal first.',
        );
      }

      const lines = connections.map((c) => {
        const name = c.displayName ? ` (${c.displayName})` : '';
        const pong = c.pongStationId ? ' · Pong linked' : ' · Pong not linked';
        const sync = c.lastSyncAt
          ? `synced ${c.lastSyncAt.toISOString()}`
          : `sync ${c.syncStatus.toLowerCase()}`;
        return `- **${c.id}** — ${c.mailboxEmail}${name} · ${sync}${pong}`;
      });

      return textResult(
        `${connections.length} Exchange connection(s):\n\n${lines.join('\n')}`,
      );
    },
  );

  // ── pong-get-settings ─────────────────────────────────────────────────

  server.tool(
    'pong-get-settings',
    'Read the current Pong settings for an Exchange connection (autoreply on/off, confidence threshold, reply tone, signature, pause status, exclusion rules).',
    {
      connectionId: z.string().describe('Exchange connection ID (from pong-check-connection)'),
    },
    async ({ connectionId }) => {
      try {
        await assertOwnsConnection(auth, connectionId);
        const settings = await getPongSettings(db, connectionId);
        if (!settings) return textResult('No settings found for this connection.');

        const paused = settings.pausedUntil
          ? `Paused until ${settings.pausedUntil.toISOString()}`
          : 'Not paused';
        const exclusions = settings.exclusionRules.length > 0
          ? settings.exclusionRules.map((r, i) => {
              const parts: string[] = [];
              if (r.senderPattern) parts.push(`sender: ${r.senderPattern}`);
              if (r.subjectPattern) parts.push(`subject: ${r.subjectPattern}`);
              if (r.reason) parts.push(`reason: ${r.reason}`);
              return `  ${i + 1}. ${parts.join(', ')}`;
            }).join('\n')
          : '  (none)';

        return textResult([
          `**Pong Settings** for connection ${connectionId}`,
          '',
          `**Auto-send:** ${settings.autoSendEnabled ? 'ON' : 'OFF'}`,
          `**Confidence threshold:** ${Math.round(settings.confidenceThreshold * 100)}%`,
          `**Reply tone:** ${settings.replyTone ?? '(default)'}`,
          `**Signature:** ${settings.signatureText ?? '(none)'}`,
          `**Allow MCP send:** ${settings.allowMcpSend ? 'ON' : 'OFF'}`,
          `**Status:** ${paused}`,
          `**Station:** ${settings.stationId ?? 'not linked'}`,
          `**Exclusion rules:**`,
          exclusions,
        ].join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── pong-list-knowledge ───────────────────────────────────────────────

  server.tool(
    'pong-list-knowledge',
    'List knowledge documents for a Pong connection (metadata only: id, title, docType, dates). Use pong-get-knowledge to read the full content of a specific doc.',
    {
      connectionId: z.string().describe('Exchange connection ID'),
    },
    async ({ connectionId }) => {
      try {
        await assertOwnsConnection(auth, connectionId);
        const docs = await listPongKnowledge(db, connectionId);

        if (docs.length === 0) {
          return textResult('No knowledge documents found. Add some with pong-add-knowledge.');
        }

        const lines = docs.map((d) => {
          const docType = d.docType ? ` [${d.docType}]` : '';
          const date = d.updatedAt.toISOString().slice(0, 10);
          return `- **${d.id}** — ${d.title}${docType} (updated ${date})`;
        });

        return textResult(
          `${docs.length} knowledge document(s):\n\n${lines.join('\n')}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── pong-get-knowledge ────────────────────────────────────────────────

  server.tool(
    'pong-get-knowledge',
    'Read the full content of a single Pong knowledge document.',
    {
      connectionId: z.string().describe('Exchange connection ID'),
      knowledgeId: z.string().describe('Knowledge doc ID (from pong-list-knowledge)'),
    },
    async ({ connectionId, knowledgeId }) => {
      try {
        await assertOwnsConnection(auth, connectionId);
        const docs = await listPongKnowledge(db, connectionId);
        const doc = docs.find((d) => d.id === knowledgeId);

        if (!doc) {
          return textResult(
            `Knowledge document "${knowledgeId}" not found. Use pong-list-knowledge to see available docs.`,
          );
        }

        return textResult([
          `**${doc.title}**`,
          doc.docType ? `Type: ${doc.docType}` : '',
          `Updated: ${doc.updatedAt.toISOString()}`,
          '',
          '---',
          '',
          doc.content,
        ].filter(Boolean).join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── pong-list-drafts ──────────────────────────────────────────────────

  server.tool(
    'pong-list-drafts',
    'List Pong drafts currently in the Outlook Drafts folder (pending review). Shows draft ID, sender, subject, confidence score.',
    {
      connectionId: z.string().describe('Exchange connection ID'),
      limit: z.number().optional().default(25).describe('Max number of drafts to return (default 25)'),
    },
    async ({ connectionId, limit }) => {
      try {
        await assertOwnsConnection(auth, connectionId);
        const drafts = await listPongDrafts(db, connectionId, limit);

        if (drafts.length === 0) {
          return textResult('No pending Pong drafts found.');
        }

        const lines = drafts.map(formatDraftSummary);
        return textResult(
          `${drafts.length} pending draft(s):\n\n${lines.join('\n')}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── pong-get-draft ────────────────────────────────────────────────────

  server.tool(
    'pong-get-draft',
    'Read a single Pong draft in full — includes the draft body, confidence score, reasoning, and source documents.',
    {
      connectionId: z.string().describe('Exchange connection ID'),
      draftId: z.string().describe('Outlook draft ID (from pong-list-drafts)'),
    },
    async ({ connectionId, draftId }) => {
      try {
        await assertOwnsConnection(auth, connectionId);
        const draft = await readPongDraft(db, connectionId, draftId);

        if (!draft) {
          return textResult(
            `Draft "${draftId}" not found. It may have been sent or deleted. Use pong-list-drafts to see current drafts.`,
          );
        }

        return textResult(formatDraftFull(draft));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── pong-read-inbox ───────────────────────────────────────────────────

  server.tool(
    'pong-read-inbox',
    'List recent messages from the Exchange inbox. Shows sender, subject, date, and a preview. Useful for seeing what emails Pong has been processing.',
    {
      connectionId: z.string().describe('Exchange connection ID'),
      limit: z.number().optional().default(15).describe('Max number of messages (default 15)'),
    },
    async ({ connectionId, limit }) => {
      try {
        await assertOwnsConnection(auth, connectionId);
        const refreshToken = await getRefreshToken(db, connectionId);
        const { data: messages } = await listInboxMessages(refreshToken, {
          top: limit,
        });

        if (messages.length === 0) {
          return textResult('Inbox is empty.');
        }

        const lines = messages.map(formatMessage);
        return textResult(
          `${messages.length} recent inbox message(s):\n\n${lines.join('\n\n')}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── pong-update-settings ───────────────────────────────────────────────

  server.tool(
    'pong-update-settings',
    'Update Pong settings for an Exchange connection. All fields are optional — only the fields you provide will be changed.',
    {
      connectionId: z.string().describe('Exchange connection ID'),
      autoSendEnabled: z.boolean().optional().describe('Enable/disable automatic sending of high-confidence drafts'),
      confidenceThreshold: z.number().min(0).max(1).optional().describe('Minimum confidence (0–1) for auto-send, e.g. 0.92'),
      replyTone: z.string().optional().nullable().describe('Reply tone instruction, e.g. "professional", "friendly". Null to clear'),
      signatureText: z.string().optional().nullable().describe('Email signature text. Null to clear'),
      allowMcpSend: z.boolean().optional().describe('Allow LLM hosts to send approved drafts via pong-send-draft. Default false'),
    },
    async ({ connectionId, autoSendEnabled, confidenceThreshold, replyTone, signatureText, allowMcpSend }) => {
      try {
        await assertOwnsConnection(auth, connectionId);

        const updated = await upsertPongSettings(db, connectionId, {
          autoSendEnabled,
          confidenceThreshold,
          replyTone,
          signatureText,
          allowMcpSend,
        }, auth.userId ?? null);

        const pct = Math.round(updated.confidenceThreshold * 100);
        return textResult([
          'Settings updated:',
          '',
          `**Auto-send:** ${updated.autoSendEnabled ? 'ON' : 'OFF'}`,
          `**Confidence threshold:** ${pct}%`,
          `**Reply tone:** ${updated.replyTone ?? '(default)'}`,
          `**Signature:** ${updated.signatureText ?? '(none)'}`,
          `**Allow MCP send:** ${updated.allowMcpSend ? 'ON' : 'OFF'}`,
        ].join('\n'));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── pong-pause-autoreply ──────────────────────────────────────────────

  server.tool(
    'pong-pause-autoreply',
    'Pause Pong autoreply until a given date (ISO 8601), or indefinitely if no date is provided. Pong will still generate drafts but won\'t auto-send.',
    {
      connectionId: z.string().describe('Exchange connection ID'),
      until: z.string().optional().nullable().describe('ISO 8601 date to resume, e.g. "2026-04-20T00:00:00Z". Omit for indefinite pause'),
    },
    async ({ connectionId, until }) => {
      try {
        await assertOwnsConnection(auth, connectionId);
        const updated = await pausePong(db, connectionId, until ?? null, auth.userId ?? null);
        const msg = updated.pausedUntil
          ? `Pong paused until ${updated.pausedUntil.toISOString()}.`
          : 'Pong paused indefinitely.';
        return textResult(msg);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── pong-resume-autoreply ─────────────────────────────────────────────

  server.tool(
    'pong-resume-autoreply',
    'Resume Pong autoreply (clear any pause). Pong will auto-send drafts again if autoSendEnabled is on.',
    {
      connectionId: z.string().describe('Exchange connection ID'),
    },
    async ({ connectionId }) => {
      try {
        await assertOwnsConnection(auth, connectionId);
        await resumePong(db, connectionId, auth.userId ?? null);
        return textResult('Pong resumed. Autoreply is active again.');
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── pong-add-knowledge ────────────────────────────────────────────────

  server.tool(
    'pong-add-knowledge',
    'Add a knowledge document that Pong uses to draft replies. Provide a title, content, and optional docType (e.g. "syllabus", "policy", "faq").',
    {
      connectionId: z.string().describe('Exchange connection ID'),
      title: z.string().describe('Document title'),
      content: z.string().describe('Document content (plain text or markdown)'),
      docType: z.string().optional().nullable().describe('Document type tag, e.g. "syllabus", "policy", "faq"'),
    },
    async ({ connectionId, title, content, docType }) => {
      try {
        await assertOwnsConnection(auth, connectionId);
        const doc = await addPongKnowledge(db, {
          connectionId,
          title,
          content,
          docType,
          createdBy: auth.userId ?? null,
        });
        return textResult(
          `Knowledge document added:\n\n- **${doc.id}** — ${doc.title}${doc.docType ? ` [${doc.docType}]` : ''}`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── pong-remove-knowledge ─────────────────────────────────────────────

  server.tool(
    'pong-remove-knowledge',
    'Remove a knowledge document from Pong. The document is deleted and will no longer be used when drafting replies.',
    {
      connectionId: z.string().describe('Exchange connection ID'),
      knowledgeId: z.string().describe('Knowledge doc ID (from pong-list-knowledge)'),
    },
    async ({ connectionId, knowledgeId }) => {
      try {
        await assertOwnsConnection(auth, connectionId);
        const deleted = await deletePongKnowledge(db, {
          connectionId,
          id: knowledgeId,
        });
        if (!deleted) {
          return textResult(
            `Knowledge document "${knowledgeId}" not found. Use pong-list-knowledge to see available docs.`,
          );
        }
        return textResult(`Knowledge document "${knowledgeId}" removed.`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── pong-approve-draft ─────────────────────────────────────────────────

  server.tool(
    'pong-approve-draft',
    'Mark a pending Pong draft as approved. This does NOT send the email — use pong-send-draft after approving if you want to send it.',
    {
      connectionId: z.string().describe('Exchange connection ID'),
      draftId: z.string().describe('Outlook draft ID (from pong-list-drafts)'),
    },
    async ({ connectionId, draftId }) => {
      try {
        await assertOwnsConnection(auth, connectionId);
        // approvePongDraft sends the draft immediately — for "approve only"
        // we just verify it exists. The MCP approve/send split is:
        //   approve = user says "this is good"
        //   send = actually dispatch via Outlook
        // Since Outlook drafts don't have a local status column, approving
        // is a no-op confirmation step in MCP. The real action is send.
        const draft = await readPongDraft(db, connectionId, draftId);
        if (!draft) {
          return textResult(
            `Draft "${draftId}" not found. It may have been sent or deleted.`,
          );
        }
        return textResult(
          `Draft "${draftId}" approved. Use pong-send-draft to send it, or pong-edit-draft to modify it first.`,
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── pong-edit-draft ───────────────────────────────────────────────────

  server.tool(
    'pong-edit-draft',
    'Edit the body of a pending Pong draft. The new body replaces the current draft content in Outlook. Does not send the email.',
    {
      connectionId: z.string().describe('Exchange connection ID'),
      draftId: z.string().describe('Outlook draft ID (from pong-list-drafts)'),
      newBody: z.string().describe('The new draft body (plain text or HTML)'),
    },
    async ({ connectionId, draftId, newBody }) => {
      try {
        await assertOwnsConnection(auth, connectionId);
        await editPongDraft(db, connectionId, draftId, newBody);
        return textResult(`Draft "${draftId}" updated. Use pong-send-draft to send it.`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── pong-reject-draft ─────────────────────────────────────────────────

  server.tool(
    'pong-reject-draft',
    'Reject and delete a Pong draft. The draft is removed from Outlook and the original message\'s Pong category/flag is cleared.',
    {
      connectionId: z.string().describe('Exchange connection ID'),
      draftId: z.string().describe('Outlook draft ID (from pong-list-drafts)'),
    },
    async ({ connectionId, draftId }) => {
      try {
        await assertOwnsConnection(auth, connectionId);
        await rejectPongDraft(db, connectionId, draftId);
        return textResult(`Draft "${draftId}" rejected and deleted.`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── pong-send-draft ───────────────────────────────────────────────────

  server.tool(
    'pong-send-draft',
    'Send an approved Pong draft via Outlook. Requires allowMcpSend to be enabled in Pong settings. Optionally provide an edited body to replace the draft content before sending.',
    {
      connectionId: z.string().describe('Exchange connection ID'),
      draftId: z.string().describe('Outlook draft ID (from pong-list-drafts)'),
      editedBody: z.string().optional().nullable().describe('Optional: replace the draft body before sending'),
    },
    async ({ connectionId, draftId, editedBody }) => {
      try {
        await assertOwnsConnection(auth, connectionId);

        // Check the allowMcpSend gate
        const settings = await getPongSettings(db, connectionId);
        if (!settings?.allowMcpSend) {
          return textResult(
            'Sending via MCP is disabled. Enable it in the Hadron portal under ' +
            'Pong Settings → "Allow LLM hosts to send drafts", or use ' +
            'pong-update-settings with allowMcpSend: true.',
          );
        }

        await approvePongDraft(db, connectionId, draftId, editedBody ?? null);
        return textResult(`Draft "${draftId}" sent successfully.`);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
