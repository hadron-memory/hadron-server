/**
 * #1327 — the TASK_LESS_VISIBLE warning on rule create/update and template apply.
 *
 * A rule's required task is only useful to the people the rule binds: the
 * readers of the memory the rule governs. The manager saving the rule may read a
 * task that some of those readers cannot, so the save answers with an advisory
 * warning. These pins run the real GraphQL carriers against disposable fixtures:
 *
 *  - the warning's `(taskUrn, taskState)` is the caller's OWN reference
 *    projection (differential against the rule's `authorTask*` fields), and an
 *    UNREADABLE / BROKEN reference runs no audience comparison;
 *  - the audience is the TARGET memory's readers, compared by grant source
 *    (public, org, share grantees, group members, strict owner), and an unprovable
 *    containment warns;
 *  - template save carries none; dry run and real apply agree; a warning never
 *    changes the mutation's success.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
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

const W = 'warnings { code role field taskUrn taskState }';
const R = 'id role authorTask authorTaskState validationTask validationTaskState enabled';
const CREATE = `mutation($m: ID!, $i: CreateNodeRoleRuleInput!) { createNodeRoleRule(memoryRef: $m, input: $i) { rule { ${R} } ${W} } }`;
const UPDATE = `mutation($r: ID!, $i: UpdateNodeRoleRuleInput!) { updateNodeRoleRule(ref: $r, input: $i) { rule { ${R} } ${W} } }`;
const APPLY = `mutation($t: ID!, $m: ID!, $d: Boolean) {
  applyMemoryConfigTemplate(templateRef: $t, memoryRef: $m, dryRun: $d) { dryRun entries { role outcome rule { ${R} } } ${W} } }`;
const CREATE_TPL = `mutation($t: MemoryConfigTemplateOwnerType!, $o: ID, $i: CreateMemoryConfigTemplateInput!) {
  createMemoryConfigTemplate(ownerType: $t, ownerRef: $o, input: $i) { template { id revision } ${W} } }`;
const CONFIG = `query($m: ID!) { memoryConfig(memoryRef: $m) { id } }`;

let org: { id: string };
let otherOrg: { id: string };
let admin: string, member: string, memberB: string, outsider: string, owner: string;
let kb: { id: string; urn: string }; // org knowledge, the usual target
let kb2: { id: string; urn: string }; // org knowledge, same org
let pub: { id: string; urn: string }; // PUBLIC org knowledge
let group: { id: string; urn: string }; // group memory, members only
let mine: { id: string; urn: string }; // owner's personal memory
let mine2: { id: string; urn: string }; // owner's other personal memory
let tKb: { id: string; urn: string };
let tKb2: { id: string; urn: string };
let tPub: { id: string; urn: string };
let tGroup: { id: string; urn: string };
let tMine2: { id: string; urn: string };
let tForeign: { id: string; urn: string };

const as = (userId: string): Partial<Context> => ({ userId });

async function mkUser(n: number, orgId?: string, role?: 'OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER') {
  const u = await db.user.create({ data: { githubId: 91000 + n, githubUsername: `w${n}` } });
  if (orgId && role) await db.orgMember.create({ data: { organizationId: orgId, userId: u.id, role } });
  return u.id;
}
async function mkMemory(data: Record<string, unknown>) {
  const m = await db.memory.create({ data: { id: generateId(), ...data } as never, select: { id: true, urn: true } });
  return m;
}
async function mkTask(memoryId: string, memUrn: string, loc: string) {
  const n = await db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, isRunnable: true } });
  return { id: n.id, urn: `hrn:node:${memUrn}:${loc}` };
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'acme', urn: 'acme.com' }, select: { id: true } });
  otherOrg = await db.organization.create({ data: { id: generateId(), name: 'other', urn: 'other.com' }, select: { id: true } });
  admin = await mkUser(1, org.id, 'ADMIN');
  member = await mkUser(2, org.id, 'CONTRIBUTOR');
  memberB = await mkUser(3, org.id, 'CONTRIBUTOR');
  outsider = await mkUser(4, otherOrg.id, 'OWNER');
  owner = await mkUser(5, org.id, 'CONTRIBUTOR');
  const base = { organizationId: org.id, class: 'knowledge' };
  kb = await mkMemory({ ...base, urn: 'acme.com:kb', name: 'kb', visibility: 'ORGANIZATION' });
  kb2 = await mkMemory({ ...base, urn: 'acme.com:kb2', name: 'kb2', visibility: 'ORGANIZATION' });
  pub = await mkMemory({ ...base, urn: 'acme.com:pub', name: 'pub', visibility: 'PUBLIC' });
  group = await mkMemory({ organizationId: org.id, class: 'group', urn: 'acme.com:grp', name: 'grp', visibility: 'GROUP' });
  mine = await mkMemory({ organizationId: org.id, class: 'personal', userId: owner, urn: 'acme.com:mine', name: 'mine' });
  mine2 = await mkMemory({ organizationId: org.id, class: 'personal', userId: owner, urn: 'acme.com:mine2', name: 'mine2' });
  tKb = await mkTask(kb.id, kb.urn, 'tasks:author');
  tKb2 = await mkTask(kb2.id, kb2.urn, 'tasks:author');
  tPub = await mkTask(pub.id, pub.urn, 'tasks:author');
  tGroup = await mkTask(group.id, group.urn, 'tasks:author');
  tMine2 = await mkTask(mine2.id, mine2.urn, 'tasks:author');
  const foreign = await mkMemory({ organizationId: otherOrg.id, class: 'knowledge', urn: 'other.com:secret', name: 'secret', visibility: 'ORGANIZATION' });
  tForeign = await mkTask(foreign.id, foreign.urn, 'tasks:x');
  await db.memoryMember.create({ data: { memoryId: group.id, userId: admin, role: 'owner' } });
});

const warned = (r: Gql, field: 'createNodeRoleRule' | 'updateNodeRoleRule') => {
  expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
  return r.data![field].warnings as { code: string; role: string; field: string | null; taskUrn: string | null; taskState: string | null }[];
};

describe('#1327 — which memory readers the task is visible to', () => {
  it('a task in the target memory itself never warns', async () => {
    const r = await gql(as(admin), CREATE, { m: kb.id, i: { role: 'spec', authorTaskRef: tKb.urn } });
    expect(warned(r, 'createNodeRoleRule')).toEqual([]);
  });

  it('org-knowledge target, task in another org-knowledge memory of the SAME org: no warning', async () => {
    const r = await gql(as(admin), CREATE, { m: kb.id, i: { role: 'spec', authorTaskRef: tKb2.urn } });
    expect(warned(r, 'createNodeRoleRule')).toEqual([]);
  });

  it('PUBLIC target, task visible only to the org: warns, naming the readable task exactly as the rule projects it', async () => {
    const r = await gql(as(admin), CREATE, { m: pub.id, i: { role: 'spec', authorTaskRef: tKb.urn } });
    const w = warned(r, 'createNodeRoleRule');
    expect(w).toEqual([{ code: 'TASK_LESS_VISIBLE', role: 'spec', field: 'authorTask', taskUrn: tKb.urn, taskState: 'OK' }]);
    const rule = r.data!.createNodeRoleRule.rule;
    // Differential: the warning's pair IS the caller's own reference projection.
    expect([w[0].taskUrn, w[0].taskState]).toEqual([rule.authorTask, rule.authorTaskState]);
    expect(await db.nodeRoleRule.count()).toBe(1); // the warning never vetoes the save
  });

  it('PUBLIC target, task in a PUBLIC memory too: no warning', async () => {
    const r = await gql(as(admin), CREATE, { m: pub.id, i: { role: 'spec', authorTaskRef: tPub.urn } });
    expect(warned(r, 'createNodeRoleRule')).toEqual([]);
  });

  it('the validation task carries its own field name', async () => {
    const r = await gql(as(admin), CREATE, { m: pub.id, i: { role: 'spec', validationTaskRef: tKb.urn, validateBy: 'AGENT' } });
    expect(warned(r, 'createNodeRoleRule')).toEqual([
      { code: 'TASK_LESS_VISIBLE', role: 'spec', field: 'validationTask', taskUrn: tKb.urn, taskState: 'OK' },
    ]);
  });

  it('org-knowledge target, task in a group memory (members only): warns', async () => {
    // The admin is a group owner, so the task is readable to the saver; the other org members are not.
    const r = await gql(as(admin), CREATE, { m: kb.id, i: { role: 'spec', authorTaskRef: tGroup.urn } });
    expect(warned(r, 'createNodeRoleRule').map((x) => x.code)).toEqual(['TASK_LESS_VISIBLE']);
  });

  it('personal target: the strict owner reading the task is enough, and an org admin changes nothing', async () => {
    const r = await gql(as(owner), CREATE, { m: mine.id, i: { role: 'spec', authorTaskRef: tMine2.urn } });
    expect(warned(r, 'createNodeRoleRule')).toEqual([]);
    const adminTry = await gql(as(admin), CREATE, { m: mine.id, i: { role: 'review' } });
    expect(adminTry.errors?.[0]?.extensions?.code).toBe('MEMORY_NOT_FOUND'); // not a manager: no warning surface at all
  });

  it('personal target shared to a grantee who cannot read the task: warns; one who can: does not', async () => {
    await db.memoryShare.create({ data: { memoryId: mine.id, granteeId: member, grantorId: owner, role: 'reader' } });
    const r = await gql(as(owner), CREATE, { m: mine.id, i: { role: 'spec', authorTaskRef: tMine2.urn } });
    expect(warned(r, 'createNodeRoleRule').map((x) => x.code)).toEqual(['TASK_LESS_VISIBLE']); // member cannot read mine2
    await db.memoryShare.create({ data: { memoryId: mine2.id, granteeId: member, grantorId: owner, role: 'reader' } });
    const again = await gql(as(owner), UPDATE, { r: r.data!.createNodeRoleRule.rule.id, i: { enabled: false } });
    expect(warned(again, 'updateNodeRoleRule')).toEqual([]); // now member reads both
  });

  it('group target: every member reads the task, no warning; a member who cannot, warns', async () => {
    await db.memoryMember.create({ data: { memoryId: group.id, userId: member, role: 'reader' } });
    const ok = await gql(as(admin), CREATE, { m: group.id, i: { role: 'a', authorTaskRef: tKb.urn } });
    expect(warned(ok, 'createNodeRoleRule')).toEqual([]); // admin and member both read kb as org members
    await db.memoryMember.create({ data: { memoryId: group.id, userId: outsider, role: 'reader' } });
    const bad = await gql(as(admin), CREATE, { m: group.id, i: { role: 'b', authorTaskRef: tKb.urn } });
    expect(warned(bad, 'createNodeRoleRule').map((x) => x.code)).toEqual(['TASK_LESS_VISIBLE']); // outsider cannot read kb
    const pubTask = await gql(as(admin), CREATE, { m: group.id, i: { role: 'c', authorTaskRef: tPub.urn } });
    expect(warned(pubTask, 'createNodeRoleRule')).toEqual([]); // a PUBLIC task reaches everyone
  });

  it('subscribers of the target are an audience a different memory cannot be proven to cover: warns', async () => {
    const before = await gql(as(admin), CREATE, { m: kb.id, i: { role: 'before', authorTaskRef: tKb2.urn } });
    expect(warned(before, 'createNodeRoleRule')).toEqual([]); // paired control: same org knowledge, no subscriber
    await db.memorySubscription.create({ data: { memoryId: kb.id, organizationId: otherOrg.id } });
    const r = await gql(as(admin), CREATE, { m: kb.id, i: { role: 'after', authorTaskRef: tKb2.urn } });
    expect(warned(r, 'createNodeRoleRule').map((x) => x.code)).toEqual(['TASK_LESS_VISIBLE']);
  });
});

describe('#1327 — the caller\'s own reference projection decides, and UNREADABLE/BROKEN run no comparison', () => {
  it('UNREADABLE: warns with a null URN and the UNREADABLE state, equal to the rule\'s own projection', async () => {
    const created = await gql(as(admin), CREATE, { m: kb.id, i: { role: 'spec' } });
    const id = created.data!.createNodeRoleRule.rule.id;
    await db.nodeRoleRule.update({ where: { id }, data: { authorTaskId: tForeign.id, authorTaskRequired: true } });
    const r = await gql(as(admin), UPDATE, { r: id, i: { enabled: false } });
    const w = warned(r, 'updateNodeRoleRule');
    expect(w).toEqual([{ code: 'TASK_LESS_VISIBLE', role: 'spec', field: 'authorTask', taskUrn: null, taskState: 'UNREADABLE' }]);
    const rule = r.data!.updateNodeRoleRule.rule;
    expect([w[0].taskUrn, w[0].taskState]).toEqual([rule.authorTask, rule.authorTaskState]);
    // Nothing of the foreign task leaks anywhere in the response.
    expect(JSON.stringify(r)).not.toContain(tForeign.id);
    expect(JSON.stringify(r)).not.toContain('secret');
  });

  it('BROKEN: a required task that is gone warns with a null URN and BROKEN', async () => {
    const created = await gql(as(admin), CREATE, { m: kb.id, i: { role: 'spec' } });
    const id = created.data!.createNodeRoleRule.rule.id;
    await db.nodeRoleRule.update({ where: { id }, data: { authorTaskId: null, authorTaskRequired: true } });
    const r = await gql(as(admin), UPDATE, { r: id, i: { enabled: false } });
    expect(warned(r, 'updateNodeRoleRule')).toEqual([
      { code: 'TASK_LESS_VISIBLE', role: 'spec', field: 'authorTask', taskUrn: null, taskState: 'BROKEN' },
    ]);
  });

  it('NONE: a rule with no task warns about nothing', async () => {
    const r = await gql(as(admin), CREATE, { m: pub.id, i: { role: 'spec' } });
    expect(warned(r, 'createNodeRoleRule')).toEqual([]);
  });

  it('an unchanged task is still evaluated on update (the resulting rule, not the changed refs)', async () => {
    const created = await gql(as(admin), CREATE, { m: pub.id, i: { role: 'spec', authorTaskRef: tKb.urn } });
    const again = await gql(as(admin), UPDATE, { r: created.data!.createNodeRoleRule.rule.id, i: { enabled: false } });
    expect(warned(again, 'updateNodeRoleRule').map((x) => [x.field, x.taskState])).toEqual([['authorTask', 'OK']]);
  });

  it('a legacy OK task whose URN does not round-trip keeps a null taskUrn with state OK', async () => {
    const legacy = await mkMemory({ organizationId: org.id, class: 'knowledge', urn: 'acme.com:agentx:app-user:u1', name: 'legacy', visibility: 'ORGANIZATION' });
    const t = await mkTask(legacy.id, legacy.urn, 'tasks:l');
    const created = await gql(as(admin), CREATE, { m: pub.id, i: { role: 'spec' } });
    await db.nodeRoleRule.update({ where: { id: created.data!.createNodeRoleRule.rule.id }, data: { authorTaskId: t.id, authorTaskRequired: true } });
    const r = await gql(as(admin), UPDATE, { r: created.data!.createNodeRoleRule.rule.id, i: { enabled: false } });
    const w = warned(r, 'updateNodeRoleRule');
    const rule = r.data!.updateNodeRoleRule.rule;
    expect(w).toHaveLength(1);
    expect([w[0].taskUrn, w[0].taskState]).toEqual([rule.authorTask, rule.authorTaskState]);
  });
});

describe('#1327 — template apply carries the warning; template save does not', () => {
  const mkTemplate = async (taskRef: string) => {
    const r = await gql(as(admin), CREATE_TPL, { t: 'ORGANIZATION', o: org.id, i: { name: 'base', rules: [{ role: 'spec', authorTaskRef: taskRef }, { role: 'plain' }] } });
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    return r.data!.createMemoryConfigTemplate;
  };

  it('template save emits no TASK_LESS_VISIBLE (no target memory)', async () => {
    const saved = await mkTemplate(tKb.urn);
    expect(saved.warnings.filter((w: { code: string }) => w.code === 'TASK_LESS_VISIBLE')).toEqual([]);
  });

  it('dry run and real apply report the same warnings, and the dry run writes nothing', async () => {
    const t = (await mkTemplate(tKb.urn)).template;
    const dry = await gql(as(admin), APPLY, { t: t.id, m: pub.id, d: true });
    expect(dry.errors, JSON.stringify(dry.errors)).toBeUndefined();
    expect(await db.nodeRoleRule.count()).toBe(0);
    expect(await db.memoryConfig.count()).toBe(0);
    const real = await gql(as(admin), APPLY, { t: t.id, m: pub.id, d: false });
    expect(real.errors).toBeUndefined();
    const expected = [{ code: 'TASK_LESS_VISIBLE', role: 'spec', field: 'authorTask', taskUrn: tKb.urn, taskState: 'OK' }];
    expect(dry.data!.applyMemoryConfigTemplate.warnings).toEqual(expected);
    expect(real.data!.applyMemoryConfigTemplate.warnings).toEqual(expected);
  });

  it('apply to a memory whose readers can all read the task: none', async () => {
    const t = (await mkTemplate(tKb2.urn)).template;
    const r = await gql(as(admin), APPLY, { t: t.id, m: kb.id });
    expect(r.data!.applyMemoryConfigTemplate.warnings).toEqual([]);
  });

  it('a skipped role (the memory\'s own rule stands) is not evaluated: only rules the apply writes count', async () => {
    const t = (await mkTemplate(tKb.urn)).template;
    await gql(as(admin), CREATE, { m: pub.id, i: { role: 'spec' } });
    const r = await gql(as(admin), APPLY, { t: t.id, m: pub.id });
    expect(r.data!.applyMemoryConfigTemplate.entries.find((e: { role: string }) => e.role === 'spec').outcome).toBe('SKIPPED_CONFLICT');
    expect(r.data!.applyMemoryConfigTemplate.warnings).toEqual([]);
  });
});

describe('#1327 — regression: non-managers still get concealment and no warning surface', () => {
  it('a non-manager gets MEMORY_NOT_FOUND from memoryConfig and from a rule create', async () => {
    expect((await gql(as(memberB), CONFIG, { m: pub.id })).errors?.[0]?.extensions?.code).toBe('MEMORY_NOT_FOUND');
    expect((await gql(as(memberB), CREATE, { m: pub.id, i: { role: 'spec', authorTaskRef: tKb.urn } })).errors?.[0]?.extensions?.code).toBe('MEMORY_NOT_FOUND');
    expect((await gql(as(outsider), CREATE, { m: pub.id, i: { role: 'spec' } })).errors?.[0]?.extensions?.code).toBe('MEMORY_NOT_FOUND');
  });
});
