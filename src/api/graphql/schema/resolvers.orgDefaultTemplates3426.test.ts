/**
 * #3426 — organization default MemoryConfig templates, through the executable schema with the production error
 * formatter. Contract: the issue body (C1-C8), ruling 0200 (Q1) and Vera's FIT 6670790321.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbNode } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';
import { waitForLockWaiters, waitForLockWaitersOfType } from '../../../test/lockWait.js';
import { formatGraphQLError } from '../formatError.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

// A switch that makes the config write of an application fail, to prove the creation rolls back as a whole.
const faults: { materialize: boolean; beforeLockRefs: (() => Promise<void>) | null } = { materialize: false, beforeLockRefs: null };
vi.mock('./resolvers.memoryConfig.js', async (orig) => {
  const m = await orig<typeof import('./resolvers.memoryConfig.js')>();
  return {
    ...m,
    lockRuleRefs: async (...a: Parameters<typeof m.lockRuleRefs>) => {
      const hook = faults.beforeLockRefs;
      faults.beforeLockRefs = null;
      if (hook) await hook();
      return m.lockRuleRefs(...a);
    },
    materializeConfig: async (...a: Parameters<typeof m.materializeConfig>) => {
      if (faults.materialize) throw new Error('injected materialize failure');
      return m.materializeConfig(...a);
    },
  };
});

const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
interface Gql {
  data: Record<string, any> | null;
  errors: { message: string; extensions?: Record<string, any> }[] | undefined;
}
async function gql(ctx: Partial<Context>, query: string, variables: Record<string, unknown> = {}): Promise<Gql> {
  const res = await server.executeOperation({ query, variables }, { contextValue: { db, roles: [], ...ctx } as Context });
  if (res.body.kind !== 'single') throw new Error('unexpected incremental response');
  return res.body.singleResult as unknown as Gql;
}
const as = (userId: string, extra: Partial<Context> = {}): Partial<Context> => ({ userId, ...extra });
const errCode = (r: Gql) => r.errors?.[0]?.extensions?.code;
const errReason = (r: Gql) => r.errors?.[0]?.extensions?.reason;

const TPL = 'id revision orgDefault required';
const CREATE_TPL = `mutation($t: MemoryConfigTemplateOwnerType!, $o: ID, $i: CreateMemoryConfigTemplateInput!) {
  createMemoryConfigTemplate(ownerType: $t, ownerRef: $o, input: $i) { template { ${TPL} } } }`;
const UPDATE_TPL = `mutation($r: ID!, $i: UpdateMemoryConfigTemplateInput!) { updateMemoryConfigTemplate(ref: $r, input: $i) { template { ${TPL} } } }`;
const CREATE_MEMORY = `mutation($o: ID, $n: String!, $c: MemoryClass, $s: String) {
  createMemory(orgId: $o, name: $n, memoryClass: $c, source: $s) { id urn } }`;
const SKIPS = `query($m: ID!) { memoryConfig(memoryRef: $m) { defaultSkips { role field reason createdAt sourceTemplate { id } ref refState } } }`;

let org: { id: string; urn: string };
let otherOrg: { id: string; urn: string };
let admin: string, contributor: string, granted: string, outsider: string, platformAdmin: string, userA: string;
let kb: { id: string }; // org knowledge: the readable home of the default's tasks
let taskA: { id: string; urn: string }, taskB: { id: string; urn: string }, docNode: { id: string; urn: string };
let privMem: { id: string }, privTask: { urn: string };
let groupMem: { id: string }, groupTask: { urn: string };
let sysMem: { id: string }, sysTask: { urn: string };
let appMem: { id: string }, appTask: { urn: string };
let pubMem: { id: string }, pubTask: { id: string; urn: string };
let seq = 0;

async function mkUser(n: number, orgId?: string, role?: 'OWNER' | 'ADMIN' | 'CONTRIBUTOR', roles: string[] = []) {
  const u = await db.user.create({ data: { githubId: 33000 + n, githubUsername: `d${n}`, roles: roles as never } });
  if (orgId && role) await db.orgMember.create({ data: { organizationId: orgId, userId: u.id, role } });
  return u.id;
}
const mkMem = (data: Record<string, unknown>) =>
  db.memory.create({ data: { id: generateId(), name: String(data.urn), class: 'knowledge', visibility: 'ORGANIZATION', ...data } as never, select: { id: true } });
async function mkTask(memoryId: string, orgUrn: string, memUrnSlug: string, loc: string, runnable = true) {
  const n = await db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, isRunnable: runnable } });
  return { id: n.id, urn: `hrn:node:${orgUrn}:${memUrnSlug}:${loc}` };
}
async function tpl(name: string, rules: Record<string, unknown>[] | undefined, extra: Record<string, unknown> = {}, ctx: Partial<Context> = as(admin)) {
  const r = await gql(ctx, CREATE_TPL, { t: 'ORGANIZATION', o: org.id, i: { name, ...(rules ? { rules } : {}), ...extra } });
  expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
  return r.data!.createMemoryConfigTemplate.template as { id: string; revision: number; orgDefault: boolean };
}
const newMemory = async (name: string, ctx: Partial<Context> = as(admin), o: string | null = org.id, c = 'knowledge') => {
  const r = await gql(ctx, CREATE_MEMORY, { o, n: name, c });
  expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
  return r.data!.createMemory as { id: string; urn: string };
};
const rulesOf = (memoryId: string) => db.nodeRoleRule.findMany({ where: { config: { memoryId } }, orderBy: { role: 'asc' } });
const skipsOf = (memoryId: string) => db.memoryConfigDefaultSkip.findMany({ where: { memoryId }, orderBy: { role: 'asc' } });
const rule = (role: string, ref: { urn: string } | null, extra: Record<string, unknown> = {}) => ({ role, ...(ref ? { authorTaskRef: ref.urn } : {}), ...extra });

beforeEach(async () => {
  faults.materialize = false;
  faults.beforeLockRefs = null;
  seq = 0;
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'acme', urn: 'acme.com' }, select: { id: true, urn: true } });
  otherOrg = await db.organization.create({ data: { id: generateId(), name: 'other', urn: 'other.com' }, select: { id: true, urn: true } });
  admin = await mkUser(1, org.id, 'ADMIN');
  contributor = await mkUser(2, org.id, 'CONTRIBUTOR');
  granted = await mkUser(3, org.id, 'CONTRIBUTOR');
  outsider = await mkUser(4, otherOrg.id, 'OWNER');
  platformAdmin = await mkUser(5, undefined, undefined, ['ADMIN']);
  userA = await mkUser(6);
  await db.principalGrant.create({ data: { id: generateId(), principalType: 'USER', principalId: granted, organizationId: org.id, actions: ['memory.create'] } });
  await db.hadronServer.create({ data: { id: generateId(), url: 'https://hc.test' } });

  kb = await mkMem({ organizationId: org.id, urn: 'acme.com:kb' });
  taskA = await mkTask(kb.id, 'acme.com', 'kb', 'tasks:a');
  taskB = await mkTask(kb.id, 'acme.com', 'kb', 'tasks:b');
  docNode = await mkTask(kb.id, 'acme.com', 'kb', 'docs:why', false);
  // Readable to the admin who saves, NOT readable to the org (C1).
  privMem = await mkMem({ organizationId: org.id, urn: 'acme.com:~admin', class: 'private', visibility: null, userId: admin });
  privTask = await mkTask(privMem.id, 'acme.com', '~admin', 'tasks:p');
  groupMem = await mkMem({ organizationId: org.id, urn: 'acme.com:grp', class: 'group', visibility: 'GROUP' });
  await db.memoryMember.create({ data: { memoryId: groupMem.id, userId: admin, role: 'owner' } });
  groupTask = await mkTask(groupMem.id, 'acme.com', 'grp', 'tasks:g');
  sysMem = await mkMem({ organizationId: org.id, urn: 'acme.com:sys', class: 'system', visibility: null });
  sysTask = await mkTask(sysMem.id, 'acme.com', 'sys', 'tasks:s');
  const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'team', urn: 'acme.com:team' } });
  appMem = await mkMem({ organizationId: org.id, urn: 'acme.com:appkb', appId: app.id });
  appTask = await mkTask(appMem.id, 'acme.com', 'appkb', 'tasks:x');
  pubMem = await mkMem({ organizationId: otherOrg.id, urn: 'other.com:pub', visibility: 'PUBLIC' });
  pubTask = await mkTask(pubMem.id, 'other.com', 'pub', 'tasks:pub');
});

describe('#3426 designation and the save-time gate', () => {
  it('a user-, App- and server-owned template refuses orgDefault: true, on create and update (ORG_DEFAULT_ORG_ONLY)', async () => {
    const app = await db.app.findFirstOrThrow({ where: { organizationId: org.id } });
    const cases: Array<[Partial<Context>, string, string | null]> = [
      [as(userA), 'USER', null],
      [as(admin), 'APP', app.id],
      [as(platformAdmin, { roles: ['ADMIN'] }), 'HADRON_SERVER', null],
    ];
    for (const [ctx, t, o] of cases) {
      const c = await gql(ctx, CREATE_TPL, { t, o, i: { name: `x-${t.toLowerCase()}`, orgDefault: true } });
      expect(errCode(c), t).toBe('BAD_USER_INPUT');
      expect(errReason(c), t).toBe('ORG_DEFAULT_ORG_ONLY');
      const ok = await gql(ctx, CREATE_TPL, { t, o, i: { name: `y-${t.toLowerCase()}` } });
      expect(ok.errors, t).toBeUndefined();
      const u = await gql(ctx, UPDATE_TPL, { r: ok.data!.createMemoryConfigTemplate.template.id, i: { orgDefault: true } });
      expect(errReason(u), t).toBe('ORG_DEFAULT_ORG_ONLY');
    }
  });

  it('a non-manager gets the existing not-found, never ORG_DEFAULT_ORG_ONLY (the refusal is judged after the manage gate)', async () => {
    const mine = await gql(as(userA), CREATE_TPL, { t: 'USER', i: { name: 'private-one' } });
    const id = mine.data!.createMemoryConfigTemplate.template.id;
    const r = await gql(as(contributor), UPDATE_TPL, { r: id, i: { orgDefault: true } });
    expect(errCode(r)).toBe('MEMORY_CONFIG_TEMPLATE_NOT_FOUND');
  });

  it('only org ADMIN/OWNER set or clear it; a CONTRIBUTOR is refused; revision bumps', async () => {
    const t = await tpl('base', undefined);
    expect(t.orgDefault).toBe(false);
    const refused = await gql(as(contributor), UPDATE_TPL, { r: t.id, i: { orgDefault: true } });
    expect(errCode(refused)).toBe('MEMORY_CONFIG_TEMPLATE_NOT_FOUND');
    const on = await gql(as(admin), UPDATE_TPL, { r: t.id, i: { orgDefault: true } });
    expect(on.data!.updateMemoryConfigTemplate.template).toMatchObject({ orgDefault: true, revision: t.revision + 1 });
    const off = await gql(as(admin), UPDATE_TPL, { r: t.id, i: { orgDefault: false } });
    expect(off.data!.updateMemoryConfigTemplate.template).toMatchObject({ orgDefault: false, revision: t.revision + 2 });
    const born = await tpl('born', undefined, { orgDefault: true });
    expect(born.orgDefault).toBe(true);
  });

  it('refuses NODE_NOT_FOUND for a reference readable to the admin but not to the org (private, group, system, App-scoped, foreign)', async () => {
    for (const ref of [privTask, groupTask, sysTask, appTask]) {
      const r = await gql(as(admin), CREATE_TPL, { t: 'ORGANIZATION', o: org.id, i: { name: `d${seq++}`, orgDefault: true, rules: [rule('spec', ref)] } });
      expect(errCode(r), ref.urn).toBe('NODE_NOT_FOUND');
      // The same rule is fine in a template that is not a default (where the admin reads it): the org gate is the default's.
      if (ref === privTask || ref === groupTask) {
        const fine = await gql(as(admin), CREATE_TPL, { t: 'ORGANIZATION', o: org.id, i: { name: `n${seq++}`, rules: [rule('spec', ref)] } });
        expect(fine.errors, ref.urn).toBeUndefined();
      }
    }
    const foreign = await mkMem({ organizationId: otherOrg.id, urn: 'other.com:secret' });
    const ft = await mkTask(foreign.id, 'other.com', 'secret', 'tasks:f');
    const r = await gql(as(platformAdmin, { roles: ['ADMIN'] }), CREATE_TPL, { t: 'ORGANIZATION', o: org.id, i: { name: 'pa', orgDefault: true, rules: [rule('spec', ft)] } });
    expect(errCode(r)).toBe('NODE_NOT_FOUND');
  });

  it('accepts same-org knowledge and PUBLIC references', async () => {
    const t = await tpl('ok', [rule('spec', taskA), rule('guide', pubTask)], { orgDefault: true });
    expect(t.orgDefault).toBe(true);
  });

  it('judges the STORED rules when only orgDefault: true is sent (org-unreadable and broken)', async () => {
    const t = await tpl('stored', [rule('spec', privTask)]);
    const r = await gql(as(admin), UPDATE_TPL, { r: t.id, i: { orgDefault: true } });
    expect(errCode(r)).toBe('NODE_NOT_FOUND');
    const b = await tpl('brokenstored', [rule('spec', taskA)]);
    await db.node.delete({ where: { id: taskA.id } });
    const r2 = await gql(as(admin), UPDATE_TPL, { r: b.id, i: { orgDefault: true } });
    expect(errCode(r2)).toBe('NODE_ROLE_RULE_REF_BROKEN');
  });

  it('clearing the flag on a template with a broken rule succeeds, and a name-only edit of a flagged one does too', async () => {
    const t = await tpl('flagged', [rule('spec', taskA)], { orgDefault: true });
    await db.node.delete({ where: { id: taskA.id } });
    const name = await gql(as(admin), UPDATE_TPL, { r: t.id, i: { description: 'still editable' } });
    expect(name.errors, JSON.stringify(name.errors)).toBeUndefined();
    const clear = await gql(as(admin), UPDATE_TPL, { r: t.id, i: { orgDefault: false, required: true } });
    expect(clear.errors, JSON.stringify(clear.errors)).toBeUndefined();
    expect(clear.data!.updateMemoryConfigTemplate.template.orgDefault).toBe(false);
  });

  it('refuses CONFLICT when the stored rules moved between the unlocked read and the lock', async () => {
    const t = await tpl('moving', [rule('spec', taskA)]);
    faults.beforeLockRefs = async () => {
      await db.memoryConfigTemplateRule.updateMany({ where: { templateId: t.id }, data: { role: 'moved' } });
    };
    const r = await gql(as(admin), UPDATE_TPL, { r: t.id, i: { orgDefault: true } });
    expect(errCode(r)).toBe('CONFLICT');
    expect((await db.memoryConfigTemplate.findUniqueOrThrow({ where: { id: t.id } })).orgDefault).toBe(false);
  });

  it('two concurrent saves for the 10th default admit exactly one: the second waits on the org\'s advisory lock', async () => {
    for (let i = 0; i < 9; i++) await tpl(`d${i}`, undefined, { orgDefault: true });
    const mk = (n: string) => gql(as(admin), CREATE_TPL, { t: 'ORGANIZATION', o: org.id, i: { name: n, orgDefault: true } });
    // The first save is parked inside its transaction (after the advisory lock, before the count) while the second starts.
    let reached!: () => void;
    let go!: () => void;
    const atHook = new Promise<void>((r) => { reached = r; });
    const goOn = new Promise<void>((r) => { go = r; });
    faults.beforeLockRefs = async () => { reached(); await goOn; };
    const a = mk('race-a');
    await atHook;
    const b = mk('race-b');
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1, 4000);
    } finally {
      go();
    }
    const results = await Promise.all([a, b]);
    expect(results.filter((x) => !x.errors)).toHaveLength(1);
    expect(await db.memoryConfigTemplate.count({ where: { organizationId: org.id, orgDefault: true } })).toBe(10);
  });
  it('refuses an 11th live default for the org (ORG_DEFAULT_LIMIT)', async () => {
    for (let i = 0; i < 10; i++) await tpl(`d${i}`, undefined, { orgDefault: true });
    const r = await gql(as(admin), CREATE_TPL, { t: 'ORGANIZATION', o: org.id, i: { name: 'd10', orgDefault: true } });
    expect(errCode(r)).toBe('BAD_USER_INPUT');
    expect(errReason(r)).toBe('ORG_DEFAULT_LIMIT');
    const plain = await tpl('plain', undefined);
    const u = await gql(as(admin), UPDATE_TPL, { r: plain.id, i: { orgDefault: true } });
    expect(errReason(u)).toBe('ORG_DEFAULT_LIMIT');
  });
});

describe('#3426 where defaults apply (C3, C4)', () => {
  it('org knowledge and group creation get the defaults; another org, user-owned and org-anchored personal/private do not', async () => {
    await tpl('base', [rule('spec', taskA)], { orgDefault: true });
    const k = await newMemory('kn1');
    const g = await newMemory('gr1', as(admin), org.id, 'group');
    expect((await rulesOf(k.id)).map((r) => r.role)).toEqual(['spec']);
    expect((await rulesOf(g.id)).map((r) => r.role)).toEqual(['spec']);
    const other = await newMemory('ot1', as(outsider), otherOrg.id);
    expect(await rulesOf(other.id)).toEqual([]);
    const mine = await newMemory('mine1', as(userA), null, 'private');
    expect(await rulesOf(mine.id)).toEqual([]);
    const anchored = await newMemory('anch1', as(admin), org.id, 'private');
    expect(await rulesOf(anchored.id)).toEqual([]);
    const anchored2 = await newMemory('anch2', as(admin), org.id, 'personal');
    expect(await rulesOf(anchored2.id)).toEqual([]);
  });

  it('clone and extract do not apply defaults', async () => {
    await tpl('base', [rule('spec', taskA)], { orgDefault: true });
    const src = await newMemory('src1');
    await db.nodeRoleRule.deleteMany({ where: { config: { memoryId: src.id } } });
    const CLONE = `mutation($r: ID!, $t: String!) { cloneMemory(ref: $r, targetUrn: $t) { id } }`;
    const r = await gql(as(admin), CLONE, { r: src.id, t: 'hrn:mem:acme.com:copy1' });
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect(await rulesOf(r.data!.cloneMemory.id)).toEqual([]);
    const parent = await createDbNode(db, { loc: 'findings:auth', memoryId: src.id, content: 'root' });
    await createDbNode(db, { loc: 'findings:auth:leaf', memoryId: src.id, content: 'leaf' });
    const EXTRACT = `mutation($p: ID!, $t: String!) { extractParentNodeToMemory(parentRef: $p, targetUrn: $t) { id } }`;
    const x = await gql(as(admin), EXTRACT, { p: parent.id, t: 'hrn:mem:acme.com:extracted1' });
    expect(x.errors, JSON.stringify(x.errors)).toBeUndefined();
    expect(await rulesOf(x.data!.extractParentNodeToMemory.id)).toEqual([]);
  });

  it('a rules update that omits the flag cannot slip an org-unreadable ref into a template enabled meanwhile (CONFLICT)', async () => {
    const t = await tpl('racing', [rule('spec', taskA)]);
    faults.beforeLockRefs = async () => {
      const on = await gql(as(admin), UPDATE_TPL, { r: t.id, i: { orgDefault: true } });
      expect(on.errors, JSON.stringify(on.errors)).toBeUndefined();
    };
    const r = await gql(as(admin), UPDATE_TPL, { r: t.id, i: { rules: [rule('spec', privTask)] } });
    expect(errCode(r)).toBe('CONFLICT');
    const rows = await db.memoryConfigTemplateRule.findMany({ where: { templateId: t.id } });
    expect(rows.map((x) => x.authorTaskId)).toEqual([taskA.id]);
  });

  it('createMemory(source:) still gets the defaults (no caller-selectable opt-out)', async () => {
    await tpl('base', [rule('spec', taskA)], { orgDefault: true });
    const r = await gql(as(admin), CREATE_MEMORY, { o: org.id, n: 'withsrc', c: 'knowledge', s: 'https://github.com/example/repo' });
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect((await rulesOf(r.data!.createMemory.id)).map((x) => x.role)).toEqual(['spec']);
  });

  it('a soft-deleted template and a cleared flag do not apply; existing memories are untouched', async () => {
    const before = await newMemory('before1');
    const a = await tpl('a', [rule('one', taskA)], { orgDefault: true });
    const b = await tpl('b', [rule('two', taskA)], { orgDefault: true });
    const c = await tpl('c', [rule('three', taskA)], { orgDefault: true });
    await db.memoryConfigTemplate.update({ where: { id: a.id }, data: { deletedAt: new Date() } });
    await gql(as(admin), UPDATE_TPL, { r: b.id, i: { orgDefault: false } });
    const m = await newMemory('after1');
    expect((await rulesOf(m.id)).map((r) => r.role)).toEqual(['three']);
    expect(await rulesOf(before.id)).toEqual([]);
    await gql(as(admin), UPDATE_TPL, { r: c.id, i: { description: 'edited later' } });
    expect((await rulesOf(m.id)).map((r) => r.role)).toEqual(['three']);
  });

  it('orders non-required first, then required, each by createdAt then id; a required default replaces and locks', async () => {
    await tpl('first', [rule('spec', taskA, { writers: 'ADMIN' })], { orgDefault: true });
    await tpl('second', [rule('spec', taskB, { writers: 'ALL' })], { orgDefault: true });
    await tpl('req', [rule('spec', taskB, { writers: 'OWNER' })], { orgDefault: true, required: true });
    const m = await newMemory('order1');
    const rules = await rulesOf(m.id);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ role: 'spec', writers: 'OWNER', locked: true });
  });

  it('among non-required defaults the earlier createdAt wins the role', async () => {
    await tpl('early', [rule('spec', taskA, { writers: 'ADMIN' })], { orgDefault: true });
    await tpl('late', [rule('spec', taskB, { writers: 'ALL' })], { orgDefault: true });
    const m = await newMemory('order2');
    expect(await rulesOf(m.id)).toMatchObject([{ role: 'spec', writers: 'ADMIN', locked: false }]);
  });
});

describe('#3426 references at creation are judged for the ORG, live (C1, C5)', () => {
  it('same-org knowledge, PUBLIC and subscribed references apply; group, system and App-scoped ones are skipped with a record', async () => {
    const subbed = await mkMem({ organizationId: otherOrg.id, urn: 'other.com:subbed', visibility: 'PUBLIC' });
    const subTask = await mkTask(subbed.id, 'other.com', 'subbed', 'tasks:sub');
    await db.memorySubscription.create({ data: { id: generateId(), memoryId: subbed.id, organizationId: org.id, role: 'READER' } });
    const t = await tpl('refs', [
      rule('ok.kb', taskA), rule('ok.pub', pubTask), rule('ok.sub', subTask),
    ], { orgDefault: true });
    // Saved while readable; the unreadable shapes are planted straight into the stored rules afterwards.
    await db.memoryConfigTemplateRule.createMany({
      data: [
        { id: generateId(), templateId: t.id, role: 'bad.grp', authorTaskRequired: true, authorTaskId: (await db.node.findFirstOrThrow({ where: { memoryId: groupMem.id } })).id },
        { id: generateId(), templateId: t.id, role: 'bad.sys', authorTaskRequired: true, authorTaskId: (await db.node.findFirstOrThrow({ where: { memoryId: sysMem.id } })).id },
        { id: generateId(), templateId: t.id, role: 'bad.app', authorTaskRequired: true, authorTaskId: (await db.node.findFirstOrThrow({ where: { memoryId: appMem.id } })).id },
        { id: generateId(), templateId: t.id, role: 'bad.prv', authorTaskRequired: true, authorTaskId: (await db.node.findFirstOrThrow({ where: { memoryId: privMem.id } })).id },
      ],
    });
    // The group-member admin creates: the identity arm must still not admit the group reference (positive control).
    const m = await newMemory('refs1');
    expect((await rulesOf(m.id)).map((r) => r.role)).toEqual(['ok.kb', 'ok.pub', 'ok.sub']);
    expect((await skipsOf(m.id)).map((s) => [s.role, s.field, s.reason])).toEqual([
      ['bad.app', 'authorTask', 'REFERENCE_UNAVAILABLE'],
      ['bad.grp', 'authorTask', 'REFERENCE_UNAVAILABLE'],
      ['bad.prv', 'authorTask', 'REFERENCE_UNAVAILABLE'],
      ['bad.sys', 'authorTask', 'REFERENCE_UNAVAILABLE'],
    ]);
  });

  it('a revoked subscription and a soft-deleted node at creation skip (the save-time answer is not reused)', async () => {
    const subbed = await mkMem({ organizationId: otherOrg.id, urn: 'other.com:subbed', visibility: 'ORGANIZATION' });
    const subTask = await mkTask(subbed.id, 'other.com', 'subbed', 'tasks:sub');
    const sub = await db.memorySubscription.create({ data: { id: generateId(), memoryId: subbed.id, organizationId: org.id, role: 'READER' } });
    await tpl('live', [rule('via.sub', subTask), rule('via.del', taskB)], { orgDefault: true });
    await db.memorySubscription.update({ where: { id: sub.id }, data: { deletedAt: new Date() } });
    await db.node.update({ where: { id: taskB.id }, data: { deletedAt: new Date() } });
    await tpl('untasked', [rule('via.nat', taskA)], { orgDefault: true });
    await db.node.update({ where: { id: taskA.id }, data: { isRunnable: false } });
    const m = await newMemory('live1');
    expect(await rulesOf(m.id)).toEqual([]);
    expect((await skipsOf(m.id)).map((s) => s.role)).toEqual(['via.del', 'via.nat', 'via.sub']);
  });

  it('a task in a since-deleted memory and one in a since-user-owned PUBLIC memory skip at creation (shared-arm guards)', async () => {
    const gone = await mkMem({ organizationId: org.id, urn: 'acme.com:gone' });
    const goneTask = await mkTask(gone.id, 'acme.com', 'gone', 'tasks:gone');
    await tpl('arms', [rule('via.gone', goneTask), rule('via.pub', pubTask)], { orgDefault: true });
    await db.memory.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    await db.memory.update({ where: { id: pubMem.id }, data: { organizationId: null, ownerUserId: userA } });
    const m = await newMemory('arms1');
    expect(await rulesOf(m.id)).toEqual([]);
    expect((await skipsOf(m.id)).map((x) => x.role)).toEqual(['via.gone', 'via.pub']);
  });

  it('two required defaults on one role give the same result for an admin and a granted creator (C5)', async () => {
    await tpl('r1', [rule('spec', taskA, { writers: 'ADMIN' })], { orgDefault: true, required: true });
    await tpl('r2', [rule('spec', taskB, { writers: 'OWNER' })], { orgDefault: true, required: true });
    const viaAdmin = await newMemory('same1', as(admin));
    const viaGranted = await newMemory('same2', as(granted));
    for (const m of [viaAdmin, viaGranted]) {
      expect(await rulesOf(m.id)).toMatchObject([{ role: 'spec', writers: 'OWNER', locked: true }]);
    }
  });
});

describe('#3426 skipped references leave a concealed record (C6)', () => {
  it('writes one record naming role, field and template, stores no URN or state, and still creates the memory', async () => {
    const t = await tpl('skippy', [rule('spec', taskA)], { orgDefault: true });
    await db.node.update({ where: { id: taskA.id }, data: { deletedAt: new Date() } });
    const m = await newMemory('skip1');
    const rows = await skipsOf(m.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: 'spec', field: 'authorTask', templateId: t.id, reason: 'REFERENCE_UNAVAILABLE' });
    expect(Object.keys(rows[0]!).sort()).toEqual(['createdAt', 'field', 'id', 'memoryId', 'reason', 'role', 'templateId', 'templateRuleId']);
    const seen = await gql(as(admin), SKIPS, { m: m.id });
    expect(seen.errors, JSON.stringify(seen.errors)).toBeUndefined();
    expect(seen.data!.memoryConfig.defaultSkips).toMatchObject([{ role: 'spec', field: 'authorTask', reason: 'REFERENCE_UNAVAILABLE', sourceTemplate: { id: t.id }, refState: 'BROKEN' }]);
  });

  it('a non-manager creator sees no signal in the response, and cannot read the record', async () => {
    await tpl('skippy', [rule('spec', taskA)], { orgDefault: true });
    await db.node.update({ where: { id: taskA.id }, data: { deletedAt: new Date() } });
    const r = await gql(as(granted), CREATE_MEMORY, { o: org.id, n: 'quiet2', c: 'knowledge' });
    expect(r.errors).toBeUndefined();
    expect(JSON.stringify(r.data)).not.toMatch(/skip|warn|template|REFERENCE/i);
    const id = r.data!.createMemory.id;
    expect(await skipsOf(id)).toHaveLength(1);
    const peek = await gql(as(granted), SKIPS, { m: id });
    expect(peek.data?.memoryConfig ?? null).toBeNull();
    expect(errCode(peek)).toBeTruthy();
  });
});

describe('#3426 atomicity (C8)', () => {
  it('a template update in flight is waited for: a creation sees the flag as committed, not a stale one', async () => {
    const t = await tpl('base', [rule('spec', taskA)], { orgDefault: true });
    let release!: () => void;
    let held!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    const holding = new Promise<void>((r) => { held = r; });
    const updater = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "memory_config_templates" WHERE "id" = ${t.id} FOR UPDATE`;
      held();
      await hold;
      await tx.memoryConfigTemplate.update({ where: { id: t.id }, data: { orgDefault: false } });
    }, { timeout: 30_000 });
    await holding;
    const creating = gql(as(admin), CREATE_MEMORY, { o: org.id, n: 'inflight1', c: 'knowledge' });
    await waitForLockWaiters(db, 1);
    release();
    await updater;
    const r = await creating;
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect(await rulesOf(r.data!.createMemory.id)).toEqual([]);
  });

  it('defaultSkips re-checks the manage gate itself, not the parent\'s', async () => {
    await tpl('skippy', [rule('spec', taskA)], { orgDefault: true });
    await db.node.update({ where: { id: taskA.id }, data: { deletedAt: new Date() } });
    const m = await newMemory('direct1');
    const fieldResolvers = (resolvers as unknown as { MemoryConfig: { defaultSkips: (c: unknown, a: unknown, ctx: Context) => Promise<unknown[]> } }).MemoryConfig;
    await expect(fieldResolvers.defaultSkips({ memoryId: m.id }, {}, { db, roles: [], userId: granted } as Context)).rejects.toBeTruthy();
    await expect(fieldResolvers.defaultSkips({ memoryId: m.id }, {}, { db, roles: [], userId: admin } as Context)).resolves.toHaveLength(1);
  });

  it('an application failure rolls back the memory, its root node, rules and skip records', async () => {
    await tpl('base', [rule('spec', taskA)], { orgDefault: true });
    faults.materialize = true;
    const r = await gql(as(admin), CREATE_MEMORY, { o: org.id, n: 'boom1', c: 'knowledge' });
    expect(r.errors).toBeDefined();
    expect(await db.memory.count({ where: { urn: 'acme.com:boom1' } })).toBe(0);
    expect(await db.node.count({ where: { memory: { urn: 'acme.com:boom1' } } })).toBe(0);
    faults.materialize = false;
    const ok = await newMemory('boom1');
    expect((await rulesOf(ok.id)).map((x) => x.role)).toEqual(['spec']);
  });
});

describe('#3426 Q1 (ruling 0200): a broken REQUIRED default is planted fail-closed', () => {
  it('plants a locked rule with the marker set and a null id; the creation succeeds and writes of the role refuse AUTHOR_TASK_BROKEN', async () => {
    await tpl('policy', [rule('guide', taskA)], { orgDefault: true, required: true });
    await db.node.update({ where: { id: taskA.id }, data: { deletedAt: new Date() } }); // the id stays on the template rule
    const m = await newMemory('q1a');
    const rules = await rulesOf(m.id);
    expect(rules).toMatchObject([{ role: 'guide', locked: true, authorTaskId: null, authorTaskRequired: true }]);
    expect(await skipsOf(m.id)).toEqual([]);
    const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<unknown>>;
    await expect(M.createNode!({}, { input: { memoryId: m.id, loc: 'n1', name: 'n1', content: 'x', role: 'guide' } }, { db, roles: [], userId: admin } as Context))
      .rejects.toMatchObject({ extensions: { code: 'AUTHOR_TASK_BROKEN' } });
    // An admin repointing the rule clears the refusal.
    await db.nodeRoleRule.update({ where: { id: rules[0]!.id }, data: { authorTaskId: taskB.id } });
    await expect(M.createNode!({}, { input: { memoryId: m.id, loc: 'n1', name: 'n1', content: 'x', role: 'guide' } }, { db, roles: [], userId: admin } as Context))
      .rejects.toMatchObject({ extensions: { code: 'AUTHORING_ATTESTATION_MISSING' } });
  });

  it('a required default whose task was hard-deleted earlier is planted fail-closed too', async () => {
    await tpl('policy', [rule('guide', taskA)], { orgDefault: true, required: true });
    await db.node.delete({ where: { id: taskA.id } });
    const m = await newMemory('q1d');
    expect(await rulesOf(m.id)).toMatchObject([{ role: 'guide', locked: true, authorTaskId: null, authorTaskRequired: true }]);
  });

  it('a broken description in a required default drops only the description', async () => {
    await tpl('policy', [rule('guide', taskA, { descriptionNodeRef: docNode.urn, writers: 'ADMIN' })], { orgDefault: true, required: true });
    await db.node.update({ where: { id: docNode.id }, data: { deletedAt: new Date() } });
    const m = await newMemory('q1b');
    expect(await rulesOf(m.id)).toMatchObject([{ role: 'guide', writers: 'ADMIN', authorTaskId: taskA.id, descriptionNodeId: null }]);
  });

  it('a broken NON-required default is skipped with its record', async () => {
    await tpl('soft', [rule('guide', taskA)], { orgDefault: true });
    await db.node.delete({ where: { id: taskA.id } });
    const m = await newMemory('q1c');
    expect(await rulesOf(m.id)).toEqual([]);
    expect(await skipsOf(m.id)).toHaveLength(1);
  });
});
