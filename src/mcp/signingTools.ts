/**
 * #1632 (cor:dmo:130, S2b-1) — signing on MCP: an agent may REQUEST a
 * signature and read the outcome, never produce one (no tool takes an
 * assertion; a person signs on the server-hosted ceremony page, cor:dmo:130:08).
 * Thin over the GraphQL resolvers, so refusals and authorization match
 * GraphQL exactly.
 */
import { z } from 'zod';
import { signingSurfacePolicy } from '../lib/signing/surface.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PrismaClient } from '../generated/prisma/index.js';
import type { AuthContext } from '../middleware/auth.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';
import { signingFieldResolvers, signingMutations, signingQueries } from '../api/graphql/schema/resolvers.signing.js';
import { commentErrorText } from './commentTools.js';

const textResult = (text: string) => ({ content: [{ type: 'text' as const, text }] });

type RequestRow = Parameters<typeof signingFieldResolvers.SigningRequest.state>[0];

async function renderRequest(row: RequestRow, ctx: Context): Promise<string> {
  const R = signingFieldResolvers.SigningRequest;
  const [nodeUrn, signer, signature] = await Promise.all([
    R.nodeUrn(row, {}, ctx), R.namedSigner(row, {}, ctx), R.signature(row, {}, ctx),
  ]);
  const ended = R.endedAt(row);
  const signerName = signature ? await signingFieldResolvers.NodeSignature.signer(signature, {}, ctx) : null;
  return [
    `Signing request ${row.id}`,
    `State: ${R.state(row).toLowerCase()}${ended ? ` (ended ${ended.toISOString()})` : ''}`,
    `Node: ${nodeUrn ?? row.nodeId} at r${row.revision}`,
    `Signer: ${signer?.urn ?? (row.namedSignerId ? 'a named signer' : 'any writer of the memory')}`,
    `Expires: ${row.expiresAt.toISOString()}`,
    // cor:dmo:130:08: the link only while there is something to open; the person signs there, never the agent.
    R.state(row) === 'OPEN' ? `Ceremony link: ${R.ceremonyUrl(row)}` : '',
    signature
      ? `Signature: ${signature.state.toLowerCase()} by ${signerName?.urn ?? 'a former user'} (r${signature.revision}, ${JSON.stringify(signature.passkeyLabel)}) at ${signature.verifiedAt.toISOString()}`
      : '',
  ].filter(Boolean).join('\n');
}

export function registerSigningTools(server: McpServer, deps: { db: PrismaClient; auth: AuthContext }): void {
  if (!signingSurfacePolicy().signing) return;
  const { db, auth } = deps;
  const ctxOf = (): Context => ({
    db,
    transport: 'mcp',
    clientId: auth.clientId ?? undefined,
    userId: auth.userId ?? undefined,
    appId: auth.appId ?? undefined,
    appKeyId: auth.appKeyId ?? undefined,
    // Riana #1864 P2-1: the presented hdr_user_ key, so the shared authorized
    // transaction re-checks it is still unrevoked at the write.
    apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId,
    sessionId: auth.sessionId ?? undefined,
    roles: auth.roles as Context['roles'],
    organizationId: auth.organizationId ?? undefined,
    impersonation: auth.impersonation,
  });

  server.tool(
    'hadron_request_signature',
    'Ask for a node\'s current content to be signed by a person with a passkey (cor:dmo:130:03). Any reader of the node may ask; agents never sign. The request pins the current revision and ends exactly once: completed, declined, expired, stale (the title, abstract or content changed) or withdrawn. Read the outcome with hadron_get_signing_request; a node read\'s "Signatures:" line shows signatures. The result carries the ceremony link: hand it to the person who should sign, copied verbatim, never composed. Refused on encrypted memories and comment nodes.',
    SHAPE_HADRON_REQUEST_SIGNATURE,
    async ({ nodeRef, expectedRevision, signer }) => {
      const ctx = ctxOf();
      try {
        const row = await signingMutations.requestNodeSignature({}, { nodeRef, expectedRevision, signerRef: signer }, ctx);
        return textResult(`${await renderRequest(row, ctx)}\n\nThe signer signs on the server-hosted ceremony page; no agent can complete this request.`);
      } catch (e) {
        return commentErrorText(e);
      }
    },
  );

  server.tool(
    'hadron_get_signing_request',
    'Read a signing request\'s state and, once completed, its signature (cor:dmo:130:03). Visible to the node\'s readers; an unknown id and one you cannot read look the same.',
    SHAPE_HADRON_GET_SIGNING_REQUEST,
    async ({ id }) => {
      const ctx = ctxOf();
      try {
        const row = await signingQueries.signingRequest({}, { id }, ctx);
        if (!row) return textResult(`[signing_request_not_found] Signing request not found\nid: ${id}`);
        return textResult(await renderRequest(row, ctx));
      } catch (e) {
        return commentErrorText(e);
      }
    },
  );

  server.tool(
    'hadron_withdraw_signing_request',
    'Withdraw an open signing request. Only the account that asked, from any of its sessions or workers (#10397).',
    SHAPE_HADRON_WITHDRAW_SIGNING_REQUEST,
    async ({ id }) => {
      const ctx = ctxOf();
      try {
        const row = await signingMutations.withdrawSigningRequest({}, { id }, ctx);
        return textResult(await renderRequest(row, ctx));
      } catch (e) {
        return commentErrorText(e);
      }
    },
  );
}

// ── #2260: parameter shapes, built ONCE per process ──────────────────────────
// A shape is pure data (no session state: moved here only because nothing in it resolves to a
// function- or block-scoped binding, so `tsc` rejects one that captures `auth` or any other
// per-session value). Every MCP session registers these same objects instead of rebuilding ~15 MB.

const SHAPE_HADRON_REQUEST_SIGNATURE = {
  nodeRef: z.string().describe('The node to sign: its URN or id.'),
  expectedRevision: z.number().int().positive().optional().describe('Refuse (REVISION_MISMATCH) unless this is still the current revision.'),
  signer: z.string().optional().describe('A user id to name as the only signer; they must be able to write the node\'s memory (SIGNER_NOT_A_WRITER otherwise). Omitted: any writer of the memory.'),
};

const SHAPE_HADRON_GET_SIGNING_REQUEST = { id: z.string().describe('The signing request id.') };

const SHAPE_HADRON_WITHDRAW_SIGNING_REQUEST = { id: z.string().describe('The signing request id.') };
