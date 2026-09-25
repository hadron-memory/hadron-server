/**
 * #1325 part (c) — the MemoryConfigTemplate API, through the executable schema
 * with the production error formatter, so the codes asserted here are the wire
 * codes the CLI (hadron-cli#716 slice 2) maps.
 *
 * Owner gates per kind (H4: a template's owner's managers), concealment,
 * names, rules (validated as a whole, replaced wholesale), OCC, paging.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import type { Role } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';
import { formatGraphQLError } from '../formatError.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

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
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RULE = `role authorTask authorTaskId authorTaskState validationTask validationTaskState descriptionNode descriptionNodeState
  strictSubRoles writers validateBy enabled`;
const TPL = `id name description required ownerType ownerId revision createdBy updatedBy rules { ${RULE} }`;
const ONE = `query($r: ID!) { memoryConfigTemplate(ref: $r) { ${TPL} } }`;
const LIST = `query($f: MemoryConfigTemplateFilter, $l: Int, $o: Int) { memoryConfigTemplates(filter: $f, limit: $l, offset: $o) { total items { id name ownerType } } }`;
const CREATE = `mutation($t: MemoryConfigTemplateOwnerType!, $o: ID, $i: CreateMemoryConfigTemplateInput!) {
  createMemoryConfigTemplate(ownerType: $t, ownerRef: $o, input: $i) { template { ${TPL} } warnings { code } } }`;
const UPDATE = `mutation($r: ID!, $i: UpdateMemoryConfigTemplateInput!, $v: Int) { updateMemoryConfigTemplate(ref: $r, input: $i, expectedRevision: $v) { template { ${TPL} } } }`;
const DELETE = `mutation($r: ID!, $v: Int) { deleteMemoryConfigTemplate(ref: $r, expectedRevision: $v) }`;

let org: { id: string; urn: string };
let otherOrg: { id: string; urn: string };
let orgOwner: string, orgAdmin: string, contributor: string, outsider: string, userA: string, userB: string, platformAdmin: string;
let orgApp: { id: string }, userApp: { id: string }, goneApp: { id: string };
let task: { id: string; urn: string };
let plainNode: { id: string; urn: string };
let foreignTask: { id: string };

const as = (userId: string, extra: Partial<Context> = {}): Partial<Context> => ({ userId, ...extra });
const admin = (): Partial<Context> => as(platformAdmin, { roles: ['ADMIN'] });
const imp = (target: string, orgId: string): Partial<Context> =>
  as(target, { impersonation: { sessionId: 'imp', actorUserId: platformAdmin, orgId, expiresAt: new Date(Date.now() + 60_000) } } as Partial<Context>);

async function mkUser(n: number, orgId?: string, role?: 'OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER', roles: Role[] = []) {
  const u = await db.user.create({ data: { githubId: 71000 + n, githubUsername: `t${n}`, roles } });
  if (orgId && role) await db.orgMember.create({ data: { organizationId: orgId, userId: u.id, role } });
  return u.id;
}

const create = (ctx: Partial<Context>, ownerType: string, ownerRef: string | null, i: Record<string, unknown>) =>
  gql(ctx, CREATE, { t: ownerType, o: ownerRef, i });
const mkOrgTpl = async (i: Record<string, unknown> = {}) =>
  (await create(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'base', ...i })).data!.createMemoryConfigTemplate.template;

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'acme', urn: 'acme.com' }, select: { id: true, urn: true } });
  otherOrg = await db.organization.create({ data: { id: generateId(), name: 'other', urn: 'other.com' }, select: { id: true, urn: true } });
  orgOwner = await mkUser(1, org.id, 'OWNER');
  orgAdmin = await mkUser(2, org.id, 'ADMIN');
  contributor = await mkUser(3, org.id, 'CONTRIBUTOR');
  outsider = await mkUser(4, otherOrg.id, 'OWNER');
  userA = await mkUser(5);
  userB = await mkUser(6);
  platformAdmin = await mkUser(7, undefined, undefined, ['ADMIN']);
  orgApp = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'team', urn: 'acme.com:team' } });
  userApp = await db.app.create({ data: { id: generateId(), ownerUserId: userA, name: 'tools', urn: '@t5:tools' } });
  goneApp = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'gone', urn: 'acme.com:gone', uninstalledAt: new Date() } });
  await db.hadronServer.create({ data: { id: generateId(), url: 'https://hc.test' } });
  const kb = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: 'acme.com:kb', name: 'kb', class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  const t = await db.node.create({ data: { id: generateId(), memoryId: kb.id, loc: 'tasks:author', name: 'Author', isRunnable: true } });
  task = { id: t.id, urn: 'hrn:node:acme.com:kb:tasks:author' };
  const p = await db.node.create({ data: { id: generateId(), memoryId: kb.id, loc: 'guide', name: 'Guide' } });
  plainNode = { id: p.id, urn: 'hrn:node:acme.com:kb:guide' };
  const secret = await db.memory.create({
    data: { id: generateId(), organizationId: otherOrg.id, urn: 'other.com:secret', name: 'secret', class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  foreignTask = await db.node.create({ data: { id: generateId(), memoryId: secret.id, loc: 'tasks:x', name: 'X', isRunnable: true } });
});

describe('owner gates on create (H4: the owner\'s managers)', () => {
  it('ORGANIZATION: org OWNER, ADMIN and a platform admin; not a CONTRIBUTOR or an outsider', async () => {
    for (const [ctx, n] of [[as(orgOwner), 'o1'], [as(orgAdmin), 'o2'], [admin(), 'o3']] as const) {
      const r = await create(ctx, 'ORGANIZATION', org.urn, { name: n });
      expect(r.errors, n).toBeUndefined();
      expect(r.data!.createMemoryConfigTemplate.template).toMatchObject({ ownerType: 'ORGANIZATION', ownerId: org.id, revision: 1 });
    }
    for (const u of [contributor, outsider]) expect((await create(as(u), 'ORGANIZATION', org.id, { name: 'x' })).errors).toBeDefined();
    expect(await db.memoryConfigTemplate.count()).toBe(3);
  });

  it('USER: yourself only — ownerRef omitted or naming you; never another user, never a platform admin for you', async () => {
    const r = await create(as(userA), 'USER', null, { name: 'mine' });
    expect(r.data!.createMemoryConfigTemplate.template).toMatchObject({ ownerType: 'USER', ownerId: userA });
    expect((await create(as(userA), 'USER', userA, { name: 'mine2' })).errors).toBeUndefined();
    expect((await create(as(userA), 'USER', userB, { name: 'theirs' })).errors).toBeDefined();
    expect((await create(admin(), 'USER', userA, { name: 'forced' })).errors).toBeDefined();
    expect(await db.memoryConfigTemplate.count({ where: { ownerUserId: userB } })).toBe(0);
  });

  it('APP: an org App to its org admins, a user-owned App to its owner only; an uninstalled App to no one', async () => {
    expect((await create(as(orgAdmin), 'APP', orgApp.id, { name: 'a1' })).errors).toBeUndefined();
    expect((await create(as(contributor), 'APP', orgApp.id, { name: 'a2' })).errors).toBeDefined();
    expect((await create(as(userA), 'APP', userApp.id, { name: 'a3' })).errors).toBeUndefined();
    expect((await create(admin(), 'APP', userApp.id, { name: 'a4' })).errors).toBeDefined();
    expect((await create(as(orgAdmin), 'APP', goneApp.id, { name: 'a5' })).errors).toBeDefined();
    expect(await db.memoryConfigTemplate.count()).toBe(2);
  });

  it('HADRON_SERVER: a platform admin, no ownerRef; the server id is not exposed', async () => {
    const r = await create(admin(), 'HADRON_SERVER', null, { name: 's1' });
    expect(r.errors).toBeUndefined();
    expect(r.data!.createMemoryConfigTemplate.template).toMatchObject({ ownerType: 'HADRON_SERVER', ownerId: null });
    expect((await create(as(orgAdmin), 'HADRON_SERVER', null, { name: 's2' })).errors).toBeDefined();
    const wrong = await create(admin(), 'HADRON_SERVER', generateId(), { name: 's3' });
    expect(wrong.errors![0].extensions).toMatchObject({ code: 'BAD_USER_INPUT', field: 'ownerRef' });
  });

  it('HADRON_SERVER with no live server row refuses HADRON_SERVER_NOT_CONFIGURED, never a guess (H6)', async () => {
    await db.hadronServer.updateMany({ data: { deletedAt: new Date() } });
    expect(code(await create(admin(), 'HADRON_SERVER', null, { name: 's1' }))).toBe('HADRON_SERVER_NOT_CONFIGURED');
    expect(await db.memoryConfigTemplate.count()).toBe(0);
  });

  it('impersonation never writes a template', async () => {
    expect((await create(imp(orgAdmin, org.id), 'ORGANIZATION', org.id, { name: 'x' })).errors).toBeDefined();
    expect(await db.memoryConfigTemplate.count()).toBe(0);
  });
});

describe('reads: a template you do not manage does not exist', () => {
  it('memoryConfigTemplate is null for a non-manager exactly as for a missing or deleted one', async () => {
    const t = await mkOrgTpl();
    expect((await gql(as(orgAdmin), ONE, { r: t.id })).data!.memoryConfigTemplate).toMatchObject({ id: t.id, name: 'base' });
    for (const u of [contributor, outsider, userA]) {
      const r = await gql(as(u), ONE, { r: t.id });
      expect(r.errors).toBeUndefined();
      expect(r.data!.memoryConfigTemplate).toBeNull();
    }
    expect((await gql(as(orgAdmin), ONE, { r: generateId() })).data!.memoryConfigTemplate).toBeNull();
    await gql(as(orgAdmin), DELETE, { r: t.id });
    expect((await gql(as(orgAdmin), ONE, { r: t.id })).data!.memoryConfigTemplate).toBeNull();
  });

  it('a user-owned template is its owner\'s alone — not a platform admin\'s', async () => {
    const t = (await create(as(userA), 'USER', null, { name: 'mine' })).data!.createMemoryConfigTemplate.template;
    expect((await gql(as(userA), ONE, { r: t.id })).data!.memoryConfigTemplate).not.toBeNull();
    expect((await gql(admin(), ONE, { r: t.id })).data!.memoryConfigTemplate).toBeNull();
    expect((await gql(as(userB), ONE, { r: t.id })).data!.memoryConfigTemplate).toBeNull();
  });

  it('impersonation reads what its target manages in the shared org only, and no user-owned template', async () => {
    const t = await mkOrgTpl();
    const u = (await create(as(orgAdmin), 'USER', null, { name: 'mine' })).data!.createMemoryConfigTemplate.template;
    expect((await gql(imp(orgAdmin, org.id), ONE, { r: t.id })).data!.memoryConfigTemplate).not.toBeNull();
    expect((await gql(imp(orgAdmin, otherOrg.id), ONE, { r: t.id })).data!.memoryConfigTemplate).toBeNull();
    expect((await gql(imp(orgAdmin, org.id), ONE, { r: u.id })).data!.memoryConfigTemplate).toBeNull();
    const list = (await gql(imp(orgAdmin, org.id), LIST)).data!.memoryConfigTemplates;
    expect(list.items.map((x: { id: string }) => x.id)).toEqual([t.id]);
    expect((await gql(imp(orgAdmin, otherOrg.id), LIST)).data!.memoryConfigTemplates).toEqual({ total: 0, items: [] });
  });

  it('an App that is uninstalled takes its templates out of reach, on both read paths', async () => {
    const t = (await create(as(orgAdmin), 'APP', orgApp.id, { name: 'app-one' })).data!.createMemoryConfigTemplate.template;
    await db.app.update({ where: { id: orgApp.id }, data: { uninstalledAt: new Date() } });
    expect((await gql(as(orgAdmin), ONE, { r: t.id })).data!.memoryConfigTemplate).toBeNull();
    expect((await gql(as(orgAdmin), LIST)).data!.memoryConfigTemplates.total).toBe(0);
  });

  it('an operational failure in the manage gate propagates instead of reading as a missing template', async () => {
    const t = await mkOrgTpl();
    const spy = vi.spyOn(db.orgMember, 'findFirst').mockRejectedValue(new Error('connection timeout'));
    try {
      const r = await gql(as(orgAdmin), ONE, { r: t.id });
      expect(r.errors).toBeDefined();
      expect(code(await gql(as(orgAdmin), UPDATE, { r: t.id, i: { required: true } }))).not.toBe('MEMORY_CONFIG_TEMPLATE_NOT_FOUND');
    } finally {
      spy.mockRestore();
    }
  });

  it('the list is exactly the templates you manage, across owner kinds, name-ascending', async () => {
    const o = await mkOrgTpl({ name: 'org-one' });
    const a = (await create(as(orgAdmin), 'APP', orgApp.id, { name: 'app-one' })).data!.createMemoryConfigTemplate.template;
    const mine = (await create(as(orgAdmin), 'USER', null, { name: 'mine' })).data!.createMemoryConfigTemplate.template;
    await create(as(userA), 'USER', null, { name: 'not-yours' });
    await create(as(userA), 'APP', userApp.id, { name: 'not-yours-either' });
    await create(admin(), 'HADRON_SERVER', null, { name: 'server-one' });
    await create(as(outsider), 'ORGANIZATION', otherOrg.id, { name: 'elsewhere' });
    const got = (await gql(as(orgAdmin), LIST)).data!.memoryConfigTemplates;
    expect(got.items.map((x: { id: string }) => x.id)).toEqual([a.id, mine.id, o.id]);
    expect(got.total).toBe(3);
    // A CONTRIBUTOR manages nothing here.
    expect((await gql(as(contributor), LIST)).data!.memoryConfigTemplates).toEqual({ total: 0, items: [] });
    // A platform admin: the server's and every organization's and org App's, but no user's own.
    const pa = (await gql(admin(), LIST)).data!.memoryConfigTemplates.items.map((x: { name: string }) => x.name);
    expect(pa).toEqual(['app-one', 'elsewhere', 'org-one', 'server-one']);
  });

  it('the filter narrows and never widens; an unresolvable owner ref matches nothing; limit 0 is the count', async () => {
    await mkOrgTpl({ name: 'org-one' });
    await create(as(orgAdmin), 'APP', orgApp.id, { name: 'app-one' });
    await create(as(outsider), 'ORGANIZATION', otherOrg.id, { name: 'elsewhere' });
    const f = async (filter: Record<string, unknown>) =>
      (await gql(as(orgAdmin), LIST, { f: filter })).data!.memoryConfigTemplates.items.map((x: { name: string }) => x.name);
    expect(await f({ ownerType: 'ORGANIZATION' })).toEqual(['org-one']);
    expect(await f({ ownerType: 'ORGANIZATION', ownerRef: otherOrg.id })).toEqual([]);
    expect(await f({ ownerType: 'APP', ownerRef: orgApp.id })).toEqual(['app-one']);
    expect(await f({ ownerType: 'APP', ownerRef: generateId() })).toEqual([]);
    expect(code(await gql(as(orgAdmin), LIST, { f: { ownerRef: org.id } }))).toBe('BAD_USER_INPUT');
    expect((await gql(as(orgAdmin), LIST, { l: 0 })).data!.memoryConfigTemplates).toEqual({ total: 2, items: [] });
    expect((await gql(as(orgAdmin), LIST, { l: 1, o: 1 })).data!.memoryConfigTemplates.items.map((x: { name: string }) => x.name)).toEqual(['org-one']);
  });
});

describe('names', () => {
  it.each(['', 'Base', 'has space', '-lead', 'x'.repeat(65)])('name %j is BAD_USER_INPUT on field name', async (name) => {
    const r = await create(as(orgAdmin), 'ORGANIZATION', org.id, { name });
    expect(r.errors![0].extensions).toMatchObject({ code: 'BAD_USER_INPUT', field: 'name' });
  });

  it('unique per owner among LIVE templates: a second is refused, another owner may reuse it, a deleted one does not block', async () => {
    const t = await mkOrgTpl();
    const dup = await create(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'base' });
    expect(code(dup)).toBe('MEMORY_CONFIG_TEMPLATE_EXISTS');
    expect((await create(as(orgAdmin), 'APP', orgApp.id, { name: 'base' })).errors).toBeUndefined();
    await gql(as(orgAdmin), DELETE, { r: t.id });
    expect((await create(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'base' })).errors).toBeUndefined();
  });

  it('a rename onto another live template\'s name is refused and changes nothing', async () => {
    await mkOrgTpl({ name: 'taken' });
    const t = await mkOrgTpl({ name: 'free' });
    expect(code(await gql(as(orgAdmin), UPDATE, { r: t.id, i: { name: 'taken' } }))).toBe('MEMORY_CONFIG_TEMPLATE_EXISTS');
    expect((await db.memoryConfigTemplate.findUniqueOrThrow({ where: { id: t.id } })).name).toBe('free');
  });
});

describe('rules: validated as a whole, stored like a config\'s', () => {
  it('references go in as URNs, are stored as ids, and come out with their state; settings are stored', async () => {
    const t = await mkOrgTpl({
      rules: [
        { role: 'spec', authorTaskRef: task.urn, validationTaskRef: task.id, descriptionNodeRef: plainNode.urn, validateBy: 'AGENT', strictSubRoles: true },
        { role: 'spec.rule', writers: 'ADMIN', enabled: false },
      ],
    });
    expect(t.rules).toEqual([
      expect.objectContaining({ role: 'spec', authorTask: task.urn, authorTaskId: task.id, authorTaskState: 'OK', validationTaskState: 'OK', descriptionNode: plainNode.urn, validateBy: 'AGENT', strictSubRoles: true }),
      expect.objectContaining({ role: 'spec.rule', authorTaskState: 'NONE', writers: 'ADMIN', enabled: false }),
    ]);
    const row = await db.memoryConfigTemplateRule.findFirstOrThrow({ where: { role: 'spec' } });
    expect([row.authorTaskId, row.authorTaskRequired, row.validationTaskRequired]).toEqual([task.id, true, true]);
  });

  it.each([
    ['an unreadable task', () => ({ role: 'spec', authorTaskRef: foreignTask.id }), 'NODE_NOT_FOUND'],
    ['a missing task', () => ({ role: 'spec', authorTaskRef: generateId() }), 'NODE_NOT_FOUND'],
    ['a non-runnable task', () => ({ role: 'spec', authorTaskRef: plainNode.urn }), 'NOT_A_TASK'],
    ['a bad role', () => ({ role: 'Spec' }), 'INVALID_NODE_ROLE'],
    ['validateBy without a task', () => ({ role: 'spec', validateBy: 'PLATFORM' }), 'BAD_USER_INPUT'],
  ])('%s in the SECOND rule refuses %s, and nothing is written', async (_n, bad, want) => {
    const r = await create(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'base', rules: [{ role: 'ok' }, bad()] });
    expect(code(r)).toBe(want);
    expect(await db.memoryConfigTemplate.count()).toBe(0);
    expect(await db.memoryConfigTemplateRule.count()).toBe(0);
  });

  it('a role listed twice is NODE_ROLE_RULE_EXISTS', async () => {
    const r = await create(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'base', rules: [{ role: 'spec' }, { role: 'spec' }] });
    expect(r.errors![0].extensions).toMatchObject({ code: 'NODE_ROLE_RULE_EXISTS', role: 'spec' });
  });

  it('fail closed (H5): a hard-deleted task leaves the rule BROKEN, not unrequired', async () => {
    const t = await mkOrgTpl({ rules: [{ role: 'spec', authorTaskRef: task.urn }] });
    await db.node.delete({ where: { id: task.id } });
    const got = (await gql(as(orgAdmin), ONE, { r: t.id })).data!.memoryConfigTemplate.rules[0];
    expect(got).toMatchObject({ authorTask: null, authorTaskId: null, authorTaskState: 'BROKEN' });
  });

  it('a task made non-runnable while the write is in flight is refused NOT_A_TASK', async () => {
    let creating: Promise<Gql> | undefined;
    await db.$transaction(async (tx) => {
      await tx.node.update({ where: { id: task.id }, data: { isRunnable: false } });
      creating = create(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'base', rules: [{ role: 'spec', authorTaskRef: task.urn }] });
      await pause(400);
    });
    expect(code(await creating!)).toBe('NOT_A_TASK');
    expect(await db.memoryConfigTemplate.count()).toBe(0);
  });
});

describe('update and delete: wholesale rules, optimistic concurrency, soft delete', () => {
  it('rules given REPLACE the list; rules omitted keep it; revision and updatedBy move', async () => {
    const t = await mkOrgTpl({ description: 'd', rules: [{ role: 'spec' }, { role: 'review' }] });
    const kept = (await gql(as(orgOwner), UPDATE, { r: t.id, i: { required: true } })).data!.updateMemoryConfigTemplate.template;
    expect(kept).toMatchObject({ required: true, revision: 2, updatedBy: orgOwner, description: 'd' });
    expect(kept.rules.map((x: { role: string }) => x.role)).toEqual(['review', 'spec']);
    const replaced = (await gql(as(orgAdmin), UPDATE, { r: t.id, i: { rules: [{ role: 'guide', descriptionNodeRef: plainNode.id }], description: null } }))
      .data!.updateMemoryConfigTemplate.template;
    expect(replaced).toMatchObject({ revision: 3, description: null });
    expect(replaced.rules.map((x: { role: string }) => x.role)).toEqual(['guide']);
    expect(await db.memoryConfigTemplateRule.count({ where: { templateId: t.id } })).toBe(1);
  });

  it('a failing replacement leaves the old rules and revision untouched', async () => {
    const t = await mkOrgTpl({ rules: [{ role: 'spec' }] });
    const r = await gql(as(orgAdmin), UPDATE, { r: t.id, i: { rules: [{ role: 'new' }, { role: 'x', authorTaskRef: plainNode.id }] } });
    expect(code(r)).toBe('NOT_A_TASK');
    const row = await db.memoryConfigTemplate.findUniqueOrThrow({ where: { id: t.id }, include: { rules: true } });
    expect([row.revision, row.rules.map((x) => x.role)]).toEqual([1, ['spec']]);
  });

  it('a stale expectedRevision is CONFLICT with currentRevision, for update and delete, and writes nothing', async () => {
    const t = await mkOrgTpl();
    await gql(as(orgAdmin), UPDATE, { r: t.id, i: { required: true }, v: 1 });
    const stale = await gql(as(orgOwner), UPDATE, { r: t.id, i: { name: 'renamed' }, v: 1 });
    expect(stale.errors![0].extensions).toMatchObject({ code: 'CONFLICT', currentRevision: 2 });
    expect(code(await gql(as(orgOwner), DELETE, { r: t.id, v: 1 }))).toBe('CONFLICT');
    const row = await db.memoryConfigTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect([row.name, row.revision, row.deletedAt]).toEqual(['base', 2, null]);
  });

  it('a template you may not manage is MEMORY_CONFIG_TEMPLATE_NOT_FOUND on update and delete, like a missing one', async () => {
    const t = await mkOrgTpl();
    for (const [q, v] of [[UPDATE, { r: t.id, i: { required: true } }], [DELETE, { r: t.id }]] as const) {
      expect(code(await gql(as(contributor), q, v))).toBe('MEMORY_CONFIG_TEMPLATE_NOT_FOUND');
      expect(code(await gql(as(orgAdmin), q, { ...v, r: generateId() }))).toBe('MEMORY_CONFIG_TEMPLATE_NOT_FOUND');
    }
    expect((await db.memoryConfigTemplate.findUniqueOrThrow({ where: { id: t.id } })).required).toBe(false);
  });

  it('delete is soft, stamps the actor, and a deleted template takes no further writes', async () => {
    const t = await mkOrgTpl({ rules: [{ role: 'spec' }] });
    expect((await gql(as(orgAdmin), DELETE, { r: t.id, v: 1 })).data!.deleteMemoryConfigTemplate).toBe(true);
    const row = await db.memoryConfigTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedBy).toBe(orgAdmin);
    expect(await db.memoryConfigTemplateRule.count({ where: { templateId: t.id } })).toBe(1);
    expect(code(await gql(as(orgAdmin), UPDATE, { r: t.id, i: { required: true } }))).toBe('MEMORY_CONFIG_TEMPLATE_NOT_FOUND');
  });

  it('concurrent updates serialize: each returns its own write and a distinct revision', async () => {
    const t = await mkOrgTpl();
    const descs = ['a', 'b', 'c', 'd', 'e', 'f'];
    const out = await Promise.all(descs.map((d) => gql(as(orgAdmin), UPDATE, { r: t.id, i: { description: d } })));
    const got = out.map((r) => r.data!.updateMemoryConfigTemplate.template);
    expect(got.map((g) => g.description)).toEqual(descs);
    expect(new Set(got.map((g) => g.revision)).size).toBe(descs.length);
  });
});
