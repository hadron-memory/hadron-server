/** #3999; cor:sec:070:02. A person's staged change, immutable and encrypted under request-specific AAD. */
import { randomBytes, createHash } from 'node:crypto';
import { GraphQLError } from 'graphql';
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import { requirePersonOnlyAct } from '../auth/personAsThemselves.js';
import { signingSurfacePolicy } from '../signing/surface.js';
import { ensureAppKey, stagedValueAad } from './appKeys.js';
import { encryptBytesAad } from '../tokenCrypto.js';
import { assertAppSecretRoomForStaging } from './appSecrets.js';
import { getProjectBaseUrl } from '../baseUrl.js';

export const SECRET_CHANGE_TTL_SECONDS = 3600;
export const MAX_OPEN_SECRET_CHANGES = 5;
export const MAX_OPEN_SECRET_CHANGES_PER_REQUESTER = 2;
/** #5245; cor:sec:070:02 (Proposed): open requests across one App, and one requester's share of them. Engineering bounds. */
export const MAX_OPEN_SECRET_CHANGES_PER_APP = 100;
export const MAX_OPEN_SECRET_CHANGES_PER_REQUESTER_PER_APP = 20;
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
/** The one mint of a change request's ceremony link (#5103): the error extension and `SecretChangeRequest.ceremonyUrl` both call it. No token: the id is the address. */
export function secretChangeCeremonyUrl(id: string): string {
 return `${getProjectBaseUrl()}${SECRET_CHANGE_PATH}/${id}`;
}
/**
 * The checks every secret change request passes before it is staged (#3999; cor:sec:070:02): the signing surface is on, the caller
 * is no App key, and it is a person acting as themselves (a worker session, a run and an impersonation are refused). One predicate:
 * `stageSecretChange` and the silent no-op for a protection re-assert (#5299) both call it, so the no-op can never answer a caller
 * the staging would refuse. Returns the person's user id; any miss is the one SECRET_PROTECTED_NEEDS_PASSKEY with no request id.
 */
export async function requireStagingPerson(tx: Prisma.TransactionClient, ctx: Context): Promise<string> {
 if (!signingSurfacePolicy().signing || ctx.appKeyId) throw needsPasskey();
 return requirePersonOnlyAct({ ...ctx, db: tx } as Context, 'secret.change', needsPasskey);
}
/** Open under the caller's App authority and secret/name lock. Return the refusal; throw it only AFTER transaction commit. */
export async function stageSecretChange(tx: Prisma.TransactionClient, ctx: Context, a: {
 appId: string; secretId: string | null; name: string; kind: string; metadata: Prisma.JsonValue;
 operation: ChangeOperation; snapshot: string; valueJson?: string; sizeBytes?: number; protectedResult?: boolean; writeVersion?: boolean;
 /** #5245: a protected create is refused at staging when the App has no room (secrets plus open protected creates). */
 requireAppRoom?: boolean;
}): Promise<GraphQLError> {
 const requester = await requireStagingPerson(tx, ctx);
 // A protected create has no secret row to lock: its name lock also serializes ordinary creates at completion.
 await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`hadron:secret-change:${a.appId}:${a.name}`}))`;
 // #5245: the App-wide lock is the last staging lock before the count (two-int form, objsubid=2: it cannot collide with the
 // single-key name or app-count locks). The count below depends on READ COMMITTED: it is a new statement after both lock
 // waits, so it sees any stage that committed meanwhile; under SERIALIZABLE it would keep its pre-wait snapshot.
 await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('hadron:secret-change-app'), hashtext(${a.appId}))`;
 // #5245 (R3): after the name and App-wide locks (so two creates of one name still queue on the name lock), after the person
 // check (a non-person still gets the passkey refusal), and judged before the caps. It takes the app-count lock last; completion
 // holds that lock but never the name or App-wide lock, so the order is acyclic.
 if (a.requireAppRoom) await assertAppSecretRoomForStaging(tx, a.appId);
 const [{ n, requester_n, app_n, requester_app_n }] = await tx.$queryRaw<Array<{ n: bigint; requester_n: bigint; app_n: bigint; requester_app_n: bigint }>>`SELECT
  count(*) FILTER (WHERE secret_name=${a.name}) AS n,
  count(*) FILTER (WHERE secret_name=${a.name} AND requester_id=${requester}) AS requester_n,
  count(*) AS app_n,
  count(*) FILTER (WHERE requester_id=${requester}) AS requester_app_n FROM secret_change_requests
  WHERE app_id=${a.appId} AND state='open' AND expires_at > (clock_timestamp() AT TIME ZONE 'UTC')`;
 if (Number(n) >= MAX_OPEN_SECRET_CHANGES) throw new GraphQLError('Too many open secret changes.', { extensions: { code: 'SECRET_CHANGE_REQUEST_LIMIT' } });
 if (Number(requester_n) >= MAX_OPEN_SECRET_CHANGES_PER_REQUESTER || Number(requester_app_n) >= MAX_OPEN_SECRET_CHANGES_PER_REQUESTER_PER_APP) {
  throw new GraphQLError('Too many open secret changes for this requester.', { extensions: { code: 'SECRET_CHANGE_REQUESTER_LIMIT' } });
 }
 if (Number(app_n) >= MAX_OPEN_SECRET_CHANGES_PER_APP) throw new GraphQLError('Too many open secret changes in this App.', { extensions: { code: 'SECRET_CHANGE_APP_LIMIT' } });
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
 return needsPasskey({ requestId: id, ceremonyUrl: secretChangeCeremonyUrl(id) });
}
/** An expired request is never presented as live, even before the clearing sweep. */
export function visibleChange(r: ChangeRequest, now: Date) {
 return { id: r.id, state: r.state === 'open' && r.expires_at <= now ? 'expired' : r.state,
  operation: r.operation, createdAt: r.created_at, expiresAt: r.expires_at, ceremonyUrl: secretChangeCeremonyUrl(r.id) };
}
/**
 * Engineering bounds of the expiry sweep (#5244; the Proposed sweep-backlog line of hrn:node:hadronmemory.com:specs:cor:sec:070:02),
 * the same as the version purge: a batch is one transaction of at most this many rows, a run is at most this many batches, and a
 * backlog beyond them waits for the next run. Numbers, not rules: they may change without a spec change.
 */
export const SECRET_CHANGE_SWEEP_BATCH = 500;
export const SECRET_CHANGE_SWEEP_MAX_BATCHES = 20;

/**
 * Clear ONE batch of expired ciphertext; expiry remains enforced independently at every use. The row trigger nulls the ciphertext.
 * The UPDATE repeats the predicate as a backstop (the batch's row locks already hold the rows).
 * #5348: the batch is a MATERIALIZED CTE, run once. As an `id IN (subquery)` a nested-loop plan rescanned the LIMIT ... SKIP LOCKED
 * subquery per outer row, each rescan skipping the rows this statement had just updated and taking the next ones, so one batch
 * could update the whole backlog (a LIMIT 1 batch cleared 300 rows on a table without statistics), past every row and time bound.
 */
export async function sweepExpiredSecretChanges(tx: Prisma.TransactionClient, limit: number = SECRET_CHANGE_SWEEP_BATCH): Promise<number> {
 return tx.$executeRaw`WITH batch AS MATERIALIZED (SELECT id FROM secret_change_requests
 WHERE state='open' AND expires_at <= (clock_timestamp() AT TIME ZONE 'UTC')
 ORDER BY expires_at, id LIMIT ${limit}::int FOR UPDATE SKIP LOCKED)
 UPDATE secret_change_requests s SET state='expired',ended_at=(clock_timestamp() AT TIME ZONE 'UTC')
 FROM batch WHERE s.id = batch.id AND s.state='open' AND s.expires_at <= (clock_timestamp() AT TIME ZONE 'UTC')`;
}

/**
 * #5348: the time bounds of one drain batch (the Proposed sweep-backlog line of hrn:node:hadronmemory.com:specs:cor:sec:070:02;
 * engineering bounds, like the row bounds above). Postgres cancels the batch statement after STATEMENT_TIMEOUT (a
 * transaction-local `statement_timeout`, so it never reaches the pooled connection's session); the interactive transaction around
 * it gets TX_TIMEOUT, the statement bound plus room for the rest, instead of Prisma's 5 s default, which a large backlog on a loaded
 * database overran on every tick (the batch rolled back each time and the sweep never advanced, defeating S6); MAX_WAIT bounds the
 * wait for a pooled connection.
 */
export const SECRET_CHANGE_SWEEP_STATEMENT_TIMEOUT_MS = 25_000;
export const SECRET_CHANGE_SWEEP_TX_TIMEOUT_MS = 30_000;
export const SECRET_CHANGE_SWEEP_TX_MAX_WAIT_MS = 10_000;
const SWEEP_TX_HEADROOM_MS = SECRET_CHANGE_SWEEP_TX_TIMEOUT_MS - SECRET_CHANGE_SWEEP_STATEMENT_TIMEOUT_MS;

/** Postgres 57014 however Prisma wraps it (a raw query's P2010 carries it in meta or in the message). */
const isStatementTimeout = (e: unknown): boolean => {
 if (!(e instanceof Error)) return false;
 const meta = (e as { meta?: { code?: unknown } }).meta;
 return String(meta?.code) === '57014' || /(?:Code:\s*`|SQLSTATE[\s:]*)57014\b|canceling statement due to statement timeout/i.test(e.message);
};
/**
 * The batch ran past its bound: a statement timeout, or the interactive transaction expired (P2028). P2028 has a second arm, a
 * transaction that could not START within maxWait (pool exhaustion): a smaller batch does not help there, so it is not an overrun.
 */
const isBatchOverrun = (e: unknown): boolean => isStatementTimeout(e)
 || (e instanceof Error && (e as { code?: unknown }).code === 'P2028' && !/unable to start a transaction/i.test(e.message));

/**
 * Drain expired requests in batches, each its own transaction (an earlier batch stays cleared if a later one fails). Returns the
 * number cleared. #5348: each batch runs under the time bounds above; a batch that overruns them rolls back (nothing cleared, the
 * rows stay for a later batch) and the next batch of the same run asks for half as many rows, down to one, so a slow database
 * still makes progress. An overrun spends a batch slot, so a run stays within maxBatches transactions. A single row that still
 * overruns fails the run (the loop logs it and retries next tick); any other fault fails it at once, as before.
 */
export async function drainExpiredSecretChanges(
 db: Pick<PrismaClient, '$transaction'>,
 bounds: { batchSize?: number; maxBatches?: number; shouldStop?: () => boolean; statementTimeoutMs?: number } = {},
): Promise<number> {
 let batchSize = bounds.batchSize ?? SECRET_CHANGE_SWEEP_BATCH;
 const maxBatches = bounds.maxBatches ?? SECRET_CHANGE_SWEEP_MAX_BATCHES;
 const statementMs = bounds.statementTimeoutMs ?? SECRET_CHANGE_SWEEP_STATEMENT_TIMEOUT_MS;
 const options = { timeout: statementMs + SWEEP_TX_HEADROOM_MS, maxWait: SECRET_CHANGE_SWEEP_TX_MAX_WAIT_MS };
 let total = 0;
 for (let i = 0; i < maxBatches; i++) {
  if (i > 0 && bounds.shouldStop?.()) break;
  const limit = batchSize;
  let n: number;
  try {
   n = await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(statementMs)}, true)`;
    return sweepExpiredSecretChanges(tx, limit);
   }, options);
  } catch (e) {
   if (!isBatchOverrun(e) || limit <= 1) throw e;
   batchSize = Math.max(1, Math.floor(limit / 2));
   console.warn(`secret.change_sweep.batch_overrun limit=${limit} next=${batchSize}`);
   continue;
  }
  total += n;
  if (n < limit) break;
 }
 return total;
}

/** Commit a staged refusal, then deliver it to the API caller. Throwing inside the transaction would erase the request. */
export function deliverStaged<T>(result: T | GraphQLError): T {
 if (result instanceof GraphQLError) throw result;
 return result;
}
