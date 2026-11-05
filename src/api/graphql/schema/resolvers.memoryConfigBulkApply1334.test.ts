/**
 * #1334 bulk-apply slice — applyMemoryConfigTemplateToMemories, through the executable schema with the production
 * error formatter. Contract: Vera's FIT (6416599124) with Xylon's precision fixes, cap 50 (6417088365).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Prisma } from '../../../generated/prisma/index.js';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';
import { formatGraphQLError } from '../formatError.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

// A hook that runs before each per-target memory resolution, so a test can change the world BETWEEN targets.
const hooks: { beforeTarget: ((n: number) => Promise<void>) | null; calls: number } = { beforeTarget: null, calls: 0 };
vi.mock('./resolvers.memoryConfig.js', async (orig) => {
  const m = await orig<typeof import('./resolvers.memoryConfig.js')>();
  return {
    ...m,
    managedMemory: async (...a: Parameters<typeof m.managedMemory>) => {
      hooks.calls += 1;
      if (hooks.beforeTarget) await hooks.beforeTarget(hooks.calls);
      return m.managedMemory(...a);
    },
  };
});

const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });

interface Gql {
  data: Record<string, any> | null;
  errors: { message: string; extensions?: Record<string, unknown> }[] | undefined;
}
async function gql(ctx: Partial<Context>, query: string, variables: Record<string, unknown> = {}): Promise<Gql> {
  const res = await server.executeOperation({ query, variables }, { contextValue: { db, roles: [], ...ctx } as Context });
  if (res.body.kind !== 'single') throw new Error('unexpected incremental response');
  return res.body.singleResult as unknown as Gql;
}
const code = (r: Gql) => r.errors?.[0]?.extensions?.code;

const RULE = 'id role writers locked sourceTemplateId revision';
const BULK = `mutation($t: ID!, $m: [ID!]!, $v: Int, $d: Boolean) {
  applyMemoryConfigTemplateToMemories(templateRef: $t, memoryRefs: $m, expectedTemplateRevision: $v, dryRun: $d) {
    dryRun succeeded failed
    results { index memoryRef ok
      result { memoryId templateRevision required dryRun entries { role outcome rule { ${RULE} } } }
      error { code message currentRevision requestId } }
  } }`;
const SINGULAR = `mutation($t: ID!, $m: ID!) {
  applyMemoryConfigTemplate(templateRef: $t, memoryRef: $m) { memoryId templateRevision required dryRun entries { role outcome rule { ${RULE} } } } }`;
const CREATE_TPL = `mutation($t: MemoryConfigTemplateOwnerType!, $o: ID, $i: CreateMemoryConfigTemplateInput!) {
  createMemoryConfigTemplate(ownerType: $t, ownerRef: $o, input: $i) { template { id revision } } }`;
const UPDATE_TPL = `mutation($r: ID!, $i: UpdateMemoryConfigTemplateInput!) { updateMemoryConfigTemplate(ref: $r, input: $i) { template { revision } } }`;
const CREATE_RULE = `mutation($m: ID!, $i: CreateNodeRoleRuleInput!) { createNodeRoleRule(memoryRef: $m, input: $i) { rule { ${RULE} } } }`;
const UPDATE_RULE = `mutation($r: ID!, $i: UpdateNodeRoleRuleInput!) { updateNodeRoleRule(ref: $r, input: $i) { rule { ${RULE} } } }`;

let org: { id: string };
let otherOrg: { id: string };
let orgAdmin: string, orgAdmin2: string, contributor: string, userA: string, platformAdmin: string;
let m1: { id: string; urn: string }, m2: { id: string; urn: string }, m3: { id: string; urn: string };
let foreign: { id: string; urn: string };
let personal: { id: string; urn: string };

const as = (userId: string, extra: Partial<Context> = {}): Partial<Context> => ({ userId, ...extra });

async function mkUser(n: number, orgId?: string, role?: 'OWNER' | 'ADMIN' | 'CONTRIBUTOR', roles: string[] = []) {
  const u = await db.user.create({ data: { githubId: 73000 + n, githubUsername: `b${n}`, roles: roles as never } });
  if (orgId && role) await db.orgMember.create({ data: { organizationId: orgId, userId: u.id, role } });
  return u.id;
}
const mkMemory = (orgId: string, urn: string, extra: Record<string, unknown> = {}) =>
  db.memory.create({ data: { id: generateId(), organizationId: orgId, urn, name: urn, class: 'knowledge', visibility: 'ORGANIZATION', ...extra }, select: { id: true, urn: true } });

async function tpl(ctx: Partial<Context>, ownerType: string, ownerRef: string | null, input: Record<string, unknown>) {
  const r = await gql(ctx, CREATE_TPL, { t: ownerType, o: ownerRef, i: input });
  expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
  return r.data!.createMemoryConfigTemplate.template as { id: string; revision: number };
}
const bulk = (ctx: Partial<Context>, t: string, m: string[], extra: { v?: number; d?: boolean } = {}) => gql(ctx, BULK, { t, m, ...extra });
const out = (r: Gql) => {
  expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
  return r.data!.applyMemoryConfigTemplateToMemories as { dryRun: boolean; succeeded: number; failed: number; results: any[] };
};
const rulesOf = (memoryId: string) => db.nodeRoleRule.findMany({ where: { config: { memoryId } }, orderBy: { role: 'asc' } });

beforeEach(async () => {
  hooks.beforeTarget = null;
  hooks.calls = 0;
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'acme', urn: 'acme.com' }, select: { id: true } });
  otherOrg = await db.organization.create({ data: { id: generateId(), name: 'other', urn: 'other.com' }, select: { id: true } });
  orgAdmin = await mkUser(1, org.id, 'ADMIN');
  orgAdmin2 = await mkUser(2, org.id, 'ADMIN');
  contributor = await mkUser(3, org.id, 'CONTRIBUTOR');
  userA = await mkUser(4);
  platformAdmin = await mkUser(5, undefined, undefined, ['ADMIN']);
  await db.hadronServer.create({ data: { id: generateId(), url: 'https://hc.test' } });
  m1 = await mkMemory(org.id, 'acme.com:m1');
  m2 = await mkMemory(org.id, 'acme.com:m2');
  m3 = await mkMemory(org.id, 'acme.com:m3');
  foreign = await mkMemory(otherOrg.id, 'other.com:secret');
  personal = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, userId: userA, urn: 'acme.com:~a4', name: 'mine', class: 'private' },
    select: { id: true, urn: true },
  });
});

describe('applyMemoryConfigTemplateToMemories: the report', () => {
  it('one entry per input position, in order, echoing the caller\'s own string; ok XOR error; counts follow', async () => {
    const t = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'base', rules: [{ role: 'spec', writers: 'OWNER' }] });
    const missing = generateId();
    const refs = [m1.urn, missing, foreign.id, m2.id];
    const o = out(await bulk(as(orgAdmin), t.id, refs));
    expect(o).toMatchObject({ dryRun: false, succeeded: 2, failed: 2 });
    expect(o.results.map((e) => [e.index, e.memoryRef, e.ok])).toEqual([[0, m1.urn, true], [1, missing, false], [2, foreign.id, false], [3, m2.id, true]]);
    for (const e of o.results) expect((e.result === null) !== (e.error === null)).toBe(true);
    expect(o.results[0].result).toMatchObject({ memoryId: m1.id, templateRevision: 1, entries: [{ role: 'spec', outcome: 'APPLIED' }] });
    expect(o.results[1].error.code).toBe('MEMORY_NOT_FOUND');
    expect((await rulesOf(m1.id)).length).toBe(1);
    expect((await rulesOf(m2.id)).length).toBe(1);
    expect(await rulesOf(foreign.id)).toEqual([]);
  });

  it('SKIPPED_CONFLICT is an outcome, not a failure: the entry is ok', async () => {
    await gql(as(orgAdmin), CREATE_RULE, { m: m1.id, i: { role: 'spec', writers: 'ADMIN' } });
    const t = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'base', rules: [{ role: 'spec', writers: 'ALL' }] });
    const o = out(await bulk(as(orgAdmin), t.id, [m1.id]));
    expect(o).toMatchObject({ succeeded: 1, failed: 0 });
    expect(o.results[0].result.entries[0]).toMatchObject({ outcome: 'SKIPPED_CONFLICT' });
  });

  it('singular parity: a one-element bulk call reports exactly what the singular mutation reports', async () => {
    const t = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'policy', required: true, rules: [{ role: 'spec', writers: 'ADMIN' }] });
    const single = (await gql(as(orgAdmin), SINGULAR, { t: t.id, m: m1.id })).data!.applyMemoryConfigTemplate;
    const viaBulk = out(await bulk(as(orgAdmin), t.id, [m2.id])).results[0].result;
    const norm = (x: any) => ({ ...x, memoryId: 'm', entries: x.entries.map((e: any) => ({ ...e, rule: { ...e.rule, id: 'r' } })) });
    expect(norm(viaBulk)).toEqual(norm({ ...single, entries: single.entries }));
    expect((await rulesOf(m2.id))[0]).toMatchObject({ locked: true, sourceTemplateId: t.id });
  });

  it('the lock a required template sets still refuses ordinary edits (RULE_LOCKED unchanged)', async () => {
    const t = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'policy', required: true, rules: [{ role: 'spec', writers: 'ADMIN' }] });
    const rule = out(await bulk(as(orgAdmin), t.id, [m1.id])).results[0].result.entries[0].rule;
    expect(code(await gql(as(orgAdmin), UPDATE_RULE, { r: rule.id, i: { writers: 'OWNER' } }))).toBe('RULE_LOCKED');
  });

  it('dryRun: every target is its own rolled-back transaction; nothing is written', async () => {
    const t = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'base', rules: [{ role: 'spec' }] });
    const o = out(await bulk(as(orgAdmin), t.id, [m1.id, m2.id], { d: true }));
    expect(o).toMatchObject({ dryRun: true, succeeded: 2 });
    expect(o.results.map((e) => e.result.entries[0])).toEqual([{ role: 'spec', outcome: 'APPLIED', rule: null }, { role: 'spec', outcome: 'APPLIED', rule: null }]);
    expect(await db.memoryConfig.count()).toBe(0);
  });
});

describe('applyMemoryConfigTemplateToMemories: the four owner kinds', () => {
  it('ORGANIZATION and USER templates', async () => {
    const orgT = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'o', rules: [{ role: 'spec' }] });
    expect(out(await bulk(as(orgAdmin), orgT.id, [m1.id, m2.id])).succeeded).toBe(2);
    const userT = await tpl(as(userA), 'USER', null, { name: 'u', rules: [{ role: 'spec' }] });
    expect(out(await bulk(as(userA), userT.id, [personal.id])).succeeded).toBe(1);
    expect((await rulesOf(personal.id))[0]).toMatchObject({ sourceTemplateId: userT.id });
  });

  it('APP template', async () => {
    const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'team', urn: 'acme.com:team' } });
    const appT = await tpl(as(orgAdmin), 'APP', app.id, { name: 'a', rules: [{ role: 'spec' }] });
    expect(out(await bulk(as(orgAdmin), appT.id, [m1.id, m3.id])).succeeded).toBe(2);
  });

  it('HADRON_SERVER template, applied by a platform admin who manages the targets', async () => {
    const srvT = await tpl(as(platformAdmin, { roles: ['ADMIN'] }), 'HADRON_SERVER', null, { name: 's', rules: [{ role: 'spec' }] });
    const o = out(await bulk(as(platformAdmin, { roles: ['ADMIN'] }), srvT.id, [m1.id, m2.id]));
    expect(o.succeeded).toBe(2);
    expect((await rulesOf(m1.id))[0]).toMatchObject({ sourceTemplateId: srvT.id });
  });
});

describe('applyMemoryConfigTemplateToMemories: concealment and duplicates', () => {
  it('a missing target and an unmanaged one are byte-identical entries for the SAME input ref', async () => {
    const t = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'base', rules: [{ role: 'spec' }] });
    const unmanaged = out(await bulk(as(orgAdmin), t.id, [foreign.id])).results[0];
    await db.memory.update({ where: { id: foreign.id }, data: { deletedAt: new Date() } });
    const missing = out(await bulk(as(orgAdmin), t.id, [foreign.id])).results[0];
    expect(unmanaged.ok).toBe(false);
    expect(JSON.stringify(unmanaged)).toBe(JSON.stringify(missing));
    expect(unmanaged.error).toEqual({ code: 'MEMORY_NOT_FOUND', message: expect.not.stringContaining(otherOrg.id), currentRevision: null, requestId: null });
  });

  it('an unmanaged memory named twice stays MEMORY_NOT_FOUND both times (DUPLICATE_TARGET would disclose it)', async () => {
    const t = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'base', rules: [{ role: 'spec' }] });
    const o = out(await bulk(as(orgAdmin), t.id, [foreign.id, foreign.urn, foreign.id]));
    expect(o.results.map((e) => e.error?.code)).toEqual(['MEMORY_NOT_FOUND', 'MEMORY_NOT_FOUND', 'MEMORY_NOT_FOUND']);
  });

  it('a managed memory named by id, URN and id again: one write, the repeats are DUPLICATE_TARGET with no write', async () => {
    await gql(as(orgAdmin), CREATE_RULE, { m: m1.id, i: { role: 'spec', writers: 'ALL' } });
    const t = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'policy', required: true, rules: [{ role: 'spec', writers: 'ADMIN' }] });
    const o = out(await bulk(as(orgAdmin), t.id, [m1.id, m1.urn, m1.id]));
    expect(o.results.map((e) => (e.ok ? 'ok' : e.error.code))).toEqual(['ok', 'DUPLICATE_TARGET', 'DUPLICATE_TARGET']);
    expect(o.results[0].result.entries[0].outcome).toBe('REPLACED');
    // A second required apply would have REPLACED again and bumped the revision to 3.
    expect((await rulesOf(m1.id))[0]).toMatchObject({ revision: 2 });
  });
});

describe('applyMemoryConfigTemplateToMemories: the call-level refusals write nothing', () => {
  it('over the cap of 50 is refused before any work, naming the cap and the count; no truncation', async () => {
    const t = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'base', rules: [{ role: 'spec' }] });
    const refs = [m1.id, ...Array.from({ length: 50 }, () => generateId())];
    const r = await bulk(as(orgAdmin), t.id, refs);
    expect(code(r)).toBe('BULK_TARGETS_TOO_MANY');
    expect(r.errors![0].extensions).toMatchObject({ max: 50, count: 51 });
    expect(await rulesOf(m1.id)).toEqual([]);
    // Exactly 50 is accepted.
    expect(out(await bulk(as(orgAdmin), t.id, [m1.id, ...Array.from({ length: 49 }, () => generateId())])).succeeded).toBe(1);
  });

  it('empty list and blank ref are BAD_USER_INPUT', async () => {
    const t = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'base', rules: [{ role: 'spec' }] });
    expect(code(await bulk(as(orgAdmin), t.id, []))).toBe('BAD_USER_INPUT');
    expect(code(await bulk(as(orgAdmin), t.id, [m1.id, '  ']))).toBe('BAD_USER_INPUT');
    expect(await rulesOf(m1.id)).toEqual([]);
  });

  it('an unknown or unmanageable template is MEMORY_CONFIG_TEMPLATE_NOT_FOUND for the whole call', async () => {
    const theirs = await tpl(as(userA), 'USER', null, { name: 'theirs', rules: [{ role: 'spec' }] });
    expect(code(await bulk(as(orgAdmin), theirs.id, [m1.id]))).toBe('MEMORY_CONFIG_TEMPLATE_NOT_FOUND');
    expect(code(await bulk(as(orgAdmin), generateId(), [m1.id]))).toBe('MEMORY_CONFIG_TEMPLATE_NOT_FOUND');
    expect(await rulesOf(m1.id)).toEqual([]);
  });

  it('a stale expectedTemplateRevision fails the call at once with CONFLICT and currentRevision', async () => {
    const t = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'base', rules: [{ role: 'spec' }] });
    await gql(as(orgAdmin), UPDATE_TPL, { r: t.id, i: { description: 'edited' } });
    const r = await bulk(as(orgAdmin), t.id, [m1.id], { v: 1 });
    expect(code(r)).toBe('CONFLICT');
    expect(r.errors![0].extensions).toMatchObject({ currentRevision: 2 });
    expect(await rulesOf(m1.id)).toEqual([]);
  });

  it('unauthenticated, and impersonation, never write', async () => {
    const t = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'base', rules: [{ role: 'spec' }] });
    expect((await bulk({}, t.id, [m1.id])).errors).toBeDefined();
    const imp = as(orgAdmin, { impersonation: { sessionId: 'imp', actorUserId: orgAdmin, orgId: org.id, expiresAt: new Date(Date.now() + 60_000) } } as Partial<Context>);
    expect((await bulk(imp, t.id, [m1.id])).errors).toBeDefined();
    expect(await rulesOf(m1.id)).toEqual([]);
  });
});

describe('applyMemoryConfigTemplateToMemories: the world changes between targets', () => {
  it('a template edited after target 1: each success carries its OWN revision; no snapshot promise', async () => {
    const t = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'base', rules: [{ role: 'spec' }] });
    hooks.beforeTarget = async (n) => { if (n === 2) await gql(as(orgAdmin), UPDATE_TPL, { r: t.id, i: { description: 'edited' } }); };
    const o = out(await bulk(as(orgAdmin), t.id, [m1.id, m2.id]));
    expect(o.results.map((e) => e.result.templateRevision)).toEqual([1, 2]);
  });

  it('with expectedTemplateRevision, the edit fails every later target CONFLICT; target 1 stays committed', async () => {
    const t = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'base', rules: [{ role: 'spec' }] });
    hooks.beforeTarget = async (n) => { if (n === 2) await gql(as(orgAdmin), UPDATE_TPL, { r: t.id, i: { description: 'edited' } }); };
    const o = out(await bulk(as(orgAdmin), t.id, [m1.id, m2.id, m3.id], { v: 1 }));
    expect(o.results.map((e) => (e.ok ? 'ok' : e.error.code))).toEqual(['ok', 'CONFLICT', 'CONFLICT']);
    expect(o.results[1].error.currentRevision).toBe(2);
    expect((await rulesOf(m1.id)).length).toBe(1);
    expect(await rulesOf(m2.id)).toEqual([]);
  });

  it('the template deleted mid-call: later targets are MEMORY_CONFIG_TEMPLATE_NOT_FOUND, earlier ones stay', async () => {
    const t = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'base', rules: [{ role: 'spec' }] });
    hooks.beforeTarget = async (n) => { if (n === 2) await db.memoryConfigTemplate.update({ where: { id: t.id }, data: { deletedAt: new Date() } }); };
    const o = out(await bulk(as(orgAdmin), t.id, [m1.id, m2.id]));
    expect(o.results.map((e) => (e.ok ? 'ok' : e.error.code))).toEqual(['ok', 'MEMORY_CONFIG_TEMPLATE_NOT_FOUND']);
    expect((await rulesOf(m1.id)).length).toBe(1);
  });

  it('the caller loses MANAGE mid-call: the gate is asked fresh per target, later targets read as missing', async () => {
    const t = await tpl(as(orgAdmin2), 'ORGANIZATION', org.id, { name: 'base', rules: [{ role: 'spec' }] });
    hooks.beforeTarget = async (n) => { if (n === 2) await db.orgMember.deleteMany({ where: { userId: orgAdmin2 } }); };
    const o = out(await bulk(as(orgAdmin2), t.id, [m1.id, m2.id]));
    expect(o.results[0].ok).toBe(true);
    expect(o.results[1]).toMatchObject({ ok: false, error: { code: expect.stringMatching(/^(MEMORY_NOT_FOUND|MEMORY_CONFIG_TEMPLATE_NOT_FOUND)$/) } });
    expect(await rulesOf(m2.id)).toEqual([]);
  });

  const conflictOf = (code: string, meta?: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError('driver text must not leak', { code, clientVersion: 'test', meta });
  /** Reject the FIRST per-target transaction with `err`; the second is real. */
  async function firstTransactionFails(err: unknown) {
    const t = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'base', rules: [{ role: 'spec' }] });
    const real = db.$transaction.bind(db);
    let n = 0;
    const spy = vi.spyOn(db, '$transaction').mockImplementation(((...a: unknown[]) => {
      n += 1;
      return n === 1 ? Promise.reject(err) : (real as (...x: unknown[]) => unknown)(...a);
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      return out(await bulk(as(orgAdmin), t.id, [m1.id, m2.id]));
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  }

  it('LOCAL P2: a write conflict or deadlock in one target is CONFLICT (retryable), the others still commit', async () => {
    for (const err of [conflictOf('P2034'), conflictOf('P2002'), conflictOf('P2010', { code: '40P01' }), conflictOf('P2010', { code: '40001' })]) {
      await cleanDb(db);
      org = await db.organization.create({ data: { id: generateId(), name: 'acme', urn: 'acme.com' }, select: { id: true } });
      orgAdmin = await mkUser(1, org.id, 'ADMIN');
      m1 = await mkMemory(org.id, 'acme.com:m1');
      m2 = await mkMemory(org.id, 'acme.com:m2');
      const o = await firstTransactionFails(err);
      expect(o.results.map((e) => (e.ok ? 'ok' : e.error.code))).toEqual(['CONFLICT', 'ok']);
      expect(JSON.stringify(o)).not.toContain('driver text');
      expect(await rulesOf(m1.id)).toEqual([]);
      expect((await rulesOf(m2.id)).length).toBe(1);
    }
  });

  it('LOCAL P2: any other database error stays a sanitized fault, never a conflict', async () => {
    for (const err of [conflictOf('P2010', { code: '23505' }), conflictOf('P2025'), conflictOf('P1001')]) {
      await cleanDb(db);
      org = await db.organization.create({ data: { id: generateId(), name: 'acme', urn: 'acme.com' }, select: { id: true } });
      orgAdmin = await mkUser(1, org.id, 'ADMIN');
      m1 = await mkMemory(org.id, 'acme.com:m1');
      m2 = await mkMemory(org.id, 'acme.com:m2');
      const o = await firstTransactionFails(err);
      expect(o.results[0]).toMatchObject({ ok: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error.' } });
      expect(JSON.stringify(o)).not.toContain('driver text');
    }
  });

  it('LOCAL P3 / BLIND P3: a first occurrence whose apply FAILS still consumes its slot; the alias is DUPLICATE_TARGET with no second transaction', async () => {
    const t = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'base', rules: [{ role: 'spec' }] });
    const real = db.$transaction.bind(db);
    let n = 0;
    const spy = vi.spyOn(db, '$transaction').mockImplementation(((...a: unknown[]) => {
      n += 1;
      return n === 1 ? Promise.reject(conflictOf('P2034')) : (real as (...x: unknown[]) => unknown)(...a);
    }) as never);
    for (const d of [false, true]) {
      n = 0;
      const o = out(await bulk(as(orgAdmin), t.id, [m1.id, m1.urn], { d }));
      expect(o.results.map((e) => (e.ok ? 'ok' : e.error.code))).toEqual(['CONFLICT', 'DUPLICATE_TARGET']);
      expect(n).toBe(1);
    }
    spy.mockRestore();
    expect(await rulesOf(m1.id)).toEqual([]);
  });

  it('an unexpected error in one target is INTERNAL_SERVER_ERROR with no driver text; the others still commit', async () => {
    const t = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'base', rules: [{ role: 'spec' }] });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    hooks.beforeTarget = async (n) => { if (n === 2) throw new Error('driver: relation "secret_table" violates something'); };
    const o = out(await bulk(as(orgAdmin), t.id, [m1.id, m2.id, m3.id]));
    spy.mockRestore();
    expect(o.results.map((e) => e.ok)).toEqual([true, false, true]);
    expect(o.results[1].error).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error.', requestId: expect.any(String) });
    expect(JSON.stringify(o)).not.toContain('secret_table');
    expect((await rulesOf(m3.id)).length).toBe(1);
  });
});
