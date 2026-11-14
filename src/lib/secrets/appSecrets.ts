/**
 * #3997 (S2 of #3991) — the App-owned secret store: versions, the audit trail, and the bounds.
 *
 * An App secret keeps NO value on its `secrets` row (`chk_secret_app_value`). Its value is its newest
 * `secret_versions` row, encrypted under the App key's ENCRYPTION subkey (S1, R17) with an AAD naming the secret and
 * the version number (R19), so a ciphertext moved to another version or secret fails its GCM tag. Every function here
 * takes a TRANSACTION client: the store takes the next version number under a lock on the secret row, so two racing
 * stores end at n+1 and n+2, never a duplicate or a gap (the gate's added acceptance line).
 *
 * No value, ciphertext or fingerprint is ever logged, returned or put in an event (R11). Errors raised here name a
 * fixed code and never the value.
 */
import { GraphQLError } from 'graphql';
import type { Prisma } from '../../generated/prisma/index.js';
import { decryptBytesAad, encryptBytesAad } from '../tokenCrypto.js';
import { ensureAppKey, secretVersionAad, unwrapAppKey } from './appKeys.js';
import { boundWorkerId } from '../bootPrompt.js';

/** R24 bounds (the plan's proposed constants; code constants unless an operator needs them). */
export const MAX_SECRETS_PER_APP = 500;
/** A secret keeps at most this many versions; the oldest SUPERSEDED go first (cor:sec:010:03). The current one never goes. */
export const MAX_SECRET_VERSIONS = 50;

export type SecretEventKind = 'STORE' | 'VERSION' | 'METADATA' | 'DELETE' | 'PROTECT' | 'UNPROTECT';

/** Who acted, as plain ids (no foreign keys), the way the grant tables record it. */
export interface SecretActor {
  userId: string | null;
  workerId: string | null;
  sessionId: string | null;
}

/** The actor of a request: the person, the worker bound to the request (if any) and the session. */
export function secretActorOf(ctx: { userId?: string; sessionId?: string }): SecretActor {
  return { userId: ctx.userId ?? null, workerId: boundWorkerId() ?? null, sessionId: ctx.sessionId ?? null };
}

function limitRefusal(code: string, message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code } });
}

/** One audit row. The time is the database clock (column default). Never a value. */
export async function recordSecretEvent(
  tx: Prisma.TransactionClient,
  e: { ownerId: string; secretId: string; secretName: string; kind: SecretEventKind; versionNo?: number | null; outcome?: string; actor: SecretActor },
): Promise<void> {
  await tx.secretEvent.create({
    data: {
      ownerType: 'app', ownerId: e.ownerId, secretId: e.secretId, secretName: e.secretName,
      versionNo: e.versionNo ?? null, kind: e.kind, outcome: e.outcome ?? 'OK',
      actorUserId: e.actor.userId, workerId: e.actor.workerId, sessionId: e.actor.sessionId,
    },
  });
}

/** Lock the secret's row. Returns false when it is gone (a concurrent delete won). */
export async function lockSecretRow(tx: Prisma.TransactionClient, secretId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM secrets WHERE id = ${secretId} FOR UPDATE`;
  return rows.length > 0;
}

/**
 * Refuse when the App already holds the maximum number of secrets (R24). Counted under a per-App advisory lock, so
 * two creates racing at 499 do not both pass.
 */
export async function assertAppSecretRoom(tx: Prisma.TransactionClient, appId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`hadron:secret-app-count:${appId}`}))`;
  const count = await tx.secret.count({ where: { ownerType: 'app', ownerId: appId } });
  if (count >= MAX_SECRETS_PER_APP) {
    throw limitRefusal('SECRET_LIMIT_REACHED', `An App holds at most ${MAX_SECRETS_PER_APP} secrets.`);
  }
}

/**
 * Add the next version of an App secret: the caller holds the secret row's lock (`lockSecretRow`). Encrypts under the
 * App's active key, stamps the previous current version superseded, and keeps at most {@link MAX_SECRET_VERSIONS}
 * (the oldest superseded go first). Returns the new version number.
 */
export async function addAppSecretVersion(
  tx: Prisma.TransactionClient,
  secret: { id: string; ownerId: string },
  valueJson: string,
  sizeBytes: number,
  actor: SecretActor,
): Promise<number> {
  const newest = await tx.secretVersion.findFirst({
    where: { secretId: secret.id }, orderBy: { versionNo: 'desc' }, select: { versionNo: true },
  });
  const versionNo = (newest?.versionNo ?? 0) + 1;
  const key = await ensureAppKey(tx, secret.ownerId);
  const valueEncrypted = encryptBytesAad(Buffer.from(valueJson, 'utf8'), secretVersionAad(secret.id, versionNo), key.encryptionKey);
  await tx.secretVersion.create({
    data: {
      secretId: secret.id, versionNo, valueEncrypted, appId: secret.ownerId, keyVersion: key.keyVersion, sizeBytes,
      writtenByUserId: actor.userId, writtenByWorkerId: actor.workerId, writtenBySessionId: actor.sessionId,
    },
  });
  if (newest) {
    await tx.$executeRaw`UPDATE secret_versions SET superseded_at = (clock_timestamp() AT TIME ZONE 'UTC')
      WHERE secret_id = ${secret.id} AND version_no < ${versionNo} AND superseded_at IS NULL`;
  }
  // Retention by count: the newest MAX versions stay; older superseded ones go (never the current one).
  await tx.$executeRaw`DELETE FROM secret_versions WHERE secret_id = ${secret.id} AND superseded_at IS NOT NULL
    AND version_no <= ${versionNo - MAX_SECRET_VERSIONS}`;
  return versionNo;
}

/**
 * The current value of an App secret, decrypted under its App key with the version's own AAD. Used server-side only,
 * to re-validate a metadata-only change against the stored value; no GraphQL field returns it (S3 adds the one read
 * path). Fails closed: a missing version (`SECRET_VERSION_MISSING`), a wrong AAD or a missing key refuses.
 */
export async function currentAppSecretValue(tx: Prisma.TransactionClient, secret: { id: string; ownerId: string }): Promise<unknown> {
  const row = await tx.secretVersion.findFirst({
    where: { secretId: secret.id }, orderBy: { versionNo: 'desc' },
    omit: { valueEncrypted: false },
  });
  if (!row) throw limitRefusal('SECRET_VERSION_MISSING', 'The secret has no stored version.');
  const key = await unwrapAppKey(tx, secret.ownerId, row.keyVersion);
  return JSON.parse(decryptBytesAad(row.valueEncrypted, secretVersionAad(secret.id, row.versionNo), key.encryptionKey).toString('utf8'));
}
