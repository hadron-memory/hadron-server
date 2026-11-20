/**
 * #4003 (S8 of #3991; R21) — the restore runbook's step "end every live read client after any restore". A restore
 * brings back read clients that had been revoked, or whose read budget was spent, after the backup was taken.
 *
 *   DATABASE_URL=<owner url> pnpm tsx scripts/db/end-secret-read-clients.ts --revoked-by <operator user id>           # dry run
 *   DATABASE_URL=<owner url> pnpm tsx scripts/db/end-secret-read-clients.ts --revoked-by <operator user id> --apply
 *
 * Run as the OWNER under a register grant, never on the strength of this file or the PR that adds it (CLAUDE.md,
 * "Production database"). Ops-script only: no GraphQL, CLI or MCP surface (Bill's conditions, team chat #121979).
 * Without `--apply` it counts and writes nothing. With it, one transaction ends every pending or active
 * `secret.reveal` grant of a live App through the shared `endGrant` (revoked_at with revoked_by, one REVOKE grant
 * event each, the first end stands), so a second run ends nothing. `--revoked-by` must name an existing, non-erased
 * user: the operator, recorded as the revoker. Output is counts only, never an id or a value. Runbook:
 * hrn:node:hadronmemory.com:dev:ops:alpha:app-secrets-key-rotation (D. Restore).
 *
 * Exit codes: 0 ok (dry run or applied), 1 refused (unknown revoker) or failed, nothing written; 2 usage.
 */
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '../../src/generated/prisma/index.js';
import { endLiveSecretReadClients, UnknownRevokerError } from '../../src/lib/secrets/endReadClients.js';

const TAG = 'db.secret_read_clients_end';

export interface EndReadClientsToolIo {
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
}

export async function main(argv: readonly string[], io: EndReadClientsToolIo): Promise<number> {
  const apply = argv.length === 3 && argv[2] === '--apply';
  if ((argv.length !== 2 && !apply) || argv[0] !== '--revoked-by' || !argv[1] || argv[1].startsWith('--')) {
    io.log(`${TAG}.usage: --revoked-by <operator user id> [--apply]`);
    return 2;
  }
  if (!io.env.DATABASE_URL) {
    io.log(`${TAG}.database_url_missing`);
    return 2;
  }
  const db = new PrismaClient({ datasourceUrl: io.env.DATABASE_URL });
  try {
    const r = await endLiveSecretReadClients(db, { revokedBy: argv[1], apply });
    io.log(r.applied
      ? `${TAG} ok candidates=${r.candidates} ended=${r.ended}`
      : `${TAG} dry_run candidates=${r.candidates} (pass --apply to end them)`);
    return 0;
  } catch (e) {
    io.log(e instanceof UnknownRevokerError ? `${TAG}.refused: --revoked-by must name an existing user; nothing was written` : `${TAG}.failed`);
    return 1;
  } finally {
    await db.$disconnect().catch(() => undefined);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2), { env: process.env, log: (line) => console.error(line) });
}
