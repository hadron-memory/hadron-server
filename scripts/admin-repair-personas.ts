/**
 * #950 — fix persona Agents minted with PERSONAL visibility and the role
 * node's own description.
 *
 *   pnpm admin:repair-personas            # report the plan (default)
 *   pnpm admin:repair-personas --apply    # write it
 *
 * Report-only by default. Idempotent: an already-correct persona produces no
 * plan. The description rewrite only fires where the persona's description is
 * still a verbatim copy of the role node's — a hand-edited one is left alone.
 * Runs against DATABASE_URL.
 */
import { PrismaClient } from '../src/generated/prisma/index.js';
import { planPersonaRepairs, applyPersonaRepairs } from '../src/lib/teamPersonaRepair.js';

const apply = process.argv.includes('--apply');
const db = new PrismaClient();

async function main(): Promise<void> {
  const plans = await planPersonaRepairs(db);
  const actionable = plans.filter((p) => p.visibility || p.description);

  if (plans.length === 0) {
    console.log('No persona Agents need repair.');
    return;
  }

  for (const p of plans) {
    console.log(`\n  ${p.agentUrn} (role ${p.personaRole})`);
    if (p.visibility) console.log(`    visibility:  ${p.visibility.from} → ${p.visibility.to}`);
    if (p.description) {
      console.log(`    description: ${JSON.stringify(p.description.from)}`);
      console.log(`              →  ${JSON.stringify(p.description.to)}`);
    }
    if (p.note) console.log(`    note: ${p.note}`);
  }

  if (!apply) {
    console.log(
      `\nDRY RUN — nothing written. ${actionable.length} agent(s) would change. Re-run with --apply.`,
    );
    return;
  }
  const written = await applyPersonaRepairs(db, plans);
  console.log(`\nApplied: ${written} agent(s) updated.`);
}

main()
  .catch((err) => {
    console.error('persona repair failed:', err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
