/** #3998: MCP exposes App-secret metadata only. Values, writes and read-client reveals have no MCP door. */
import { z } from 'zod';
import type { HadronMcpServer as McpServer } from './hadronMcpServer.js';
import type { PrismaClient } from '../generated/prisma/index.js';
import type { AuthContext } from '../middleware/auth.js';
import type { Context } from '../api/graphql/schema/resolvers.helpers.js';
import { secretFields, secretQueries } from '../api/graphql/schema/resolvers.secret.js';
import { toolErrorResult } from './toolError.js';

/** Shared shapes contain no connection state (#2260). */
export const SHAPE_LIST_SECRETS = {
  app: z.string().min(1).describe('The App id or fully-qualified URN. Lists only metadata you may inspect in that App.'),
  limit: z.number().int().min(0).optional().describe('Page size: default 20, cap 200; zero counts only.'),
  offset: z.number().int().min(0).optional().describe('Rows to skip; default 0.'),
};
export const SHAPE_GET_SECRET = {
  ref: z.string().min(1).describe('An App secret id or fully-qualified secret URN. Missing and unreadable both return null.'),
};

type SecretRow = NonNullable<Awaited<ReturnType<typeof secretQueries.secret>>>;

/** Allowlist the inspectable half; never serialize a resolver/Prisma row, encrypted column or client id. */
async function metadata(row: SecretRow, ctx: Context) {
  return {
    id: row.id, ownerType: row.ownerType, ownerId: row.ownerId, name: row.name, kind: row.kind,
    metadata: row.metadata, protected: row.protected, createdAt: row.createdAt, updatedAt: row.updatedAt,
    currentVersion: await secretFields.currentVersion(row, {}, ctx),
  };
}

/** Both tools call the same GraphQL read gates/rate admission; no new authority is inferred from an MCP connection. */
export function registerSecretTools(server: McpServer, { db, auth }: { db: PrismaClient; auth: AuthContext }): void {
  const context = (): Context => ({
    db, transport: 'mcp', userId: auth.userId ?? undefined, appId: auth.appId ?? undefined, appKeyId: auth.appKeyId ?? undefined,
    clientId: auth.clientId ?? undefined, roles: auth.roles as Context['roles'], impersonation: auth.impersonation,
    organizationId: auth.organizationId ?? undefined, apiKeyId: auth.apiKeyId ?? undefined, signInId: auth.signInId ?? undefined,
  });
  const result = async (run: () => Promise<unknown>) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await run()) }] }; }
    catch (error) { return toolErrorResult(error, () => 'Secret metadata is unavailable.', 'secret_metadata'); }
  };
  server.tool('hadron_list_secrets',
    'List App-secret metadata as a person entitled to inspect the App. Returns a page (items, total, hasMore), never a secret value, ciphertext or read-client id. App keys, runs and impersonated sessions see an empty page. No store, use or reveal is available over MCP.',
    SHAPE_LIST_SECRETS, ({ app, limit, offset }) => result(async () => {
      const ctx = context();
      const page = await secretQueries.secrets({}, { ownerType: 'app', ownerRef: app, limit, offset }, ctx);
      const items = await Promise.all(page.items.map(row => metadata(row, ctx)));
      return { items, total: page.total, hasMore: (offset ?? 0) + items.length < page.total };
    }));
  server.tool('hadron_get_secret',
    'Get App-secret metadata by id or URN as a person entitled to inspect it. Missing, unreadable and non-App secrets return null. Never returns a value, ciphertext or read-client id. Request a pending read grant with hadron_create_grant in an App you manage; a person must sign it. MCP cannot store, use or reveal a secret.',
    SHAPE_GET_SECRET, ({ ref }) => result(async () => {
      const ctx = context();
      const row = await secretQueries.secret({}, { ref }, ctx);
      return row?.ownerType === 'app' ? metadata(row, ctx) : null;
    }));
}
