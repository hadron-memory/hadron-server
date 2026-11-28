/**
 * hadron-server#5302 (hrn:node:hadronmemory.com:specs:cor:dmo:170:08, Victor's reading "requires", gate 7204592331): when the
 * billable account is deleted, its credit ledger entries are kept "with the link to the deleted owner removed". The organization
 * delete (`deleteOrganization` and `deleteUserAccount`'s sole-member-org branch, both through `softDeleteOrganizationCore`) and
 * the person delete / erasure (`deleteUserAccount`) clear `organization_id` / `owner_user_id` on that owner's entries in the
 * deleting transaction; nothing else on an entry changes. A merge is not a deletion: it re-points and never clears (#5014).
 *
 * Red on main: neither writer touches the ledger, so after either delete the entries still name the deleted owner.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { mergeUsers } from '../../test/mergeConsent.js';
import { generateId } from '../../lib/id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { deleteUserAccount } from './deleteUser.js';

vi.mock('../../lib/slackClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/slackClient.js')>()),
  deleteSlackToolConnection: vi.fn().mockResolvedValue(true),
}));
vi.mock('../../lib/telegramClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/telegramClient.js')>()),
  deleteTelegramToolConnection: vi.fn().mockResolvedValue(true),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const M = resolvers.Mutation as any;
const ctx = (userId: string, roles: string[] = ['READER']): Context => ({ db, roles, userId }) as unknown as Context;

let platform: string, p: string, q: string;
let org: string, otherOrg: string;
const mkUser = (handle: string, roles: ('ADMIN' | 'READER')[] = ['READER']) =>
  db.user.create({ data: { id: generateId(), handle, roles } }).then((u) => u.id);
const mkOrg = (name: string) => db.organization.create({ data: { id: generateId(), name, urn: name } }).then((o) => o.id);

/** Two entries per owner (a grant and an adjustment), so "nothing else changes" is checked on both kinds. */
async function entriesFor(owner: { organizationId: string } | { ownerUserId: string }) {
  const base = { ...owner, sourceType: 't5302', note: null };
  return Promise.all([
    db.creditLedgerEntry.create({
      data: { id: generateId(), ...base, kind: 'grant', amountMicroCents: 500n, sourceId: generateId(), expiresAt: new Date(Date.now() + 86_400_000) },
    }),
    db.creditLedgerEntry.create({
      data: { id: generateId(), ...base, kind: 'adjustment', amountMicroCents: -120n, sourceId: generateId(), note: 'refund' },
    }),
  ]);
}

type Row = Awaited<ReturnType<typeof entriesFor>>[number];
/** The entries exist, name nobody, and every other column is as it was written. */
async function expectKeptWithoutOwner(before: Row[]) {
  const after = await db.creditLedgerEntry.findMany({ where: { id: { in: before.map((r) => r.id) } }, orderBy: { id: 'asc' } });
  expect(after).toHaveLength(before.length);
  const sorted = [...before].sort((a, b) => (a.id < b.id ? -1 : 1));
  after.forEach((row, i) => {
    expect(row.organizationId).toBeNull();
    expect(row.ownerUserId).toBeNull();
    expect({ ...row, organizationId: null, ownerUserId: null }).toEqual({ ...sorted[i]!, organizationId: null, ownerUserId: null });
  });
}

beforeEach(async () => {
  await cleanDb(db);
  platform = await mkUser('lc-platform', ['ADMIN']);
  p = await mkUser('lc-p');
  q = await mkUser('lc-q');
  org = await mkOrg('lc-org');
  otherOrg = await mkOrg('lc-other');
});

describe('S2: an organization is deleted', () => {
  it('its entries still exist and no longer name it; another organization\'s entries keep theirs', async () => {
    const mine = await entriesFor({ organizationId: org });
    const theirs = await entriesFor({ organizationId: otherOrg });
    await expect(M.deleteOrganization({}, { ref: org }, ctx(platform, ['ADMIN']))).resolves.toBe(true);
    await expectKeptWithoutOwner(mine);
    expect(await db.creditLedgerEntry.count({ where: { id: { in: theirs.map((r) => r.id) }, organizationId: otherOrg } })).toBe(2);
  });
});

describe('a person is deleted (erasure)', () => {
  it('their entries are kept without the person; another person\'s entries keep theirs', async () => {
    const mine = await entriesFor({ ownerUserId: p });
    const theirs = await entriesFor({ ownerUserId: q });
    await deleteUserAccount(db, { targetUserId: p, actorUserId: p });
    await expectKeptWithoutOwner(mine);
    expect(await db.creditLedgerEntry.count({ where: { id: { in: theirs.map((r) => r.id) }, ownerUserId: q } })).toBe(2);
  });

  it('a platform admin\'s erasure of another person does the same', async () => {
    const mine = await entriesFor({ ownerUserId: p });
    await deleteUserAccount(db, { targetUserId: p, actorUserId: platform, reason: 'test 5302' });
    await expectKeptWithoutOwner(mine);
  });
});

describe('the sole-member-org branch of a person delete', () => {
  it('the organization that dies with the account no longer names itself on its entries, nor does the person', async () => {
    await db.orgMember.create({ data: { id: generateId(), organizationId: org, userId: p, role: 'OWNER' } });
    const orgRows = await entriesFor({ organizationId: org });
    const personRows = await entriesFor({ ownerUserId: p });
    await deleteUserAccount(db, { targetUserId: p, actorUserId: p });
    expect((await db.organization.findUniqueOrThrow({ where: { id: org } })).deletedAt).not.toBeNull();
    await expectKeptWithoutOwner(orgRows);
    await expectKeptWithoutOwner(personRows);
  });

  it('an organization the person shares with another member is not deleted and keeps its entries\' link', async () => {
    await db.orgMember.create({ data: { id: generateId(), organizationId: org, userId: p, role: 'ADMIN' } });
    await db.orgMember.create({ data: { id: generateId(), organizationId: org, userId: q, role: 'OWNER' } });
    const orgRows = await entriesFor({ organizationId: org });
    await deleteUserAccount(db, { targetUserId: p, actorUserId: p });
    expect(await db.creditLedgerEntry.count({ where: { id: { in: orgRows.map((r) => r.id) }, organizationId: org } })).toBe(2);
  });
});

describe('a merge is not a deletion (#5014)', () => {
  it('the merged-away person\'s entries move to the survivor and are never cleared', async () => {
    const rows = await entriesFor({ ownerUserId: p });
    await mergeUsers(db, { sourceUserId: p, targetUserId: q, actorUserId: platform });
    const after = await db.creditLedgerEntry.findMany({ where: { id: { in: rows.map((r) => r.id) } } });
    expect(after.map((r) => r.ownerUserId)).toEqual([q, q]);
  });
});
