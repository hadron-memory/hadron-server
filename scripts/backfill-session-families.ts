/** #1931: pnpm tsx scripts/backfill-session-families.ts mapping.json [--apply]
 * Operator mapping: [{"workerId":"<exact worker id>","family":"glm"}, ...].
 * Preview by default; --apply writes. Runs against DATABASE_URL, after deployment.
 * Outputs exact candidate session ids for verification. Never overwrites known families
 * and never changes session heartbeats, tool hosts, or bindings.
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '../src/generated/prisma/index.js';
import { backfillSessionFamilies, type FamilyMapping } from '../src/lib/agentTasks/familyBackfill.js';
const args = process.argv.slice(2);
if (args.length < 1 || args.length > 2 || (args[1] && args[1] !== '--apply')) throw new Error('Usage: backfill-session-families.ts mapping.json [--apply]');
const parsed: unknown = JSON.parse(readFileSync(args[0], 'utf8'));
if (!Array.isArray(parsed) || !parsed.every(r => r && typeof r.workerId === 'string' && typeof r.family === 'string')) throw new Error('Expected an array of workerId/family mappings.');
const db = new PrismaClient();
try {
  const rows = await backfillSessionFamilies(db, parsed as FamilyMapping[], args[1] === '--apply');
  process.stdout.write(JSON.stringify({ applied: args[1] === '--apply', rows }, null, 2) + '\n');
} finally {
  await db.$disconnect();
}
