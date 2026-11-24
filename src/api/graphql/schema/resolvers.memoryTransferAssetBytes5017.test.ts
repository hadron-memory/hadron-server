/**
 * #5017 (Billing A10): a transfer carries the memory's live files to the receiving owner, so their bytes must fit that owner's
 * `assetBytes` cap. A refusal changes nothing; a BLOCKED, soft-deleted or no-file memory moves freely. Red on main: the transfer applies.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { generateId } from '../../../lib/id.js';
import { cleanDb } from '../../../test/helpers.js';
import { reloadOwnerDefaultLimitsForTests } from '../../../lib/ownerLimits/defaults.js';
import { resolvers, type Context } from './resolvers.js';

const KB = 1024;
const CAP = 1_048_576;
const limits = (value: unknown) => reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: JSON.stringify(value) });
const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });

let owner: { id: string };
let org: { id: string };
let source: { id: string };
let orgMemory: { id: string };

const asset = (memoryId: string, sizeBytes: number, over: Record<string, unknown> = {}) =>
  db.asset.create({
    data: { id: generateId(), memoryId, filename: 'f.pdf', mimeType: 'application/pdf', sizeBytes, storageKey: `k/${generateId()}.pdf`, scanStatus: 'CLEAN', ...over } as never,
  });
const transfer = () => resolvers.Mutation.transferMemoryOwnership(null, { memoryRef: source.id, orgRef: org.id, targetClass: 'knowledge' } as never, ctx(owner.id));
const settle = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { extensions?: Record<string, unknown>; message: string });

beforeEach(async () => {
  await cleanDb(db);
  limits({});
  owner = await db.user.create({ data: { id: generateId(), githubId: 501751, githubUsername: 'ab-xfer-owner', handle: 'ab-xfer-owner', roles: ['READER'] } });
  org = await db.organization.create({ data: { id: generateId(), name: 'Xfer Org', urn: 'ab-xfer-org' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: owner.id, role: 'ADMIN' } });
  source = await db.memory.create({ data: { id: generateId(), ownerUserId: owner.id, userId: owner.id, urn: 'ab-xfer-owner:files', name: 'Files', class: 'private' } });
  orgMemory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: 'ab-xfer-org:held', name: 'Held', class: 'knowledge', visibility: 'ORGANIZATION' } });
});
afterEach(() => { reloadOwnerDefaultLimitsForTests({ OWNER_DEFAULT_LIMITS: '' }); });

describe('#5017 transferMemoryOwnership and the receiving owner\'s assetBytes cap', () => {
  it('refuses a transfer whose live files would take the receiving organization over the cap, and changes nothing', async () => {
    limits({ organization: { assetBytes: CAP } });
    await asset(orgMemory.id, 600 * KB); // already held by the organization
    await asset(source.id, 600 * KB);    // the files the transfer would bring
    const refused = await settle(transfer());
    expect(refused).toMatchObject({ extensions: { code: 'OWNER_LIMIT_REACHED', limitKey: 'assetBytes', ownerType: 'organization' } });
    const after = await db.memory.findUniqueOrThrow({ where: { id: source.id } });
    expect(after).toMatchObject({ ownerUserId: owner.id, organizationId: null, urn: 'ab-xfer-owner:files', class: 'private' });
    expect(await db.asset.count({ where: { memoryId: source.id } })).toBe(1);
  });

  it('applies when the files fit; a BLOCKED, a soft-deleted and no file at all are not counted', async () => {
    limits({ organization: { assetBytes: CAP } });
    await asset(orgMemory.id, 600 * KB);
    await asset(source.id, 900 * KB, { scanStatus: 'BLOCKED' });
    await asset(source.id, 900 * KB, { deletedAt: new Date() });
    await expect(transfer()).resolves.toMatchObject({ applied: true });
    expect((await db.memory.findUniqueOrThrow({ where: { id: source.id } })).organizationId).toBe(org.id);
  });

  it('with the variable unset, or the cap raised, the same transfer applies', async () => {
    await asset(orgMemory.id, 600 * KB);
    await asset(source.id, 600 * KB);
    await expect(transfer()).resolves.toMatchObject({ applied: true });
  });
});
