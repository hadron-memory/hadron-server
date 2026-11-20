/** #4001 / cor:sec:060:03: a signed deletion deadline survives every client end. No values are read by the sweep. */
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import { recordSecretEvent, type SecretActor } from './appSecrets.js';

export function autoDeleteLimitRefusal(autoDelete: boolean, expiresAt: Date | null, maxUses: number | null): {
  code: 'SECRET_AUTO_DELETE_NEEDS_LIMIT'; message: string;
} | null {
  return autoDelete && !expiresAt && maxUses === null
    ? { code: 'SECRET_AUTO_DELETE_NEEDS_LIMIT', message: 'An auto-delete mark needs a window or a read budget.' }
    : null;
}

/** Caller holds the secret row lock. DELETE cascades all versions and its DB trigger ends all clients, preserving prior ends. */
export async function deleteLockedAppSecret(
  tx: Prisma.TransactionClient, secret: { id: string; ownerId: string; name: string },
  actor: SecretActor = { userId: null, workerId: null, sessionId: null },
): Promise<void> {
  const newest = await tx.secretVersion.findFirst({ where: { secretId: secret.id }, orderBy: { versionNo: 'desc' }, select: { versionNo: true } });
  await recordSecretEvent(tx, { ownerId: secret.ownerId, secretId: secret.id, secretName: secret.name, kind: 'DELETE', versionNo: newest?.versionNo ?? null, actor });
  await tx.secret.delete({ where: { id: secret.id } });
}

/**
 * Bounded pass (up to 20 batches of 500), secret then grant order. Lock secrets with SKIP LOCKED; judge signed terms in a SECOND statement after
 * the lock, on the database clock. Revocation, departure and client ended_at deliberately do not cancel a signed deadline
 * (Holger ruling 1A). An unsigned/pending grant never deletes. A row id, never its reusable name, is the deletion identity.
 */
export async function sweepSecretAutoDelete(db: PrismaClient, batchSize = 500): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < 20; batch++) {
    const count = await db.$transaction(async tx => {
    const secrets = await tx.$queryRaw<Array<{ id: string; owner_id: string; name: string }>>`
      SELECT s.id, s.owner_id, s.name FROM secrets s
      WHERE s.owner_type = 'app' AND EXISTS (
        SELECT 1 FROM secret_read_clients c JOIN grants g ON g.id = c.grant_id
        WHERE c.secret_id = s.id AND c.app_id = s.owner_id AND g.app_id = c.app_id
          AND g.action IN ('secret.reveal', 'secret.use') AND g.action_values->>'secret' = s.id
          AND g.action_values->>'auto-delete' = 'delete' AND g.activated_at IS NOT NULL AND g.signature_id IS NOT NULL
          AND g.expires_at <= (clock_timestamp() AT TIME ZONE 'UTC'))
      ORDER BY s.id LIMIT ${batchSize} FOR UPDATE OF s SKIP LOCKED`;
    let deleted = 0;
    for (const s of secrets) {
      const [due] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT g.id FROM secret_read_clients c JOIN grants g ON g.id = c.grant_id
        WHERE c.secret_id = ${s.id} AND c.app_id = ${s.owner_id} AND g.app_id = c.app_id
          AND g.action IN ('secret.reveal', 'secret.use') AND g.action_values->>'secret' = ${s.id}
          AND g.action_values->>'auto-delete' = 'delete' AND g.activated_at IS NOT NULL AND g.signature_id IS NOT NULL
          AND g.expires_at <= (clock_timestamp() AT TIME ZONE 'UTC') LIMIT 1`;
      if (!due) continue;
      await deleteLockedAppSecret(tx, { id: s.id, ownerId: s.owner_id, name: s.name });
      deleted++;
    }
    return deleted;
    }, { timeout: 30_000 });
    total += count;
    if (count < batchSize) break;
  }
  return total;
}
