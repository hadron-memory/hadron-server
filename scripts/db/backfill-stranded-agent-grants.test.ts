/**
 * #4179 clause 1: the backfill tool. Dry run by default and writes nothing; --apply needs a register grant reference and echoes it;
 * output is counts only; a second run ends nothing. The rule and the limits live in src/lib/grants/strandedBackfill.ts.
 */
import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { Prisma } from '../../src/generated/prisma/index.js';
import { db } from '../../src/integrations/db/client.js';
import { cleanDb } from '../../src/test/helpers.js';
import { DB_NOW, dropTestActions, insertGrantUnguarded, raw, seedWorld, type World } from '../../src/lib/grants/grantFixtures3668.js';
import { main } from './backfill-stranded-agent-grants.js';

let w: World;
beforeEach(async () => { await cleanDb(db); w = await seedWorld(); });
afterAll(async () => { await cleanDb(db); await dropTestActions(); });
const departed = async (id: string) => (await db.$queryRaw<Array<{ d: boolean }>>(Prisma.sql`SELECT holder_departed_at IS NOT NULL AS d FROM grants WHERE id = ${id}`))[0]!.d;
const held = () => insertGrantUnguarded(w, { user_id: null, agent_id: w.agentId, app_id: w.appId, activated_at: raw(`${DB_NOW} - interval '1 hour'`) } as never);

describe('#4179 backfill tool', () => {
  it('the tool: dry run by default, --apply needs a register grant reference, output is counts only', async () => {
    const id = await held();
    const out: string[] = [];
    const io = { env: { DATABASE_URL: process.env.DATABASE_URL }, log: (l: string) => out.push(l) };
    expect(await main([], io)).toBe(0);
    expect(out.at(-1)).toContain('dry_run candidates=1 stamped=0');
    expect(await departed(id)).toBe(false);
    expect(await main(['--apply'], io)).toBe(2);
    expect(await main(['--apply', '--x'], io)).toBe(2);
    expect(await main([], { env: {}, log: () => undefined })).toBe(2);
    expect(await main(['--apply', 'REG-1'], io)).toBe(0);
    expect(out.at(-1)).toContain('applied grant=REG-1 candidates=1 stamped=1');
    expect(out.join('\n')).not.toContain(id);
    expect(await departed(id)).toBe(true);
  });
});
