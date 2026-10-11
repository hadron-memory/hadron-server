import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { mergeUsers } from '../../test/mergeConsent.js';
import { hasAppRelationship } from '../auth/appRelationship.js';
import { generateId } from '../id.js';
import { waitForLockWaitersOfType } from '../../test/lockWait.js';
import type { Context } from '../../api/graphql/schema/resolvers.helpers.js';
import type { CompiledAutomation } from './format.js';
import fixture from './format.fixture.json';
import { publishAutomationVersion as publish, approveAutomationVersion as approve, revokeAutomationVersion as revoke } from './versions.js';

let appId: string; let orgId: string; let ownerId: string; let adminId: string; let readerId: string;
const context = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const object = () => ({ ...structuredClone(fixture.cases[0].value), app: appId }) as CompiledAutomation;
const live = async () => ({ environment: object().environment, resolvesTool: (name: string) => name === 'hadron_read_node', resolvesCredential: (ref: string) => ref === 'known-ref' });
const publishAs = (tier: 'APP' | 'PERSON' = 'APP', runAsUserId?: string) => publish(context(ownerId), { appId, json: object(), tier, runAsUserId }, live);

beforeEach(async () => {
  await cleanDb(db);
  const users = await Promise.all(['version-owner', 'version-admin', 'version-reader'].map(handle => db.user.create({ data: { id: generateId(), handle, roles: ['READER'] } })));
  [ownerId, adminId, readerId] = users.map(u => u.id);
  const org = await db.organization.create({ data: { id: generateId(), urn: 'automation-store', name: 'Automation store' } }); orgId = org.id;
  await db.orgMember.createMany({ data: [
    { organizationId: orgId, userId: ownerId, role: 'ADMIN' },
    { organizationId: orgId, userId: adminId, role: 'ADMIN' },
    { organizationId: orgId, userId: readerId, role: 'READER' },
  ] });
  const app = await db.app.create({ data: { id: generateId(), organizationId: orgId, urn: 'hrn:app:automation-store:app', name: 'App' } }); appId = app.id;
  await db.appMember.createMany({ data: [ownerId, adminId, readerId].map(userId => ({ appId, userId, role: 'member' })) });
});

describe('immutable automation store', () => {
  it('publishes canonical pending versions with increasing numbers, unaffected by source edits', async () => {
    const first = await publishAs(); const second = await publishAs();
    expect(first.number).toBe(1); expect(second.number).toBe(2);
    expect(first.approvedAt).toBeNull(); expect(first.approvalHash).toBeNull();
    expect(first.sourceManifest).toEqual([{ nodeId: 'source-id', revision: 12 }]);
    const changed = object(); changed.nodes.entry.content = 'Changed source';
    const third = await publish(context(ownerId), { appId, json: changed, tier: 'APP' }, live);
    expect(third.versionHash).not.toBe(first.versionHash);
    expect((await db.automationVersion.findUniqueOrThrow({ where: { id: first.id } })).compiledJson).toBe(first.compiledJson);
  });
  it('allocates numbers without App row lock upgrades under simultaneous publication', async () => {
    const versions = await Promise.all([publishAs(), publishAs(), publishAs()]);
    expect(versions.map(v => v.number).sort()).toEqual([1, 2, 3]);
  });
  it('refuses non-management publishers, App keys, impersonation, stale environments and unresolved tools/refs', async () => {
    await expect(publish(context(readerId), { appId, json: object(), tier: 'APP' }, live)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    await expect(publish({ ...context(readerId), roles: ['ADMIN'] }, { appId, json: object(), tier: 'APP' }, live)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    await expect(publish({ db, appId, roles: [] }, { appId, json: object(), tier: 'APP' }, live)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    await expect(publish({ ...context(ownerId), impersonation: { sessionId: 'session', actorUserId: adminId, orgId, expiresAt: new Date() } }, { appId, json: object(), tier: 'APP' }, live)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    const drift = object(); drift.environment.budgets.tokens++;
    await expect(publish(context(ownerId), { appId, json: drift, tier: 'APP' }, live)).rejects.toMatchObject({ extensions: { code: 'AUTOMATION_ENVIRONMENT_DRIFT' } });
    for (const flow of [{ tools: ['unknown'] }, { credentials: ['not-a-reference'] }]) {
      const bad = object(); bad.nodes.entry.flow = flow;
      await expect(publish(context(ownerId), { appId, json: bad, tier: 'APP' }, live)).rejects.toThrow();
    }
    expect(await db.automationVersion.count()).toBe(0);
  });
  it('requires a live person-tier relationship and coherent tier identity', async () => {
    await db.appMember.deleteMany({ where: { appId, userId: readerId } });
    await expect(publishAs('PERSON', readerId)).rejects.toMatchObject({ extensions: { code: 'RELATIONSHIP_MISSING' } });
    await expect(publish(context(ownerId), { appId, json: object(), tier: 'APP', runAsUserId: ownerId }, live)).rejects.toMatchObject({ extensions: { code: 'AUTOMATION_TIER_MISMATCH' } });
  });
  it('enforces immutability in SQL, not just through the API', async () => {
    const v = await publishAs();
    for (const data of [{ compiledJson: '{}' }, { versionHash: '0'.repeat(64) }, { number: 9 }, { publishedBy: adminId }, { sourceManifest: [] }, { entrySourceNodeId: 'other' }, { tier: 'PERSON' as const, runAsUserId: readerId }]) {
      await expect(db.automationVersion.update({ where: { id: v.id }, data })).rejects.toThrow('immutable');
    }
    expect(await db.automationVersion.findUnique({ where: { id: v.id } })).toEqual(v);
  });
  it('pins identical production-migration and test/post-push invariant SQL', () => {
    const invariant = readFileSync(new URL('../../../prisma/automation-invariants.sql', import.meta.url), 'utf8');
    const migration = readFileSync(new URL('../../../prisma/migrations/20261007010000_automation_versions/migration.sql', import.meta.url), 'utf8');
    expect(migration.startsWith('-- CreateEnum')).toBe(true);
    expect(migration.endsWith(invariant)).toBe(true);
  });
});

describe('approval and audited revocation', () => {
  it('binds App approval to the viewed hash and preserves append-once evidence', async () => {
    const v = await publishAs();
    await expect(approve(context(adminId), v.id, 'wrong', live)).rejects.toMatchObject({ extensions: { code: 'AUTOMATION_HASH_MISMATCH' } });
    await expect(approve(context(readerId), v.id, v.versionHash, live)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    const approved = await approve(context(adminId), v.id, v.versionHash, live);
    expect(approved.approvalHash).toBe(v.versionHash); expect(approved.approvedBy).toBe(adminId);
    expect(await approve(context(ownerId), v.id, v.versionHash, live)).toEqual(approved);
    await expect(db.automationVersion.update({ where: { id: v.id }, data: { approvedBy: ownerId } })).rejects.toThrow('immutable');
  });
  it('requires the exact person to approve, including when that person is only an org reader', async () => {
    const v = await publishAs('PERSON', readerId);
    await expect(approve(context(adminId), v.id, v.versionHash, live)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    const approved = await approve(context(readerId), v.id, v.versionHash, live);
    expect(approved.approvedBy).toBe(readerId);
    expect(approved.approvalHash).toBe(approved.versionHash);
  });
  it('revalidates eligibility and environment at confirmation, leaving pending evidence on refusal', async () => {
    const v = await publishAs('PERSON', readerId);
    await db.appMember.deleteMany({ where: { appId, userId: readerId } });
    await expect(approve(context(readerId), v.id, v.versionHash, live)).rejects.toMatchObject({ extensions: { code: 'RELATIONSHIP_MISSING' } });
    const appVersion = await publishAs();
    const changedLive = async () => { const result = await live(); result.environment.ai.model = 'changed'; return result; };
    await expect(approve(context(adminId), appVersion.id, appVersion.versionHash, changedLive)).rejects.toMatchObject({ extensions: { code: 'AUTOMATION_ENVIRONMENT_DRIFT' } });
    expect((await db.automationVersion.findUniqueOrThrow({ where: { id: appVersion.id } })).approvedAt).toBeNull();
  });
  it('allows owner or App-management revocation, returns no code, and never un-revokes', async () => {
    const v = await publishAs('PERSON', readerId);
    await expect(revoke(context(adminId), v.id)).resolves.toMatchObject({ id: v.id, revokedBy: adminId });
    const receipt = await revoke(context(readerId), v.id);
    expect(Object.keys(receipt).sort()).toEqual(['id', 'revokedAt', 'revokedBy']);
    expect(receipt.revokedBy).toBe(adminId);
    await expect(approve(context(readerId), v.id, v.versionHash, live)).rejects.toMatchObject({ extensions: { code: 'AUTOMATION_VERSION_REVOKED' } });
    await expect(db.automationVersion.update({ where: { id: v.id }, data: { revokedBy: null, revokedAt: null } })).rejects.toThrow('immutable');
    const other = await publishAs();
    await expect(revoke(context(readerId), other.id)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  });
});


it('rechecks revocation after the version-row lock wait before appending approval', async () => {
  const v = await publishAs();
  let release!: () => void; let locked!: () => void;
  const gate = new Promise<void>(r => { release = r; }); const ready = new Promise<void>(r => { locked = r; });
  const holder = db.$transaction(async tx => {
    await tx.automationVersion.update({ where: { id: v.id }, data: { revokedBy: adminId, revokedAt: new Date() } });
    locked(); await gate;
  }, { timeout: 20000 });
  await ready;
  const confirmation = approve(context(ownerId), v.id, v.versionHash, live)
    .then(value => ({ value, error: null }), error => ({ value: null, error }));
  try {
    await waitForLockWaitersOfType(db, 'transactionid'); release(); await holder;
    expect((await confirmation).error).toMatchObject({ extensions: { code: 'AUTOMATION_VERSION_REVOKED' } });
    const stored = await db.automationVersion.findUniqueOrThrow({ where: { id: v.id } });
    expect(stored.approvedAt).toBeNull(); expect(stored.revokedBy).toBe(adminId);
  } finally { release(); await Promise.allSettled([holder, confirmation]); }
});


it('refuses a changed App owner scope after its anchor-row lock wait', async () => {
  const destination = await db.organization.create({ data: { id: generateId(), urn: 'automation-destination', name: 'Destination' } });
  await db.orgMember.create({ data: { organizationId: destination.id, userId: ownerId, role: 'ADMIN' } });
  let release!: () => void; let locked!: () => void;
  const gate = new Promise<void>(r => { release = r; }); const ready = new Promise<void>(r => { locked = r; });
  const holder = db.$transaction(async tx => {
    await tx.app.update({ where: { id: appId }, data: { organizationId: destination.id } }); locked(); await gate;
  }, { timeout: 20000 });
  await ready;
  const publication = publishAs().then(value => ({ value, error: null }), error => ({ value: null, error }));
  try {
    await waitForLockWaitersOfType(db, 'transactionid'); release(); await holder;
    expect((await publication).error).toMatchObject({ extensions: { code: 'FORBIDDEN' } });
    expect(await db.automationVersion.count()).toBe(0);
  } finally { release(); await Promise.allSettled([holder, publication]); }
});


it('refuses captured run identities as approval credentials', async () => {
  const v = await publishAs('PERSON', readerId);
  const run = { ...context(readerId), appId, clientId: 'run:synthetic-run' };
  await expect(approve(run, v.id, v.versionHash, live)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  expect((await db.automationVersion.findUniqueOrThrow({ where: { id: v.id } })).approvedAt).toBeNull();
  await expect(approve({ ...context(readerId), appId, clientId: `user:${readerId}` }, v.id, v.versionHash, live)).resolves.toMatchObject({ approvedBy: readerId });
});


it('keeps sealed identity evidence intact across a real user merge without blocking that merge', async () => {
  const pending = await publishAs('PERSON', ownerId);
  const confirmed = await publishAs('PERSON', ownerId);
  await approve(context(ownerId), confirmed.id, confirmed.versionHash, live);
  const revoked = await publishAs('PERSON', ownerId);
  await approve(context(ownerId), revoked.id, revoked.versionHash, live);
  await revoke(context(ownerId), revoked.id);
  const snapshots = await db.automationVersion.findMany({ where: { appId }, orderBy: { number: 'asc' } });
  expect(snapshots[2]).toMatchObject({ runAsUserId: ownerId, publishedBy: ownerId, approvedBy: ownerId, revokedBy: ownerId });
  await mergeUsers(db, { sourceUserId: ownerId, targetUserId: adminId, actorUserId: readerId });
  expect(await db.automationVersion.findMany({ where: { appId }, orderBy: { number: 'asc' } })).toEqual(snapshots);
  expect(await db.user.findUnique({ where: { id: ownerId } })).toMatchObject({ deletedAt: expect.any(Date) });
  expect(await db.user.findUnique({ where: { id: adminId } })).toMatchObject({ deletedAt: null });
  expect(await hasAppRelationship(db, appId, ownerId)).toBe(false);
  await expect(approve(context(adminId), pending.id, pending.versionHash, live)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
  await expect(approve(context(ownerId), pending.id, pending.versionHash, live)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
});


it('behaviorally enforces consent-shape CHECK clauses independently of the SQL copy pin', async () => {
  const v = await publishAs();
  for (const data of [
    { approvedBy: ownerId },
    { approvedBy: ownerId, approvedAt: new Date(), approvalHash: '0'.repeat(64) },
    { revokedBy: ownerId },
  ]) {
    await expect(db.automationVersion.update({ where: { id: v.id }, data })).rejects.toThrow();
    expect(await db.automationVersion.findUnique({ where: { id: v.id } })).toEqual(v);
  }
});
