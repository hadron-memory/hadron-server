/**
 * #949 — audit (and optionally repair) Agents whose class='system' memory is
 * owned by a different tenant than the Agent itself.
 *
 *   pnpm admin:audit-system-memory            # report only (default)
 *   pnpm admin:audit-system-memory --apply    # re-own every mismatched memory
 *   pnpm admin:audit-system-memory --apply --agent <agentId>   # just this one
 *
 * Report-only by default because the repair MOVES a memory row out of the org
 * that currently holds it — read it first, then apply. Idempotent and
 * resumable: a consistent pair is a no-op. Runs against DATABASE_URL.
 *
 * The same repair is available as the platform-admin GraphQL mutation
 * `repairAgentSystemMemory(agentRef:)`; this script is the fleet-wide sweep.
 */
import { PrismaClient } from '../src/generated/prisma/index.js';
import {
  findSystemMemoryOwnerMismatches,
  repairAgentSystemMemoryOwner,
  describeOwner,
} from '../src/lib/agentSystemMemory.js';

const apply = process.argv.includes('--apply');
const agentFlag = process.argv.indexOf('--agent');
const onlyAgentId = agentFlag !== -1 ? process.argv[agentFlag + 1] : null;
const db = new PrismaClient();

async function main(): Promise<void> {
  const all = await findSystemMemoryOwnerMismatches(db);
  const rows = onlyAgentId ? all.filter((r) => r.agentId === onlyAgentId) : all;

  if (rows.length === 0) {
    console.log(
      onlyAgentId
        ? `No owner mismatch for agent ${onlyAgentId} (checked ${all.length} mismatched agent(s) fleet-wide).`
        : 'No Agent/system-memory owner mismatches found.',
    );
    return;
  }

  console.log(`${rows.length} Agent(s) with a foreign-owned system memory:\n`);
  for (const r of rows) {
    console.log(`  ${r.agentUrn} (${r.agentId})`);
    console.log(`    agent  owner: ${describeOwner({ organizationId: r.agentOrganizationId, ownerUserId: r.agentOwnerUserId })}`);
    console.log(`    memory owner: ${describeOwner({ organizationId: r.memoryOrganizationId, ownerUserId: r.memoryOwnerUserId })}  urn=${r.memoryUrn} (${r.memoryId})`);
  }

  if (!apply) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to re-own these memories.');
    return;
  }

  console.log('\nApplying…');
  let repaired = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      const result = await repairAgentSystemMemoryOwner(db, r.agentId);
      repaired += result.changed ? 1 : 0;
      console.log(
        `  ${result.changed ? 'repaired' : 'unchanged'} ${r.agentUrn} → owner ${result.owner}, urn ${result.urn}` +
          (result.urnNote ? `\n    NOTE: ${result.urnNote}` : ''),
      );
    } catch (err) {
      failed += 1;
      console.error(`  FAILED ${r.agentUrn}:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`\nTotal: ${repaired} repaired, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('system-memory audit failed:', err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
