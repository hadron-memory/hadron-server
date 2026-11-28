/**
 * hadron-server#5352 (hrn:node:hadronmemory.com:specs:cor:dmo:170:08, "entries from before are cleaned by migration"): migration
 * 20261127120000 removes the owner link from every entry still naming a deleted organization or an erased person, in ONE
 * trigger-permitted UPDATE, leaves a live owner's and a merged-away person's entries as they are, changes no other column, and
 * is a no-op on a re-run. Red on main: the migration does not exist.
 */
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { mergeUsers } from '../mergeConsent.js';
import { generateId } from '../../lib/id.js';

const MIGRATION = '20261127120000_credit_ledger_clear_deleted_owner_links';
const sql = () => readFileSync(new URL(`../../../prisma/migrations/${MIGRATION}/migration.sql`, import.meta.url), 'utf8');

let pg: Client;
beforeAll(async () => { pg = new Client({ connectionString: process.env.DATABASE_URL }); await pg.connect(); });
afterAll(async () => { await pg.end(); });
beforeEach(async () => { await cleanDb(db); });

const mkOrg = (name: string) => db.organization.create({ data: { id: generateId(), name, urn: name } }).then((o) => o.id);
const mkUser = (handle: string, roles: ('ADMIN' | 'READER')[] = ['READER']) =>
  db.user.create({ data: { id: generateId(), handle, roles } }).then((u) => u.id);
/** An entry written while its owner was live (the state #5340's writers never reached). */
const entry = (owner: { organizationId: string } | { ownerUserId: string }) =>
  db.creditLedgerEntry.create({
    data: { id: generateId(), ...owner, kind: 'grant', amountMicroCents: 100n, sourceType: 't5352m', sourceId: generateId(), note: 'n' },
  });

describe('migration 20261127120000: clear the links to deleted owners', () => {
  it('clears a deleted organization\'s and an erased person\'s links, keeps the rest, and is a no-op on a re-run', async () => {
    const [liveOrg, goneOrg] = [await mkOrg('m5352-live'), await mkOrg('m5352-gone')];
    const [live, gone, src, dst, admin] = [
      await mkUser('m5352-live'), await mkUser('m5352-gone'), await mkUser('m5352-src'), await mkUser('m5352-dst'), await mkUser('m5352-admin', ['ADMIN']),
    ];
    const keepOrg = await entry({ organizationId: liveOrg });
    const clearOrg = await entry({ organizationId: goneOrg });
    const keepUser = await entry({ ownerUserId: live });
    const clearUser = await entry({ ownerUserId: gone });
    // Soft deletes as before #5340: the owner row only, the ledger untouched.
    await db.organization.update({ where: { id: goneOrg }, data: { deletedAt: new Date() } });
    await db.user.update({ where: { id: gone }, data: { deletedAt: new Date() } });
    // A merged-away person's stranded entry (written after the merge, the #5014 race): the repoint's, not the migration's.
    await mergeUsers(db, { sourceUserId: src, targetUserId: dst, actorUserId: admin });
    const stranded = await entry({ ownerUserId: src });

    const before = await db.creditLedgerEntry.findMany({ orderBy: { id: 'asc' } });
    const first = await pg.query(sql());
    expect(first.rowCount).toBe(2);

    const after = new Map((await db.creditLedgerEntry.findMany()).map((r) => [r.id, r]));
    expect(after.get(clearOrg.id)).toMatchObject({ organizationId: null, ownerUserId: null });
    expect(after.get(clearUser.id)).toMatchObject({ organizationId: null, ownerUserId: null });
    expect(after.get(keepOrg.id)?.organizationId).toBe(liveOrg);
    expect(after.get(keepUser.id)?.ownerUserId).toBe(live);
    expect(after.get(stranded.id)?.ownerUserId).toBe(src);
    // Nothing but the owner link changed, on any row.
    for (const row of before) {
      expect({ ...after.get(row.id), organizationId: null, ownerUserId: null }).toEqual({ ...row, organizationId: null, ownerUserId: null });
    }

    const second = await pg.query(sql());
    expect(second.rowCount).toBe(0);
  });
});
