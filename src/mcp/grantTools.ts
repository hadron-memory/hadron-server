/**
 * #3711 (Grants S2b; ruling 0255 item 21, cor:acl:140:05 Create): `hadron_create_grant`, a PERSON who manages an App asking for a
 * grant over MCP. A thin call into the SAME manager arm `createGrant` serves on GraphQL (resolvers.grantCreate.ts), so the gate,
 * the holder rules and the refusal codes are one.
 *
 * WHO ACTS. Always the connection's PERSON. The tool never acts as a worker, even on a connection bound to one (`hadron_start_session`):
 * it publishes a cleared actor and names no session, so the row records the person as requester and no worker or session. It
 * therefore gains none of the worker producer's authority either: a worker session over MCP has no way to create a grant. An App
 * key (no user), a run, an impersonated session and a refused session binding get the one GRANT_NOT_MANAGER answer, as on GraphQL.
 * Listing, revoking and withdrawing are NOT promised over MCP by any ruling and are not here. Present only where signing is
 * switched on, as `createGrant` is.
 */
import { z } from 'zod';
import { GraphQLError } from 'graphql';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PrismaClient } from '../generated/prisma/index.js';
import type { AuthContext } from '../middleware/auth.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';
import { grantCreateMutations } from '../api/graphql/schema/resolvers.grantCreate.js';
import { isTrustedRefusal } from '../api/graphql/formatError.js';
import { publicErrorExtensions } from '../lib/errorDiagnostics.js';
import { runAsActor } from '../lib/requestActor.js';
import { signingSurfacePolicy } from '../lib/signing/surface.js';
import { mcpRequestSessionContext } from './requestSession.js';

export const SHAPE_CREATE_GRANT = {
  app: z.string().min(1).describe('The App the grant is for: its id or fully-qualified URN. You must manage it.'),
  action: z.string().min(1).describe('A registered action\'s dotted name, such as schedule.create.'),
  values: z.record(z.string(), z.unknown()).describe('Exactly the action\'s declared parameters, each a string or a list of distinct strings (an id, never a URN). Never put a secret here.'),
  holderKind: z.enum(['WORKER', 'AGENT']).describe('WORKER (a worker of the App) or AGENT (an agent installed in it).'),
  holderRef: z.string().min(1).describe('The holder\'s id (not a URN).'),
  startsAt: z.string().optional().describe('ISO time before which the signed grant is not usable.'),
  expiresAt: z.string().optional().describe('ISO time after which it is not usable; must follow startsAt.'),
  maxUses: z.number().int().optional().describe('At most this many uses once signed; a positive integer.'),
  reason: z.string().min(1).describe('Why the grant is asked for; shown to the signer as the requester\'s words.'),
};

const text = (t: string, isError = false) => ({ ...(isError ? { isError: true as const } : {}), content: [{ type: 'text' as const, text: t }] });

/** Register the grant tool on one MCP server instance. `auth` is the connection's principal. */
export function registerGrantTools(server: McpServer, { db, auth }: { db: PrismaClient; auth: AuthContext }): void {
  if (!signingSurfacePolicy().signing) return;
  const ctxOf = (): Context => ({
    db, transport: 'mcp', clientId: auth.clientId ?? undefined, userId: auth.userId ?? undefined, apiKeyId: auth.apiKeyId ?? undefined,
    signInId: auth.signInId, appId: auth.appId ?? undefined, appKeyId: auth.appKeyId ?? undefined, roles: auth.roles as Context['roles'],
    organizationId: auth.organizationId ?? undefined, impersonation: auth.impersonation, sessionBindingRefused: mcpRequestSessionContext(auth).sessionBindingRefused,
    // No sessionId: a worker-bound connection's session is deliberately not carried.
  });
  server.tool(
    'hadron_create_grant',
    'Ask for a grant in an App you manage, as yourself (never as a worker, even on a worker-bound connection): the row is born PENDING and allows nothing until a person signs it. Holder: a worker of the App or an agent installed in it. Refusals, each before any write: grant_not_manager (not a person who manages the App, and an unknown App: the same answer), grant_holder_not_allowed, grant_action_unknown, grant_values_invalid, grant_terms_invalid. Listing, revoking and withdrawing are not available over MCP.',
    SHAPE_CREATE_GRANT,
    async ({ app, action, values, holderKind, holderRef, startsAt, expiresAt, maxUses, reason }) => {
      try {
        const grant = await runAsActor({ workerId: null, agentId: null }, () => grantCreateMutations.createGrant(
          null, { input: { appRef: app, action, values, holderKind, holderRef, startsAt, expiresAt, maxUses, reason } }, ctxOf(),
        ));
        return text(JSON.stringify(grant));
      } catch (e) {
        if (e instanceof GraphQLError && isTrustedRefusal(e)) {
          const { code } = publicErrorExtensions(e.extensions ?? {});
          return text(`[${String(code ?? 'ERROR').toLowerCase()}] ${e.message}`, true);
        }
        throw e;
      }
    },
  );
}
