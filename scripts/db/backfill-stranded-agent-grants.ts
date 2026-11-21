/**
 * #4179 clause 1 — the one-off backfill that ends the agent grants stranded before #4172 shipped (what it ends and the limits it
 * states: src/lib/grants/strandedBackfill.ts; rule: cor:acl:140:03, Holger R2).
 *
 *   DATABASE_URL=<owner url> pnpm tsx scripts/db/backfill-stranded-agent-grants.ts                     # dry run, writes nothing
 *   DATABASE_URL=<owner url> pnpm tsx scripts/db/backfill-stranded-agent-grants.ts --apply <register grant ref>
 *
 * Run as the OWNER under its own register grant, never on the strength of this file or the PR that adds it (CLAUDE.md,
 * "Production database"; the issue names the production run and its catalog-and-count read as separate grants). `--apply` therefore
 * needs the grant's reference as its argument and echoes it; the script cannot verify it, it makes running without one a
 * deliberate act. Output is counts only, never an id. A second run ends nothing (the first end stands).
 *
 * Exit codes: 0 ok (dry run or applied), 1 failed (a failed batch leaves earlier batches committed: re-run), 2 usage.
 */
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '../../src/generated/prisma/index.js';
import { backfillStrandedAgentGrants } from '../../src/lib/grants/strandedBackfill.js';

const TAG = 'db.stranded_agent_grants_backfill';

export interface BackfillToolIo { env: NodeJS.ProcessEnv; log: (line: string) => void }

export async function main(argv: readonly string[], io: BackfillToolIo): Promise<number> {
  const apply = argv[0] === '--apply';
  const ref = argv[1];
  if (!(argv.length === 0 || (apply && argv.length === 2 && ref && !ref.startsWith('--')))) {
    io.log(`${TAG}.usage: [--apply <register grant ref>]`);
    return 2;
  }
  if (!io.env.DATABASE_URL) {
    io.log(`${TAG}.database_url_missing`);
    return 2;
  }
  const db = new PrismaClient({ datasourceUrl: io.env.DATABASE_URL });
  try {
    const r = await backfillStrandedAgentGrants(db, { apply });
    io.log(`${TAG} ${r.applied ? `applied grant=${ref}` : 'dry_run'} candidates=${r.candidates} stamped=${r.stamped} `
      + `behind_dated_licence_revocation=${r.behindDatedLicenceRevocation} skipped_installed=${r.skippedInstalled}`
      + (r.applied ? '' : ' (pass --apply <register grant ref> to end them)'));
    return 0;
  } catch {
    io.log(`${TAG}.failed`);
    return 1;
  } finally {
    await db.$disconnect().catch(() => undefined);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2), { env: process.env, log: (line) => console.error(line) });
}
