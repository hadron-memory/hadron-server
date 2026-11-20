/**
 * #4003 (S8 of #3991; R21, open question 25 ruled R4): the restore runbook's step "The restore runbook ends every live
 * read client after any restore" (hrn:node:hadronmemory.com:specs:cor:sec:010:03; Holger's ruling 5A: the restored system
 * serves no read before this step has run, and a restore whose step failed stays closed. The runbook keeps reads closed by
 * ORDER: the server is stopped before the restore and starts only after a successful `--apply`). A restore brings back read clients that were revoked, or whose budget was spent,
 * after the backup was taken; this ends every one of them before the restored database serves reads again.
 *
 * Ops-script only (`scripts/db/end-secret-read-clients.ts`, run as the owner under a register grant; Bill's conditions,
 * team chat #121979): there is no GraphQL, CLI or MCP surface, as for the rotation tools (Victor under ruling 0265).
 *
 * - DRY RUN by default: counts the grants it would end and writes nothing. `apply` ends them.
 * - Ends the grants of every read-client action in {@link READ_CLIENT_GRANT_ACTIONS}, the one list (today
 *   `secret.reveal` only), pending or active, through {@link endGrant}: the one shared writer, which locks each row first, lets the first end stand (an
 *   already revoked, departed, expired or spent grant is left alone, with no second event), stamps `revoked_at` with
 *   `revoked_by` (the pair the one-revoke rule requires) and writes one `REVOKE` grant event naming the operator.
 * - `revokedBy` must name an existing, non-erased user: the operator who ran it, recorded as the revoker. An unknown
 *   or erased one refuses before anything is read or written.
 * - One transaction for the whole run, rows locked in id order. A second run ends nothing.
 * - The result carries counts only: no grant, client or secret id, and no value.
 */
import { Prisma, type PrismaClient } from '../../generated/prisma/index.js';
import { endGrant } from '../grants/manage.js';
import { grantStateSql } from '../grants/state.js';

/**
 * Every grant action a read client is issued under: the ONE place the restore step reads them from. Today only
 * `secret.reveal` (S3, #3998). S5 (#4000) adds `secret.use` here when it builds use by reference, so the restore step
 * ends those clients too (cor:sec:010:03 says every live read client).
 */
export const READ_CLIENT_GRANT_ACTIONS: readonly string[] = ['secret.reveal'];

/** The operator named as the revoker does not exist or was erased. Fixed text: the id is never echoed. */
export class UnknownRevokerError extends Error {
  constructor() {
    super('--revoked-by must name an existing user.');
    this.name = 'UnknownRevokerError';
  }
}

export interface EndReadClientsResult {
  /** False for a dry run. */
  applied: boolean;
  /** Unended read-client grants of live Apps that are not expired or spent: what a run would end. */
  candidates: number;
  /** Grants THIS run ended (0 for a dry run). */
  ended: number;
}

/** End every live read client (see the module comment). Throws {@link UnknownRevokerError} before any write. */
export async function endLiveSecretReadClients(
  db: PrismaClient,
  opts: { revokedBy: string; apply: boolean },
): Promise<EndReadClientsResult> {
  return db.$transaction(async (tx) => {
    const revoker = await tx.user.findUnique({ where: { id: opts.revokedBy }, select: { deletedAt: true } });
    if (!revoker || revoker.deletedAt) throw new UnknownRevokerError();
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT g.id FROM grants g
      JOIN apps a ON a.id = g.app_id AND a.deleted_at IS NULL
      WHERE g.action IN (${Prisma.join(READ_CLIENT_GRANT_ACTIONS)}) AND g.revoked_at IS NULL AND g.holder_departed_at IS NULL
        AND ${grantStateSql('g')} NOT IN ('EXPIRED', 'SPENT')
      ORDER BY g.id`);
    if (!opts.apply) return { applied: false, candidates: rows.length, ended: 0 };
    let ended = 0;
    for (const { id } of rows) {
      const r = await endGrant(tx, id, { userId: opts.revokedBy, workerId: null, sessionId: null }, {
        kind: 'revoke',
        authorize: () => undefined, // the authority is the owner credential and the register grant, not an App role
      });
      if (r.changed) ended++;
    }
    return { applied: true, candidates: rows.length, ended };
  }, { timeout: 120_000 });
}
