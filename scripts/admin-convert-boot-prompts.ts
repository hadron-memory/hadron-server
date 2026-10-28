/**
 * Host-side one-time conversion of today's boot prompts to approved boot-prompt nodes (#2676, ruling P9).
 *
 *   DATABASE_URL=postgresql://… pnpm admin:convert-boot-prompts            # dry run (default): writes nothing
 *   DATABASE_URL=postgresql://… pnpm admin:convert-boot-prompts --apply    # writes sources, approvals, pointers
 *
 * Runs as ONE operator principal against the database named by an EXPLICIT `DATABASE_URL` (the serve credential):
 * it refuses to run without one, and prints the target host and database before it does anything. Prints a JSON
 * report: converted / skipped / failed counts, every row, and every row whose rendered text will differ. Core:
 * src/admin/convert-boot-prompts.ts.
 */
import { convertBootPrompts } from '../src/admin/convert-boot-prompts.js';

const USAGE = 'Usage: DATABASE_URL=<url> pnpm admin:convert-boot-prompts [--apply]';
const args = process.argv.slice(2);
if (args.some((a) => a !== '--apply')) {
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
const apply = args.includes('--apply');
console.error(`Target database: ${target} (${apply ? 'APPLY: will write' : 'dry run: writes nothing'})`);

// The extended client (id injection), as the server itself uses; imported after the checks above.
const { db } = await import('../src/integrations/db/client.js');
try {
  const report = await convertBootPrompts(db, { apply });
  process.stdout.write(JSON.stringify({
    ...report,
    rows: report.rows.filter((r) => !(r.outcome === 'skipped' && r.reason === 'NO_PROMPT_TEXT')),
  }, null, 2) + '\n');
  if (report.failed > 0) process.exitCode = 1;
} finally {
  await db.$disconnect();
}
