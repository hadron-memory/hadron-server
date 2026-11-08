/**
 * #3668 (S1a): the deploy-time upsert of the platform's actions, run by scripts/docker-start.sh after `migrate deploy`, as
 * the OWNER role (the serve role holds no write on `actions`). Idempotent; never deletes; the platform list is empty in S1a.
 *
 *   DATABASE_URL=<owner url> pnpm tsx scripts/db/upsert-actions.ts
 *
 * Exit codes: 0 ok, 1 failed, 2 no database URL. It prints counts only, never a URL or an error body.
 */
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '../../src/generated/prisma/index.js';
import { PLATFORM_ACTIONS, upsertPlatformActions, type ActionDefinition } from '../../src/lib/grants/actions.js';

export async function main(env: NodeJS.ProcessEnv, log: (line: string) => void, list: readonly ActionDefinition[] = PLATFORM_ACTIONS): Promise<number> {
  const url = env.DATABASE_URL;
  if (!url) { log('db.actions_upsert.database_url_missing'); return 2; }
  const client = new PrismaClient({ datasourceUrl: url });
  try {
    const r = await upsertPlatformActions(client, list);
    log(`db.actions_upsert inserted=${r.inserted} updated=${r.updated} unchanged=${r.unchanged}`);
    return 0;
  } catch {
    log('db.actions_upsert_failed');
    return 1;
  } finally {
    await client.$disconnect().catch(() => undefined);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.env, (line) => console.error(line));
}
