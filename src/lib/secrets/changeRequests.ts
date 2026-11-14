/** #3999; cor:sec:070:02. A person's staged change, immutable and encrypted under request-specific AAD. */
import { randomBytes, createHash } from 'node:crypto';
import { GraphQLError } from 'graphql';
import type { Prisma } from '../../generated/prisma/index.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { requirePersonOnlyAct } from '../auth/personAsThemselves.js';
import { signingSurfacePolicy } from '../signing/surface.js';
import { ensureAppKey, stagedValueAad } from './appKeys.js';
import { encryptBytesAad } from '../tokenCrypto.js';
import { getProjectBaseUrl } from '../baseUrl.js';

export const SECRET_CHANGE_TTL_SECONDS = 3600;
export const MAX_OPEN_SECRET_CHANGES = 5;
export const SECRET_CHANGE_PATH = '/secret-changes';
export type ChangeOperation = 'STORE' | 'DELETE' | 'SET_PROTECTED' | 'CLEAR_PROTECTED';
export interface ChangeRequest {
 id: string; app_id: string; secret_id: string | null; secret_name: string; secret_kind: string;
 protected_result: boolean | null; write_version: boolean;
 metadata: Prisma.JsonValue; operation: ChangeOperation; requester_id: string; state: string; snapshot: string;
 staged_value_encrypted: string | null; key_version: number | null; size_bytes: number | null;
 created_at: Date; expires_at: Date; ended_at: Date | null;
}
/** Fixed refusal; a request exists only when id/link are present. Never include payloads or ciphertext. */
export function needsPasskey(extra: Record<string, unknown> = {}): GraphQLError {
 return new GraphQLError('This secret changes only through your passkey ceremony.', { extensions: { code: 'SECRET_PROTECTED_NEEDS_PASSKEY', ...extra } });
}
/** Snapshot of all mutable secret terms; a later edit must make the request stale. */
export function changeSnapshot(secret: { id: string; updatedAt: Date; protected: boolean; metadata: unknown; changeRevision: number }, versionNo: number): string {
 return createHash('sha256').update(JSON.stringify([secret.id, secret.changeRevision, secret.updatedAt.toISOString(), secret.protected, secret.metadata, versionNo])).digest('hex');
}
/** Open under the caller's App authority and secret/name lock. Return the refusal; throw it only AFTER transaction commit. */
export async function stageSecretChange(tx: Prisma.TransactionClient, ctx: Context, a: {
 appId: string; secretId: string | null; name: string; kind: string; metadata: Prisma.JsonValue;
 operation: ChangeOperation; snapshot: string; valueJson?: string; sizeBytes?: number; protectedResult?: boolean; writeVersion?: boolean;
}): Promise<GraphQLError> {
 if (!signingSurfacePolicy().signing || ctx.appKeyId) throw needsPasskey();
 const requester = await requirePersonOnlyAct({ ...ctx, db: tx } as Context, 'secret.change', needsPasskey);
 // A protected create has no secret row to lock: its name lock also serializes ordinary creates at completion.
 await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`hadron:secret-change:${a.appId}:${a.name}`}))`;
 const [{ n }] = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM secret_change_requests
  WHERE app_id=${a.appId} AND secret_name=${a.name} AND state='open' AND expires_at > (clock_timestamp() AT TIME ZONE 'UTC')`;
 if (Number(n) >= MAX_OPEN_SECRET_CHANGES) throw new GraphQLError('Too many open secret changes.', { extensions: { code: 'SECRET_CHANGE_REQUEST_LIMIT' } });
 const id = randomBytes(16).toString('hex');
 let ciphertext: string | null = null, keyVersion: number | null = null;
 if (a.valueJson !== undefined) {
  const key = await ensureAppKey(tx, a.appId); keyVersion = key.keyVersion;
  ciphertext = encryptBytesAad(Buffer.from(a.valueJson), stagedValueAad(id), key.encryptionKey);
 }
 await tx.$executeRaw`INSERT INTO secret_change_requests
 (id,app_id,secret_id,secret_name,secret_kind,metadata,operation,requester_id,snapshot,staged_value_encrypted,key_version,size_bytes,protected_result,write_version,expires_at)
 VALUES (${id},${a.appId},${a.secretId},${a.name},${a.kind},${JSON.stringify(a.metadata)}::jsonb,${a.operation},${requester},${a.snapshot},${ciphertext},${keyVersion},${a.sizeBytes ?? null},${a.protectedResult ?? null},${a.writeVersion ?? true},
 (clock_timestamp() AT TIME ZONE 'UTC') + ${SECRET_CHANGE_TTL_SECONDS} * interval '1 second')`;
 return needsPasskey({ requestId: id, ceremonyUrl: `${getProjectBaseUrl()}${SECRET_CHANGE_PATH}/${id}` });
}
/** An expired request is never presented as live, even before the clearing sweep. */
export function visibleChange(r: ChangeRequest, now: Date) {
 return { id: r.id, state: r.state === 'open' && r.expires_at <= now ? 'expired' : r.state,
  operation: r.operation, createdAt: r.created_at.toISOString(), expiresAt: r.expires_at.toISOString() };
}
/** Clear expired ciphertext in bounded batches; expiry remains enforced independently at every use. */
export async function sweepExpiredSecretChanges(tx: Prisma.TransactionClient): Promise<number> {
 return tx.$executeRaw`UPDATE secret_change_requests SET state='expired',ended_at=(clock_timestamp() AT TIME ZONE 'UTC')
 WHERE id IN (SELECT id FROM secret_change_requests WHERE state='open' AND expires_at <= (clock_timestamp() AT TIME ZONE 'UTC')
 ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`;
}

/** Commit a staged refusal, then deliver it to the API caller. Throwing inside the transaction would erase the request. */
export function deliverStaged<T>(result: T | GraphQLError): T {
 if (result instanceof GraphQLError) throw result;
 return result;
}
