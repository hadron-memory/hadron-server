/**
 * #5404: the test fixture for what an App's userless runs read and write outside their own memories. Ruling 0083's unsigned App
 * write grant and #2883's per-automation read grant are gone (their rows are deleted at deploy); a run reaches another memory only
 * through a signed `memory.read` / `memory.write` grant held by its App. This writes such a grant ACTIVE, around the signing
 * ceremony (the database guard refuses an ACTIVE insert, so the one trigger is disabled for this insert only), so a test that needs
 * the REACH does not walk the passkey ceremony. The ceremony and its refusals are pinned in src/lib/grants/memoryRead5321.test.ts
 * and src/api/graphql/schema/resolvers.memoryWriteGrant5404.test.ts.
 */
import type { PrismaClient } from '../generated/prisma/index.js';
import { db as defaultDb } from '../integrations/db/client.js';
import { generateId } from '../lib/id.js';
import { upsertPlatformActions } from '../lib/grants/actions.js';
import { WHOLE_MEMORY } from '../lib/grants/writeGrant.js';

const DB_NOW = "(clock_timestamp() AT TIME ZONE 'UTC')";

export interface AppGrantOpts {
  /** The person who signed it; null for an erased giver. Must manage the memory (write) or read it (read) for the grant to count. */
  issuerUserId: string | null;
  db?: PrismaClient;
}

async function insertActive(client: PrismaClient, appId: string, action: string, values: Record<string, unknown>, issuer: string | null): Promise<string> {
  await upsertPlatformActions(client);
  const id = generateId();
  await client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
    await tx.$executeRawUnsafe(
      `INSERT INTO grants (id, app_id, user_id, grantee_app_id, issuer_user_id, action, action_values, reason, activated_at,
         verification_kind, verified_by, created_at, updated_at)
       VALUES ($1, $2, NULL, $2, $3, $4, $5::jsonb, 'test', ${DB_NOW}, 'PASSKEY', $6, ${DB_NOW}, ${DB_NOW})`,
      id, appId, issuer, action, JSON.stringify(values), issuer ?? 'gone');
    await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
  });
  return id;
}

/** An ACTIVE `memory.write` grant held by `appId`: `memory` (one id or a list) under `prefix` (default: the whole memory). */
export function activeMemoryWriteGrant(
  appId: string, memory: string | string[], opts: AppGrantOpts & { prefix?: string },
): Promise<string> {
  return insertActive(opts.db ?? defaultDb, appId, 'memory.write', { memory, prefix: opts.prefix ?? WHOLE_MEMORY }, opts.issuerUserId);
}

/** An ACTIVE `memory.read` grant held by `appId`: `memory` is one memory id, a list, or the App's own organization id (form (a)). */
export function activeMemoryReadGrant(appId: string, memory: string | string[], opts: AppGrantOpts): Promise<string> {
  return insertActive(opts.db ?? defaultDb, appId, 'memory.read', { memory }, opts.issuerUserId);
}

/** Revoke a grant (a terminal row state, written around the guard like the insert). */
export async function revokeGrantRow(grantId: string, revokedBy: string, client: PrismaClient = defaultDb): Promise<void> {
  await client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER USER');
    await tx.$executeRawUnsafe(`UPDATE grants SET revoked_at = ${DB_NOW}, revoked_by = $2, updated_at = ${DB_NOW} WHERE id = $1`, grantId, revokedBy);
    await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER USER');
  });
}
