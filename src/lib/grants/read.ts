/**
 * #3789 (Grants S2a-read; cor:acl:140:05 List, :03 live, :01): the data-layer read of grants for a BOUND WORKER, shared by
 * the GraphQL `grant(ref:)` / `grants` resolvers and, once it exists (#3710, not built), the run tool, which will call it directly and not through the resolver.
 *
 * Who is a reader is decided by the CALLER (the resolver's gate), which hands this module a {@link GrantReader}: a worker and
 * the App it belongs to. This module owns the row scope, and it is the same for every caller:
 *   - the reader's OWN App only (`app_id` is the reader's App; a row of another App naming the worker is absent);
 *   - the rows naming the worker DIRECTLY as holder, plus the rows the worker itself requested that are still PENDING
 *     (never activated, never withdrawn: once activated, the holder's arm decides). Rows held by the worker's role agent, by
 *     another worker, by a person or by an App are not listed: that is S2b (#3711);
 *   - a soft-deleted App conceals its grants (the join below), whatever the gate upstream concluded.
 * A row that is out of scope is simply absent. No error, no different answer from a missing id, no count that discloses it.
 *
 * The projection is ids and scalars only, with `allows` from S1a's one live function ({@link grantLiveSql}, the database
 * clock). There is NO state label: nothing here names the cor:acl:140:03 Open cases.
 */
import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { grantLiveSql } from './live.js';

type Db = PrismaClient | Prisma.TransactionClient;

/** A worker reading its own grants, in the App the worker belongs to. */
export interface GrantReader { appId: string; workerId: string }

export type GrantHolderKind = 'USER' | 'AGENT' | 'WORKER' | 'APP';

export interface GrantView {
  id: string;
  appId: string;
  action: string;
  values: unknown;
  holderKind: GrantHolderKind;
  holderId: string;
  issuerUserId: string | null;
  requestedByUserId: string | null;
  requestedByWorkerId: string | null;
  requestedBySessionId: string | null;
  startsAt: Date | null;
  expiresAt: Date | null;
  maxUses: number | null;
  useCount: number;
  reason: string;
  createdAt: Date;
  activatedAt: Date | null;
  verificationKind: string | null;
  verifiedBy: string | null;
  signatureId: string | null;
  revokedAt: Date | null;
  /** Live right now, on the database clock (S1a's definition). Never a state name. */
  allows: boolean;
}

interface Row {
  id: string; app_id: string; user_id: string | null; agent_id: string | null; worker_id: string | null; grantee_app_id: string | null;
  issuer_user_id: string | null; requested_by_user_id: string | null; requested_by_worker_id: string | null; requested_by_session_id: string | null;
  action: string; action_values: unknown; starts_at: Date | null; expires_at: Date | null; max_uses: number | null; use_count: number;
  reason: string; created_at: Date; activated_at: Date | null; verification_kind: string | null; verified_by: string | null;
  signature_id: string | null; revoked_at: Date | null; allows: boolean;
}

function holderOf(r: Row): { kind: GrantHolderKind; id: string } {
  // chk_grants_exactly_one_holder: exactly one of the four is set.
  if (r.worker_id) return { kind: 'WORKER', id: r.worker_id };
  if (r.agent_id) return { kind: 'AGENT', id: r.agent_id };
  if (r.user_id) return { kind: 'USER', id: r.user_id };
  return { kind: 'APP', id: r.grantee_app_id as string };
}

function view(r: Row): GrantView {
  const holder = holderOf(r);
  return {
    id: r.id, appId: r.app_id, action: r.action, values: r.action_values, holderKind: holder.kind, holderId: holder.id,
    issuerUserId: r.issuer_user_id, requestedByUserId: r.requested_by_user_id, requestedByWorkerId: r.requested_by_worker_id,
    requestedBySessionId: r.requested_by_session_id, startsAt: r.starts_at, expiresAt: r.expires_at, maxUses: r.max_uses,
    useCount: r.use_count, reason: r.reason, createdAt: r.created_at, activatedAt: r.activated_at, verificationKind: r.verification_kind,
    verifiedBy: r.verified_by, signatureId: r.signature_id, revokedAt: r.revoked_at, allows: r.allows,
  };
}

/** The scope, as the FROM/WHERE shared by the list, its count and the by-id read. */
function scope(reader: GrantReader): Prisma.Sql {
  return Prisma.sql`FROM grants g JOIN apps a ON a.id = g.app_id AND a.deleted_at IS NULL
    WHERE g.app_id = ${reader.appId}
      AND (g.worker_id = ${reader.workerId}
           OR (g.requested_by_worker_id = ${reader.workerId} AND g.activated_at IS NULL AND g.revoked_at IS NULL))`;
}

const COLUMNS = Prisma.sql`g.id, g.app_id, g.user_id, g.agent_id, g.worker_id, g.grantee_app_id, g.issuer_user_id, g.requested_by_user_id,
  g.requested_by_worker_id, g.requested_by_session_id, g.action, g.action_values, g.starts_at, g.expires_at, g.max_uses, g.use_count,
  g.reason, g.created_at, g.activated_at, g.verification_kind,
  -- #3649 slice D (cor:acl:140:08; Anne LOCAL P2-F1 on #3811): verified_by is the signer, a person; once their account is erased
  -- it reads null, as issuer_user_id does, so the sealed id is never echoed. A read-side mapping: the column is not written.
  (SELECT u.id FROM users u WHERE u.id = g.verified_by AND u.deleted_at IS NULL) AS verified_by,
  g.signature_id, g.revoked_at, ${grantLiveSql('g')} AS allows`;

/** The reader's grants, newest first. `take` 0 is count-only. The caller clamps `take` and `skip`. */
export async function listGrantsForWorker(db: Db, reader: GrantReader, page: { take?: number; skip?: number }): Promise<{ items: GrantView[]; total: number }> {
  const take = page.take ?? 20;
  const skip = page.skip ?? 0;
  const [{ n }] = await db.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`SELECT count(*) AS n ${scope(reader)}`);
  const total = Number(n);
  if (take === 0 || total === 0) return { items: [], total };
  const rows = await db.$queryRaw<Row[]>(Prisma.sql`SELECT ${COLUMNS} ${scope(reader)} ORDER BY g.created_at DESC, g.id DESC LIMIT ${take} OFFSET ${skip}`);
  return { items: rows.map(view), total };
}

const personAudience = new WeakSet<object>();
/** Mark a row as one a PERSON listed through `myGrants`. A mark on the parent object, so aliases and fragments cannot bypass it and the shared per-request status load never carries it. */
export function markPersonAudience<T extends object>(row: T): T { personAudience.add(row); return row; }
export function isPersonAudience(row: object): boolean { return personAudience.has(row); }

/** One grant by id, null when it is absent or out of scope (the same answer for both). */
export async function getGrantForWorker(db: Db, reader: GrantReader, id: string): Promise<GrantView | null> {
  const rows = await db.$queryRaw<Row[]>(Prisma.sql`SELECT ${COLUMNS} ${scope(reader)} AND g.id = ${id}`);
  return rows[0] ? view(rows[0]) : null;
}

/**
 * #3800 (cor:acl:140:05 List, ruling 0255 item 8): a PERSON's own grants. The rows naming the person DIRECTLY as holder
 * (`user_id`), in every App and Org and every state (pending, active, revoked, expired, spent), newest first. Never a row the
 * person only issued or requested for someone else, never another holder's. Membership of the App's Org is NOT a condition
 * (leaving an Org is not a departure under cor:acl:140:03). The row is ids and scalars, and each item is marked
 * ({@link markPersonAudience}) so the one nested field that reaches another tenant's person, `Grant.signatureStatus`'s
 * signature list (signer handle/URN, passkey label), is withheld from this audience (gate call, #3800 P2-2). A soft-deleted App
 * conceals its grants. No state label, as above.
 */
export async function listGrantsForPerson(db: Db, userId: string, page: { take?: number; skip?: number }): Promise<{ items: GrantView[]; total: number }> {
  const take = page.take ?? 20;
  const skip = page.skip ?? 0;
  const from = Prisma.sql`FROM grants g JOIN apps a ON a.id = g.app_id AND a.deleted_at IS NULL WHERE g.user_id = ${userId}`;
  const [{ n }] = await db.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`SELECT count(*) AS n ${from}`);
  const total = Number(n);
  if (take === 0 || total === 0) return { items: [], total };
  const rows = await db.$queryRaw<Row[]>(Prisma.sql`SELECT ${COLUMNS} ${from} ORDER BY g.created_at DESC, g.id DESC LIMIT ${take} OFFSET ${skip}`);
  return { items: rows.map((r) => markPersonAudience(view(r))), total };
}
