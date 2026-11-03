/** #3253 / cor:dmo:050:09, cor:dmo:060:09 / ruling0089 A: subscribed links are capped, never grants. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers } from './resolvers.js';
import { requireAgentMemoryGrant, type Context } from './resolvers.helpers.js';
import { getOrgReadableMemoryIds } from '../../../lib/auth/orgReadableMemory.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
const M = resolvers.Mutation as any;
let a: string, b: string, c: string, caller: string, reader: string, agent: string, memory: string;
const ctx = (userId = caller, roles: string[] = []): Context => ({ db, userId, roles } as Context);
const item = () => db.agentMemoryItem.findUnique({ where: { agentId_memoryId: { agentId: agent, memoryId: memory } } });
const link = (role = 'read', op = 'addMemoryToAgent', context = ctx()) => M[op]({}, { agentRef: agent, memoryRef: memory, role }, context);
async function outcome(p: Promise<unknown>) {
  try { await p; return { code: 'ADMITTED', reason: undefined }; }
  catch (e) { const v = e as { code?: string; message: string; extensions?: Record<string, unknown> }; return { code: v.extensions?.code ?? v.code, reason: v.extensions?.reason }; }
}
async function refusal(p: Promise<unknown>) {
  try { await p; return 'ADMITTED'; }
  catch (e) { const v = e as { message: string; extensions?: Record<string, unknown> }; return JSON.stringify({ message: v.message, extensions: v.extensions }); }
}
const subscribe = (role: 'READER' | 'CONTRIBUTOR' = 'READER', extra: Record<string, unknown> = {}) =>
  db.memorySubscription.create({ data: { id: generateId(), memoryId: memory, organizationId: b, role, ...extra } as never });

beforeEach(async () => {
  await cleanDb(db);
  const org = async () => (await db.organization.create({ data: { id: generateId(), name: 'Synthetic', urn: `o${generateId()}` } })).id;
  [a, b, c] = await Promise.all([org(), org(), org()]);
  caller = (await db.user.create({ data: { id: generateId(), handle: `u${generateId()}` } })).id;
  reader = (await db.user.create({ data: { id: generateId(), handle: `u${generateId()}` } })).id;
  await db.orgMember.createMany({ data: [
    { organizationId: b, userId: caller, role: 'ADMIN' },
    // Independent read means a revoked subscription reaches the tenancy refusal, not concealment.
    { organizationId: a, userId: caller, role: 'READER' },
    { organizationId: b, userId: reader, role: 'READER' },
  ] });
  agent = (await db.agent.create({ data: { id: generateId(), organizationId: b, name: 'Synthetic', urn: `agent${generateId()}`, visibility: 'ORGANIZATION' } })).id;
  memory = (await db.memory.create({ data: { id: generateId(), organizationId: a, name: 'Synthetic', urn: `memory${generateId()}`, class: 'knowledge', visibility: 'ORGANIZATION' } })).id;
});

for (const op of ['addMemoryToAgent', 'updateAgentMemoryRole']) {
  for (const [subscriptionRole, asked] of [['READER', 'read'], ['CONTRIBUTOR', 'read'], ['CONTRIBUTOR', 'read-write']] as const) {
    it(`${op}: ${subscriptionRole} admits ${asked} on non-PUBLIC foreign knowledge`, async () => {
      await subscribe(subscriptionRole);
      if (op === 'updateAgentMemoryRole') await db.agentMemoryItem.create({ data: { agentId: agent, memoryId: memory, role: 'read' } });
      expect(await outcome(link(asked, op))).toEqual({ code: 'ADMITTED', reason: undefined });
      expect((await item())?.role).toBe(asked);
    });
  }
  it(`${op}: a READER cannot give read-write; byte-identical no-subscription refusal`, async () => {
    if (op === 'updateAgentMemoryRole') await db.agentMemoryItem.create({ data: { agentId: agent, memoryId: memory, role: 'read' } });
    const before = await item();
    const baseline = await refusal(link('read-write', op));
    expect(baseline).toContain('CROSS_TENANT_ATTACH');
    await subscribe();
    expect(await refusal(link('read-write', op))).toBe(baseline);
    expect(await item()).toEqual(before);
  });
}

it('unactivated and unlicensed subscription counts exactly like read (0089)', async () => {
  await subscribe('CONTRIBUTOR', { activated: false });
  await db.memory.update({ where: { id: memory }, data: { requiresLicense: true } });
  expect(await getOrgReadableMemoryIds(db, reader, memory)).toContain(memory);
  expect(await outcome(link('read-write'))).toEqual({ code: 'ADMITTED', reason: undefined });
});

for (const bad of ['deleted', 'other-org', 'caller-org-only', 'org-less-agent', 'none']) {
  it(`${bad} cannot admit a foreign link and writes no item`, async () => {
    if (bad === 'caller-org-only') {
      await db.orgMember.create({ data: { organizationId: c, userId: caller, role: 'ADMIN' } });
    }
    if (bad === 'org-less-agent') await db.agent.update({ where: { id: agent }, data: { organizationId: null, ownerUserId: caller } });
    const baseline = await refusal(link());
    expect(baseline).toContain('CROSS_TENANT_ATTACH');
    if (bad !== 'none') await subscribe('CONTRIBUTOR', {
      ...(bad === 'deleted' ? { deletedAt: new Date() } : {}),
      ...(['other-org', 'caller-org-only'].includes(bad) ? { organizationId: c } : {}),
    });
    expect(await refusal(link())).toBe(baseline);
    expect(await item()).toBeNull();
  });
}

for (const kind of ['personal', 'private', 'group', 'system', 'app-scoped', 'user-memory']) {
  it(`${kind}: subscription does not widen existing refusal or canonical read set`, async () => {
    const patch: Record<string, unknown> = {};
    if (kind === 'personal' || kind === 'private') Object.assign(patch, { class: kind, visibility: null, organizationId: null, ownerUserId: caller, userId: caller });
    if (kind === 'group') Object.assign(patch, { class: 'group', visibility: 'GROUP' });
    if (kind === 'system') Object.assign(patch, { class: 'system', visibility: null });
    if (kind === 'app-scoped') {
      const app = await db.app.create({ data: { id: generateId(), organizationId: a, name: 'Synthetic', urn: `app${generateId()}` } });
      patch.appId = app.id;
    }
    if (kind === 'user-memory') Object.assign(patch, { userMemoryOfAgentId: agent, createdBy: caller });
    await db.memory.update({ where: { id: memory }, data: patch });
    // A platform-admin principal exposes the gate's class-specific refusals, not a hidden-memory shortcut.
    await db.user.update({ where: { id: caller }, data: { roles: ['ADMIN'] } });
    const admin = ctx(caller, ['ADMIN']);
    const baseline = await refusal(link('read', 'addMemoryToAgent', admin));
    expect(baseline).not.toBe('ADMITTED');
    await subscribe('CONTRIBUTOR');
    expect(await refusal(link('read', 'addMemoryToAgent', admin))).toBe(baseline);
    expect(await getOrgReadableMemoryIds(db, reader, memory)).not.toContain(memory);
    expect(await item()).toBeNull();
  });
}

it('no subscription leaves the existing foreign-refusal shape unchanged', async () => {
  expect(await outcome(link())).toEqual({ code: 'FORBIDDEN', reason: 'CROSS_TENANT_ATTACH' });
  expect(await item()).toBeNull();
});

it('a valid subscription is not a substitute for caller write capability (shared gate direct pin)', async () => {
  await subscribe('CONTRIBUTOR');
  // reader cannot manage this Agent via the mutation; exercise the capability guard itself, independently.
  const g = await db.agent.findUniqueOrThrow({ where: { id: agent } });
  const m = await db.memory.findUniqueOrThrow({ where: { id: memory } });
  expect(await outcome(db.$transaction(tx => requireAgentMemoryGrant({ ...ctx(reader), db: tx as any }, g, m, 'read-write', memory))))
    .toEqual({ code: 'FORBIDDEN', reason: 'INSUFFICIENT_MEMORY_CAPABILITY' });
  expect(await item()).toBeNull();
});

it('an unreadable memory keeps MEMORY_NOT_FOUND even with an Agent-org subscription', async () => {
  await db.orgMember.deleteMany({ where: { userId: caller } });
  await db.orgMember.create({ data: { organizationId: c, userId: caller, role: 'ADMIN' } });
  const subOrg = b;
  await db.agent.update({ where: { id: agent }, data: { organizationId: null, ownerUserId: caller } });
  // Caller holds no membership in B; the row names B but cannot confer its read to this person.
  await subscribe('CONTRIBUTOR', { organizationId: subOrg });
  expect((await outcome(link())).code).toBe('MEMORY_NOT_FOUND');
  expect(await item()).toBeNull();
});

it('subscription never permits a PUBLIC Agent read-write or non-PUBLIC covered knowledge', async () => {
  await subscribe('CONTRIBUTOR');
  await db.agent.update({ where: { id: agent }, data: { visibility: 'PUBLIC' } });
  await db.memory.update({ where: { id: memory }, data: { visibility: 'PUBLIC' } });
  expect(await outcome(link('read-write'))).toEqual({ code: 'FORBIDDEN', reason: 'PUBLIC_AGENT_READ_WRITE' });
  await db.memory.update({ where: { id: memory }, data: { visibility: 'ORGANIZATION' } });
  expect((await outcome(link())).code).toBe('BAD_USER_INPUT');
  expect(await item()).toBeNull();
});

for (const change of ['unsubscribe', 'downgrade'] as const) {
  it(`attach first: subscription FOR SHARE blocks ${change} until the item commits`, async () => {
    const sub = await subscribe('CONTRIBUTOR');
    let release!: () => void, hit!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const reached = new Promise<void>(r => { hit = r; });
    const paused = db.$extends({ query: { agentMemoryItem: { async upsert({ args, query }) {
      hit(); await held; return query(args);
    } } } });
    const linking = outcome(link('read-write', 'addMemoryToAgent', { ...ctx(), db: paused as unknown as Context['db'] }));
    const didReach = await Promise.race([reached.then(() => true), linking.then(() => false)]);
    if (!didReach) { release(); expect(await linking).toEqual({ code: 'ADMITTED', reason: undefined }); return; }
    let ready!: () => void, pid = 0, finished = false;
    const identified = new Promise<void>(r => { ready = r; });
    const revoke = db.$transaction(async tx => {
      const rows = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      pid = rows[0]!.pid; ready();
      return tx.memorySubscription.update({ where: { id: sub.id }, data: change === 'unsubscribe' ? { deletedAt: new Date() } : { role: 'READER' } });
    }).finally(() => { finished = true; });
    let blocked = false;
    try {
      await identified;
      const until = Date.now() + 5000;
      while (!finished && Date.now() < until) {
        const rows = await db.$queryRaw<Array<{ blocked: boolean }>>`SELECT cardinality(pg_blocking_pids(${pid})) > 0 AS blocked`;
        if (rows[0]?.blocked) { blocked = true; break; }
        await new Promise(r => setTimeout(r, 10));
      }
    } finally { release(); await Promise.all([linking, revoke]); }
    expect(blocked).toBe(true);
    expect(await linking).toEqual({ code: 'ADMITTED', reason: undefined });
    expect((await item())?.role).toBe('read-write');
    expect(await outcome(link('read-write', 'updateAgentMemoryRole'))).toEqual({ code: 'FORBIDDEN', reason: 'CROSS_TENANT_ATTACH' });
  }, 20000);

  it(`${change} first: the attach waits for the row and judges the committed change`, async () => {
    const sub = await subscribe('CONTRIBUTOR');
    let release!: () => void, ready!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const reached = new Promise<void>(r => { ready = r; });
    const revoke = db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM memory_subscriptions WHERE id = ${sub.id} FOR UPDATE`;
      await tx.memorySubscription.update({ where: { id: sub.id }, data: change === 'unsubscribe' ? { deletedAt: new Date() } : { role: 'READER' } });
      ready(); await held;
    }, { timeout: 20000 });
    await reached;
    let finished = false, blocked = false;
    const linking = outcome(link('read-write')).finally(() => { finished = true; });
    try {
      const until = Date.now() + 5000;
      while (!finished && Date.now() < until) {
        const rows = await db.$queryRaw<Array<{ n: bigint }>>`
          SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND query ILIKE '%memory_subscriptions%' AND query ILIKE '%FOR SHARE%'`;
        if (Number(rows[0]?.n ?? 0) > 0) { blocked = true; break; }
        await new Promise(r => setTimeout(r, 10));
      }
    } finally { release(); await Promise.all([revoke, linking]); }
    expect(blocked).toBe(true);
    expect(await linking).toEqual({ code: 'FORBIDDEN', reason: 'CROSS_TENANT_ATTACH' });
    expect(await item()).toBeNull();
  }, 20000);
}
