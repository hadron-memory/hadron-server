/**
 * #4162 (BLIND P1, Gabriel; coordinator ask): a grant whose activation time is still in the future covers nothing, through BOTH doors.
 * The old boot-prompt door filtered `activated_at <= now`; the shared check must keep it, so a future-dated row never goes live early.
 * The database guard stamps the database clock at activation, so no shipped path makes such a row; these rows are built unguarded to
 * pin the check itself (defence in depth), with a clock-now control beside each.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
import { DB_NOW, dropTestActions, insertGrantUnguarded, raw, type World } from './grantFixtures3668.js';
import { seedTriggerWorld, type TriggerWorld } from './triggerGrantFixtures3483.js';
import { upsertPlatformActions } from './actions.js';
import { findAdmittingGrant } from './triggerGrant.js';
import { hasUsableEditGrant, spendEditGrant } from './bootPromptGrant.js';
import { coverableAction, findCoveringGrants } from './cover.js';
vi.mock('../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

afterAll(async () => { await cleanDb(db); await dropTestActions(); });

const FUTURE = raw(`${DB_NOW} + interval '1 hour'`);
const NOW = raw(DB_NOW);
const active = (activatedAt: unknown) => ({ activated_at: activatedAt, verification_kind: 'passkey', max_uses: 1 });

describe('trigger door: a future-dated activation admits nothing', () => {
  let w: TriggerWorld;
  beforeEach(async () => { await cleanDb(db); w = await seedTriggerWorld(); });
  const admit = () => findAdmittingGrant(db, {
    appId: w.appId, action: 'schedule.create', entryNodeId: w.entryNodeId, actor: { workerId: w.workerId, sessionId: w.sessionId, hostLaunched: false }, lock: false });
  const mk = (activatedAt: unknown) => insertGrantUnguarded(w as unknown as World, {
    user_id: null, worker_id: w.workerId, action: 'schedule.create', action_values: { entryNode: w.entryNodeId }, verified_by: w.userId, issuer_user_id: w.userId, ...active(activatedAt) } as never);
  it('the grant activated at the database clock admits; the same grant activated an hour from now does not', async () => {
    const future = await mk(FUTURE);
    expect(await admit()).toBeNull();
    const now = await mk(NOW);
    expect(await admit()).toBe(now);
    expect(future).not.toBe(now);
  });
  it('a FUTURE starts_at admits nothing either, and a past one does (Rook P3: grantLiveSql judges it for this door)', async () => {
    const early = await insertGrantUnguarded(w as unknown as World, {
      user_id: null, worker_id: w.workerId, action: 'schedule.create', action_values: { entryNode: w.entryNodeId }, verified_by: w.userId, issuer_user_id: w.userId,
      starts_at: FUTURE, ...active(NOW) } as never);
    expect(await admit()).toBeNull();
    const started = await insertGrantUnguarded(w as unknown as World, {
      user_id: null, worker_id: w.workerId, action: 'schedule.create', action_values: { entryNode: w.entryNodeId }, verified_by: w.userId, issuer_user_id: w.userId,
      starts_at: raw(`${DB_NOW} - interval '1 minute'`), ...active(NOW) } as never);
    expect(await admit()).toBe(started);
    expect(early).not.toBe(started);
  });
  it('the shared check itself returns nothing for it, for either lock mode', async () => {
    await mk(FUTURE);
    for (const lock of [undefined, 'SHARE', 'UPDATE'] as const) {
      expect(await db.$transaction((tx) => findCoveringGrants(tx, { appId: w.appId, action: coverableAction('schedule.create'), workerId: w.workerId, roleAgentId: w.agentId,
        values: { entryNode: w.entryNodeId }, order: 'CAPPED_FIRST', lock })), String(lock)).toEqual([]);
    }
  });
});

describe('boot-prompt door: a future-dated activation admits nothing', () => {
  let appId: string; let workerId: string; let installMemoryId: string; let adminId: string;
  beforeEach(async () => {
    await cleanDb(db);
    await upsertPlatformActions(db);
    const org = await db.organization.create({ data: { id: generateId(), name: 'F Org', urn: 'f4162.example' } });
    const admin = await db.user.create({ data: { githubId: 416201, githubUsername: 'f-admin', handle: 'f-admin', roles: [] } });
    adminId = admin.id;
    await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
    const app = await db.app.create({ data: { id: generateId(), name: 'F App', urn: 'f4162.example:app', organizationId: org.id } });
    appId = app.id;
    const agentMem = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'agent-sys', urn: 'f4162.example:agent-sys', organizationId: org.id } });
    const agent = await db.agent.create({ data: { id: generateId(), name: 'F agent', urn: 'f4162.example:agent', organizationId: org.id, systemMemoryId: agentMem.id } });
    await db.appAgent.create({ data: { appId, agentId: agent.id } });
    installMemoryId = (await db.memory.create({ data: { id: generateId(), class: 'system', name: 'install', urn: 'f4162.example:install', organizationId: org.id, appId, installOfAgentId: agent.id, isInstallMemory: true } })).id;
    workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId: agent.id, name: 'Iris', slug: 'iris' } })).id;
  });
  const node = () => db.node.create({ data: { id: generateId(), memoryId: installMemoryId, loc: `boot:workers:${workerId}:source`, name: 'Source', content: 'original', role: 'boot-prompt' } });
  const mk = (nodeId: string, activatedAt: unknown) => insertGrantUnguarded({ appId, userId: adminId } as unknown as World, {
    user_id: null, worker_id: workerId, action: 'bootprompt.source.edit', action_values: { sourceNode: nodeId }, verified_by: adminId, issuer_user_id: adminId, ...active(activatedAt) } as never);
  it('a FUTURE starts_at is refused by both entry points, and spends nothing (Rook P3: grantLiveSql judges it for this door)', async () => {
    const s = await node(); const facts = { id: s.id, memoryId: installMemoryId, loc: s.loc };
    const early = await insertGrantUnguarded({ appId, userId: adminId } as unknown as World, {
      user_id: null, worker_id: workerId, action: 'bootprompt.source.edit', action_values: { sourceNode: s.id }, verified_by: adminId, issuer_user_id: adminId,
      starts_at: FUTURE, ...active(NOW) } as never);
    expect(await db.$transaction((tx) => hasUsableEditGrant(tx, workerId, facts))).toBe(false);
    expect(await db.$transaction((tx) => spendEditGrant(tx, workerId, facts))).toBe(false);
    expect(await db.grantEvent.count({ where: { grantId: early } })).toBe(0);
    await db.$executeRawUnsafe(`ALTER TABLE grants DISABLE TRIGGER grants_guard`);
    await db.$executeRawUnsafe(`UPDATE grants SET starts_at = ${DB_NOW} - interval '1 minute' WHERE id = $1`, early);
    await db.$executeRawUnsafe(`ALTER TABLE grants ENABLE TRIGGER grants_guard`);
    expect(await db.$transaction((tx) => hasUsableEditGrant(tx, workerId, facts))).toBe(true);
  });
  it('hasUsableEditGrant and spendEditGrant refuse it; the clock-now control is usable and spends', async () => {
    const s = await node(); const facts = { id: s.id, memoryId: installMemoryId, loc: s.loc };
    const future = await mk(s.id, FUTURE);
    expect(await db.$transaction((tx) => hasUsableEditGrant(tx, workerId, facts))).toBe(false);
    expect(await db.$transaction((tx) => spendEditGrant(tx, workerId, facts))).toBe(false);
    expect(await db.grantEvent.count({ where: { grantId: future } })).toBe(0);
    const now = await mk(s.id, NOW);
    expect(await db.$transaction((tx) => hasUsableEditGrant(tx, workerId, facts))).toBe(true);
    expect(await db.$transaction((tx) => spendEditGrant(tx, workerId, facts))).toBe(true);
    expect(await db.grantEvent.count({ where: { grantId: now, action: 'USE' } })).toBe(1);
    expect(await db.grantEvent.count({ where: { grantId: future } })).toBe(0);
  });
});
