/**
 * Spec 048 Phase B — one-shot migration retiring the auto-personal ("shadow")
 * orgs. Re-homes each clean scaffold org's Agent/App/Memory to the OWNER user
 * (collision-safe URN re-root) and deletes the org; skips + reports anything
 * that isn't a clean scaffold. See src/lib/personalOrgRetirement/.
 *
 *   pnpm admin:retire-personal-orgs             # DRY RUN (default; writes nothing)
 *   pnpm admin:retire-personal-orgs --apply     # apply
 *   pnpm admin:retire-personal-orgs --apply --org <id> [--org <id> …]
 *
 * Idempotent — a re-run finds no `isVisible !== true` orgs left. Runs against
 * DATABASE_URL. Intended for the quiet window (no signups in flight).
 */
import { PrismaClient } from '../src/generated/prisma/index.js';
import {
  retirePersonalOrgs,
  type OrgRetirementReport,
} from '../src/lib/personalOrgRetirement/retirePersonalOrgs.js';

const apply = process.argv.includes('--apply');
const orgIds: string[] = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--org' && process.argv[i + 1]) orgIds.push(process.argv[i + 1]);
}

const db = new PrismaClient();

/** Print one org's outcome as a single readable line (+ detail lines). */
function printReport(r: OrgRetirementReport): void {
  const homed =
    r.reHomed.agents.length + r.reHomed.apps.length + r.reHomed.memories.length;
  if (r.action === 'skipped') {
    console.log(`  SKIP  ${r.orgUrn} (${r.orgId}) — ${r.skipReason}`);
    if (r.sideData) {
      for (const [table, count] of Object.entries(r.sideData)) {
        console.log(`          · ${table}: ${count}`);
      }
    }
    return;
  }
  const verb = r.action === 'retired' ? 'RETIRED' : 'WOULD RETIRE';
  console.log(`  ${verb}  ${r.orgUrn} → @${r.ownerHandle} (${homed} entities re-homed)`);
  for (const kind of ['agents', 'apps', 'memories'] as const) {
    for (const h of r.reHomed[kind]) console.log(`          · ${h.from}  →  ${h.to}`);
  }
}

async function main(): Promise<void> {
  console.log(
    apply
      ? 'Retire personal orgs — APPLYING…\n'
      : 'Retire personal orgs — DRY RUN (no writes; pass --apply to write)\n',
  );
  const reports = await retirePersonalOrgs(db, {
    dryRun: !apply,
    ...(orgIds.length ? { orgIds } : {}),
  });

  for (const r of reports) printReport(r);

  const retired = reports.filter((r) => r.action === 'retired' || r.action === 'would-retire').length;
  const skipped = reports.filter((r) => r.action === 'skipped').length;
  console.log(
    `\nTotal: ${reports.length} candidate org(s) — ${retired} ${apply ? 'retired' : 'would retire'}, ${skipped} skipped.`,
  );
  if (skipped > 0) {
    console.log('Skipped orgs were left untouched for manual handling (see reasons above).');
  }
}

main()
  .catch((err) => {
    console.error('Retire personal orgs failed:', err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
