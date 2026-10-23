/**
 * #2246 (S2) — Agent.offerReadiness. The anchors: the field is manager-only; it lists the S1 predicate's
 * blockers for an OUTSIDER (no same-org exemption) and agrees with what a fresh outsider's cloneAgent is
 * refused with; its subject lists are scalar-only and satisfy listed + omittedByCap + hiddenByAccess = count.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSchema, isEnumType, isObjectType, getNamedType, type GraphQLNamedType } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { CLONE_BLOCKER_CODES, cloneBlockers } from '../../../lib/agentClone/blockers.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { OFFER_SUBJECT_CAP } from './resolvers.agentOfferReadiness.js';

vi.mock('../../../lib/agentClone/blockers.js', async (orig) => {
  const m = await orig<typeof import('../../../lib/agentClone/blockers.js')>();
  return { ...m, cloneBlockers: vi.fn(m.cloneBlockers) };
});

const A = resolvers.Agent as unknown as Record<string, (...a: unknown[]) => Promise<any>>;
const M = resolvers.Mutation as unknown as Record<string, (...a: unknown[]) => Promise<any>>;
const ctxFor = (userId: string, roles: Context['roles'] = ['READER']): Context => ({ db, userId, roles }) as Context;
const anon = (): Context => ({ db, roles: ['READER'] }) as Context;
const field = async (agentId: string, c: Context) =>
  A.offerReadiness(await db.agent.findUniqueOrThrow({ where: { id: agentId } }), {}, c);
const codeOf = async (p: Promise<unknown>) => {
  try { await p; } catch (e) { return (e as { extensions?: { code?: string } }).extensions?.code ?? (e as Error).name; }
  return 'NO_ERROR';
};

let orgA: string; let orgB: string; let orgC: string;
let manager: string; let readerA: string; let adminB: string; let adminC: string; let stranger: string; let sysAdmin: string;

async function user(tag: string, roles: ('READER' | 'ADMIN')[] = ['READER']) {
  const id = generateId();
  await db.user.create({ data: { id, email: `${tag}-${id}@x.test`, handle: `${tag}${id.slice(-6)}`.toLowerCase(), roles } });
  return id;
}
const org = async (urn: string) => {
  const id = generateId();
  await db.organization.create({ data: { id, name: urn, urn } });
  return id;
};
const member = (organizationId: string, userId: string, role: 'ADMIN' | 'READER') => db.orgMember.create({ data: { organizationId, userId, role } });
async function agent(orgId: string, visibility: 'PUBLIC' | 'ORGANIZATION' | 'PERSONAL', extra: Record<string, unknown> = {}) {
  const id = generateId();
  await db.agent.create({ data: { id, organizationId: orgId, urn: `of-${id}`, name: `A-${id.slice(-5)}`, visibility, ...extra } });
  return id;
}
async function memory(orgId: string, patch: Record<string, unknown> = {}) {
  const id = generateId();
  await db.memory.create({ data: { id, organizationId: orgId, name: `m-${id.slice(-5)}`, urn: `ofm-${id}`, class: 'knowledge', ...patch } as never });
  return id;
}
const link = (agentId: string, memoryId: string) => db.agentMemoryItem.create({ data: { agentId, memoryId } });
async function importOf(parentId: string, importedId: string, position: number) {
  await db.agentOrgGrant.upsert({
    where: { orgId_agentId: { orgId: orgA, agentId: importedId } },
    create: { orgId: orgA, agentId: importedId, activatedAt: new Date(Date.now() - 1000) }, update: {},
  });
  await db.agentImport.create({ data: { parentAgentId: parentId, importedAgentId: importedId, position, agentOrgGrantOrgId: orgA, agentOrgGrantAgentId: importedId } });
}
/** A cloneable shape: an Agent with a system memory, so a ready one actually clones. */
async function source(orgId: string, visibility: 'PUBLIC' | 'ORGANIZATION', extra: Record<string, unknown> = {}) {
  const memId = generateId();
  await db.memory.create({ data: { id: memId, organizationId: orgId, urn: `of-sys-${memId}`, name: 'sys', class: 'system', acceptsUploads: false } as never });
  return agent(orgId, visibility, { systemMemoryId: memId, description: 'd', systemPrompt: 'hi', surfaces: ['mcp'], personaRole: 't', ...extra });
}

beforeEach(async () => {
  vi.mocked(cloneBlockers).mockClear();
  await cleanDb(db);
  orgA = await org('of-a'); orgB = await org('of-b'); orgC = await org('of-c');
  manager = await user('mgr'); readerA = await user('rda'); adminB = await user('adb'); adminC = await user('adc');
  stranger = await user('str'); sysAdmin = await user('sys', ['ADMIN']);
  await member(orgA, manager, 'ADMIN'); await member(orgA, readerA, 'READER');
  await member(orgB, adminB, 'ADMIN'); await member(orgB, readerA, 'ADMIN'); await member(orgC, adminC, 'ADMIN');
});

describe('schema: one code table, scalar-only reach', () => {
  const schema = buildSchema(typeDefs);
  it('the enum equals CLONE_BLOCKER_CODES as sets', () => {
    const e = schema.getType('AgentOfferReasonCode');
    expect(isEnumType(e)).toBe(true);
    const values = new Set((e as import('graphql').GraphQLEnumType).getValues().map((v) => v.name));
    expect(values).toEqual(new Set(Object.values(CLONE_BLOCKER_CODES)));
  });
  it('every type reachable from Agent.offerReadiness is a scalar, an enum or one of the readiness types', () => {
    const allowed = new Set(['AgentOfferReadiness', 'AgentOfferReason', 'AgentOfferSubject', 'AgentOfferReasonCode', 'Boolean', 'Int', 'String']);
    const seen = new Set<string>();
    const walk = (t: GraphQLNamedType) => {
      if (seen.has(t.name)) return;
      seen.add(t.name);
      if (isObjectType(t)) for (const f of Object.values(t.getFields())) walk(getNamedType(f.type));
    };
    const agentType = schema.getType('Agent');
    walk(getNamedType((agentType as import('graphql').GraphQLObjectType).getFields().offerReadiness.type));
    expect([...seen].filter((n) => !allowed.has(n))).toEqual([]);
    expect(seen.has('AgentOfferSubject')).toBe(true);
  });
  it('exposes no id or position anywhere in it', () => {
    for (const n of ['AgentOfferReadiness', 'AgentOfferReason', 'AgentOfferSubject']) {
      const names = Object.keys((schema.getType(n) as import('graphql').GraphQLObjectType).getFields());
      expect(names).not.toContain('id');
      expect(names).not.toContain('position');
    }
  });
});

describe('audience: managers only, null for everyone else', () => {
  it('a manager of a ready PUBLIC Agent sees ready with no reasons', async () => {
    const a = await agent(orgA, 'PUBLIC');
    expect(await field(a, ctxFor(manager))).toEqual({ ready: true, reasons: [] });
  });
  it.each([
    ['an org reader of a PUBLIC Agent', () => ctxFor(readerA)],
    ['another org admin', () => ctxFor(adminB)],
    ['a stranger', () => ctxFor(stranger)],
    ['anonymous', () => anon()],
  ])('%s gets null, and the predicate is never evaluated', async (_n, c) => {
    const a = await agent(orgA, 'PUBLIC', { visibility: 'PUBLIC' });
    const enc = await memory(orgA, { isEncrypted: true });
    await link(a, enc);
    expect(await field(a, c())).toBeNull();
    expect(vi.mocked(cloneBlockers)).not.toHaveBeenCalled();
  });
  it('a platform admin without ownership of a user-owned Agent follows requireAgentAccess (null for an org-less ordinary reader)', async () => {
    const a = await agent(orgA, 'PUBLIC');
    expect(await field(a, ctxFor(stranger))).toBeNull();
  });
  it('a hard-deleted Agent between the parent read and the field answers null', async () => {
    const a = await agent(orgA, 'PUBLIC');
    const parent = await db.agent.findUniqueOrThrow({ where: { id: a } });
    await db.agent.delete({ where: { id: a } });
    expect(await A.offerReadiness(parent, {}, ctxFor(manager))).toBeNull();
  });
});

describe('reasons, one per code, in the clone refusal order', () => {
  it('a non-PUBLIC Agent is not ready for an outsider even though its own manager can clone it (R181)', async () => {
    const a = await agent(orgA, 'ORGANIZATION');
    const r = await field(a, ctxFor(manager));
    expect(r.ready).toBe(false);
    expect(r.reasons.map((x: any) => x.code)).toEqual(['AGENT_NOT_PUBLIC']);
    // The same fixture for the manager's own org has no AGENT_NOT_PUBLIC (S1's separate exemption).
    const own = await cloneBlockers(db, a, { kind: 'org', orgId: orgA, ctx: ctxFor(manager) });
    expect(own.map((b) => b.code)).not.toContain('AGENT_NOT_PUBLIC');
  });
  it('a retired Agent lists AGENT_RETIRED right after AGENT_NOT_PUBLIC (reachable only past the parent read)', async () => {
    const a = await agent(orgA, 'ORGANIZATION', { deletedAt: new Date() });
    const r = await field(a, ctxFor(manager));
    expect(r.reasons.map((x: any) => x.code)).toEqual(['AGENT_NOT_PUBLIC', 'AGENT_RETIRED']);
  });
  it('an encrypted linked memory is named to a manager who can read it; every code appears in order', async () => {
    const base = await agent(orgA, 'ORGANIZATION');
    const a = await agent(orgA, 'ORGANIZATION', { extendsAgentId: base });
    const enc = await memory(orgA, { isEncrypted: true, name: 'ENC-ONE' });
    const priv = await memory(orgA, { name: 'ORG-ONLY' });
    await link(a, enc); await link(a, priv);
    await importOf(a, await agent(orgA, 'ORGANIZATION', { name: 'IMP-ONE' }), 100);
    const r = await field(a, ctxFor(manager));
    expect(r.reasons.map((x: any) => x.code)).toEqual([
      'AGENT_NOT_PUBLIC', 'CLONE_LINKED_MEMORY_ENCRYPTED', 'CLONE_LINKED_MEMORY_UNREADABLE', 'CLONE_BASE_UNUSABLE', 'CLONE_IMPORT_UNUSABLE',
    ]);
    const by = (c: string) => r.reasons.find((x: any) => x.code === c);
    expect(by('CLONE_LINKED_MEMORY_ENCRYPTED').subjects).toEqual([{ name: 'ENC-ONE' }]);
    expect(by('CLONE_LINKED_MEMORY_UNREADABLE').subjects).toEqual([{ name: 'ORG-ONLY' }]);
    expect(by('CLONE_IMPORT_UNUSABLE').subjects).toEqual([{ name: 'IMP-ONE' }]);
  });
});

describe('subject lists: cap, redaction and the arithmetic', () => {
  const sum = (x: any) => x.subjects.length + x.omittedByCap + x.hiddenByAccess;
  it('25 readable unusable imports: 20 listed, 5 omitted by the cap, none hidden', async () => {
    const a = await agent(orgA, 'PUBLIC');
    for (let i = 0; i < 25; i++) await importOf(a, await agent(orgA, 'ORGANIZATION'), (i + 1) * 10);
    const [x] = (await field(a, ctxFor(manager))).reasons;
    expect(x.code).toBe('CLONE_IMPORT_UNUSABLE');
    expect([x.count, x.subjects.length, x.omittedByCap, x.hiddenByAccess]).toEqual([25, OFFER_SUBJECT_CAP, 5, 0]);
    expect(sum(x)).toBe(x.count);
  });
  it('an import the manager cannot read is counted but never named, anywhere in the response', async () => {
    const a = await agent(orgA, 'PUBLIC');
    await importOf(a, await agent(orgA, 'ORGANIZATION', { name: 'SEE-ME-1' }), 10);
    await importOf(a, await agent(orgB, 'ORGANIZATION', { name: 'ZZ-HIDDEN-AGENT' }), 20);
    await importOf(a, await agent(orgA, 'ORGANIZATION', { name: 'SEE-ME-2' }), 30);
    const res = await field(a, ctxFor(manager));
    const [x] = res.reasons;
    expect([x.count, x.hiddenByAccess, x.omittedByCap]).toEqual([3, 1, 0]);
    expect(x.subjects).toEqual([{ name: 'SEE-ME-1' }, { name: 'SEE-ME-2' }]);
    expect(JSON.stringify(res)).not.toContain('ZZ-HIDDEN-AGENT');
    expect(JSON.stringify(res)).not.toContain('position');
  });
  it('22 readable plus 4 hidden: 20 listed, 2 omitted, 4 hidden, 26 in all', async () => {
    const a = await agent(orgA, 'PUBLIC');
    let p = 0;
    for (let i = 0; i < 22; i++) await importOf(a, await agent(orgA, 'ORGANIZATION'), (p += 10));
    for (let i = 0; i < 4; i++) await importOf(a, await agent(orgB, 'ORGANIZATION'), (p += 10));
    const [x] = (await field(a, ctxFor(manager))).reasons;
    expect([x.count, x.subjects.length, x.omittedByCap, x.hiddenByAccess]).toEqual([26, 20, 2, 4]);
    expect(sum(x)).toBe(26);
  });
  it('linked memories: an unreadable one is counted unnamed; an encrypted one the manager cannot read is counted unnamed', async () => {
    const a = await agent(orgA, 'PUBLIC');
    const theirs = await memory(orgB, { class: 'personal', userId: readerA, name: 'TOP-SECRET' });
    const theirsEnc = await memory(orgB, { class: 'personal', userId: readerA, isEncrypted: true, name: 'TOP-SECRET-ENC' });
    await link(a, theirs); await link(a, theirsEnc);
    const res = await field(a, ctxFor(manager));
    for (const x of res.reasons) {
      expect([x.count, x.subjects.length, x.hiddenByAccess]).toEqual([1, 0, 1]);
    }
    expect(res.reasons.map((x: any) => x.code)).toEqual(['CLONE_LINKED_MEMORY_ENCRYPTED', 'CLONE_LINKED_MEMORY_UNREADABLE']);
    expect(JSON.stringify(res)).not.toContain('TOP-SECRET');
  });
});

describe('parity with cloneAgent for a fresh outsider (S1 first refusal; not "the whole set")', () => {
  const clone = (userId: string, src: string, tag: string, target = 'of-c') =>
    M.cloneAgent(null, { source: src, target, slug: `p-${tag}-${generateId().slice(-5)}` }, ctxFor(userId));
  const missing = () => codeOf(clone(adminC, 'of-a:nope', 'missing'));

  it('the first S2 reason is what the outsider is refused with; ready means the clone is not blocked', async () => {
    const cases: Array<[string, () => Promise<string>]> = [
      ['encrypted link', async () => { const a = await source(orgA, 'PUBLIC'); await link(a, await memory(orgA, { isEncrypted: true })); return a; }],
      ['unreadable link', async () => { const a = await source(orgA, 'PUBLIC'); await link(a, await memory(orgA)); return a; }],
      ['unusable base', async () => source(orgA, 'PUBLIC', { extendsAgentId: await agent(orgA, 'ORGANIZATION') })],
      ['unusable import', async () => { const a = await source(orgA, 'PUBLIC'); await importOf(a, await agent(orgA, 'ORGANIZATION'), 10); return a; }],
    ];
    for (const [name, build] of cases) {
      const a = await build();
      const r = await field(a, ctxFor(manager));
      expect(r.ready, name).toBe(false);
      const refused = await codeOf(clone(adminC, a, name));
      expect(refused, name).toBe(r.reasons[0].code);
    }
    const ok = await source(orgA, 'PUBLIC');
    expect((await field(ok, ctxFor(manager))).ready).toBe(true);
    expect(await codeOf(clone(adminC, ok, 'ready'))).toBe('NO_ERROR');
  });

  it('not PUBLIC: a cloner who can read it is refused AGENT_NOT_PUBLIC; an unrelated one is told it does not exist', async () => {
    const a = await source(orgA, 'ORGANIZATION');
    const r = await field(a, ctxFor(manager));
    expect(r.reasons[0].code).toBe('AGENT_NOT_PUBLIC');
    // readerA reads it (org member) and administers orgB: S1's first refusal is the field's first reason.
    expect(await codeOf(clone(readerA, a, 'np', 'of-b'))).toBe('AGENT_NOT_PUBLIC');
    // The outsider organisation's admin cannot read it, so existence is concealed exactly like an absent Agent.
    expect(await codeOf(clone(adminC, a, 'np2'))).toBe(await missing());
  });

  it('a retired Agent: the field lists AGENT_RETIRED, the cloner is told it does not exist (concealment mapping)', async () => {
    const a = await source(orgA, 'PUBLIC');
    await db.agent.update({ where: { id: a }, data: { deletedAt: new Date() } });
    const r = await field(a, ctxFor(manager));
    expect(r.reasons.map((x: any) => x.code)).toEqual(['AGENT_RETIRED']);
    expect(await codeOf(clone(adminC, a, 'retired'))).toBe(await missing());
  });

  it('R181 separately: the same-org manager clones the non-PUBLIC source while the field still says not ready', async () => {
    const a = await source(orgA, 'ORGANIZATION');
    expect((await field(a, ctxFor(manager))).reasons[0].code).toBe('AGENT_NOT_PUBLIC');
    const own = await M.cloneAgent(null, { source: a, target: 'of-a', slug: `own-${generateId().slice(-5)}` }, ctxFor(manager)).then(() => 'NO_ERROR', (e: Error) => e.name);
    expect(own).toBe('NO_ERROR');
  });
});
