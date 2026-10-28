/**
 * #1667 — the per-asset public-link switch on the MCP surface (cor:dmo:060:15).
 *
 * A thin call into the SAME core GraphQL `setAssetPublicLink` serves
 * (`src/lib/asset/publicLink.ts`): the manager gate, the authority recheck under
 * locks and the audit row are decided once, so the two surfaces cannot drift.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { setAssetPublicLink } from '../lib/asset/publicLink.js';
import { AssetUploadError } from '../controller/operations/beginAssetUpload.js';
import type { AuthContext } from '../middleware/auth.js';
import type { PrismaClient } from '../generated/prisma/index.js';
import { isTrustedRefusal } from '../api/graphql/formatError.js';
import { GraphQLError } from 'graphql';

export const SHAPE_HADRON_SET_ASSET_PUBLIC_LINK = {
  asset: z.string().min(1).describe('The asset id.'),
  enabled: z.boolean().describe('true switches the asset\'s anonymous public link on, false switches it off.'),
};

type AssetFields = {
  publicUrl: (a: unknown, args: unknown, ctx: Context) => Promise<string | null>;
  canManagePublicLink: (a: unknown, args: unknown, ctx: Context) => Promise<boolean>;
  publicLinkAvailable: () => boolean;
};

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export function registerAssetTools(server: McpServer, deps: { db: PrismaClient; auth: AuthContext }): void {
  const { db, auth } = deps;
  const ctxOf = (): Context => ({
    db,
    transport: 'mcp',
    clientId: auth.clientId ?? undefined,
    userId: auth.userId ?? undefined,
    apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId,
    appId: auth.appId ?? undefined,
    sessionId: auth.sessionId ?? undefined,
    roles: auth.roles as Context['roles'],
    organizationId: auth.organizationId ?? undefined,
    impersonation: auth.impersonation,
  });

  server.tool(
    'hadron_set_asset_public_link',
    'Switch an asset\'s anonymous public link on or off (cor:dmo:060:15). Only whoever manages the asset\'s memory may; writing to the memory is not enough, and in a personal or private memory only its owner. Every asset starts off. The link also needs the deployment switch and a live, scanned asset in an unencrypted memory, so turning it on may still leave publicUrl empty; the result says which.',
    SHAPE_HADRON_SET_ASSET_PUBLIC_LINK,
    async ({ asset, enabled }) => {
      const ctx = ctxOf();
      try {
        const updated = await setAssetPublicLink(ctx, asset, enabled);
        const fields = (resolvers as unknown as { Asset: AssetFields }).Asset;
        const url = await fields.publicUrl(updated, {}, ctx);
        return textResult([
          `Asset ${updated.id}: public link ${updated.publicLinkEnabled ? 'ON' : 'OFF'}.`,
          `publicLinkAvailable: ${fields.publicLinkAvailable()}`,
          `publicUrl: ${url ?? '(none)'}`,
          'publicUrl empty does not mean the link is off: it also needs the deployment switch, a scanned asset in an unencrypted memory and a configured origin.',
        ].join('\n'));
      } catch (e) {
        if (e instanceof AssetUploadError) return { isError: true as const, ...textResult(`[${e.code.toLowerCase()}] ${e.message}`) };
        if (e instanceof GraphQLError && isTrustedRefusal(e)) return { isError: true as const, ...textResult(`[${String(e.extensions?.code).toLowerCase()}] ${e.message}`) };
        throw e;
      }
    },
  );
}
