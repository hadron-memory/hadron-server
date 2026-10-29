/**
 * Host-side audit and migration of the legacy boot-prompt tokens `{{name}}` / `{{role}}` to `{{worker.name}}` /
 * `{{worker.role}}` (#2704, ruling B7).
 *
 *   DATABASE_URL=postgresql://… pnpm admin:migrate-boot-prompt-variables --audit   # read-only: ids and counts
 *   DATABASE_URL=postgresql://… pnpm admin:migrate-boot-prompt-variables           # dry run (default): writes nothing
 *   DATABASE_URL=postgresql://… pnpm admin:migrate-boot-prompt-variables --apply   # rewrites, recompiles, approves
 *
 * Runs as ONE operator principal (the same seam as the #2676 conversion) against the database named by an EXPLICIT
 * `DATABASE_URL` (the serve credential): it refuses to run without one and prints the target host and database before
 * it does anything. Prints a JSON report, never prompt text. Core: src/admin/migrate-boot-prompt-variables.ts.
 */
import { auditBootPromptTokens, migrateBootPromptVariables } from '../src/admin/migrate-boot-prompt-variables.js';

const USAGE = 'Usage: DATABASE_URL=<url> pnpm admin:migrate-boot-prompt-variables [--audit | --apply]';
const args = process.argv.slice(2);
if (args.some((a) => a !== '--apply' && a !== '--audit') || args.length > 1) {
  console.error(USAGE);
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error(`DATABASE_URL is not set: this script refuses to run without an explicit target.\n${USAGE}`);
  process.exit(2);
}
let target: string;
try {
  const u = new URL(url);
  target = `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
} catch {
  console.error('DATABASE_URL is not a valid URL.');
  process.exit(2);
}
const audit = args.includes('--audit');
const apply = args.includes('--apply');
console.error(`Target database: ${target} (${audit ? 'audit: read-only' : apply ? 'APPLY: will write' : 'dry run: writes nothing'})`);

// The extended client (id injection), as the server itself uses; imported after the checks above.
const { db } = await import('../src/integrations/db/client.js');
try {
  if (audit) {
    process.stdout.write(JSON.stringify(await auditBootPromptTokens(db), null, 2) + '\n');
  } else {
    const report = await migrateBootPromptVariables(db, { apply });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (report.failed > 0) process.exitCode = 1;
  }
} finally {
  await db.$disconnect();
}
