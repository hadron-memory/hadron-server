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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';
import { formatGraphQLError } from '../formatError.js';
import { newWarningScope, taskVisibilityWarnings, type WarningScope } from './resolvers.memoryConfigWarnings.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
// The bulk apply builds its ONE scope through this export; a test can hand it a smaller budget (the default stays real).
const scopeBudget = vi.hoisted(() => ({ override: null as number | null }));
vi.mock('./resolvers.memoryConfigWarnings.js', async (orig) => {
  const actual = await orig<typeof import('./resolvers.memoryConfigWarnings.js')>();
  return { ...actual, newWarningScope: (b?: number) => actual.newWarningScope(scopeBudget.override ?? b) };
});
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

describe('#1327 — shapes whose audience is not provable warn, and a user-owned target is its owner alone', () => {
  it('an Agent memory item on the target reaches App participants: warns although the task is same-org knowledge', async () => {
    const control = await gql(as(admin), CREATE, { m: kb.id, i: { role: 'before', authorTaskRef: tKb2.urn } });
    expect(warned(control, 'createNodeRoleRule')).toEqual([]);
    const agent = await db.agent.create({ data: { name: 'Agent', urn: 'acme.com:agent', organizationId: org.id } });
    await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: kb.id, role: 'read' } });
    const r = await gql(as(admin), CREATE, { m: kb.id, i: { role: 'after', authorTaskRef: tKb2.urn } });
    expect(warned(r, 'createNodeRoleRule').map((x) => x.code)).toEqual(['TASK_LESS_VISIBLE']);
  });

  it('a user-owned target is owner-only: the owner reading the task is enough', async () => {
    const owned = await mkMemory({ ownerUserId: owner, urn: '@w5:notes', name: 'notes', class: 'knowledge' });
    const t = await mkTask(owned.id, owned.urn, 'tasks:n');
    const other = await mkMemory({ ownerUserId: owner, urn: '@w5:other', name: 'other', class: 'knowledge' });
    const r = await gql(as(owner), CREATE, { m: owned.id, i: { role: 'spec', authorTaskRef: t.urn } });
    expect(warned(r, 'createNodeRoleRule')).toEqual([]);
    const ot = await mkTask(other.id, other.urn, 'tasks:o');
    const r2 = await gql(as(owner), CREATE, { m: owned.id, i: { role: 'two', authorTaskRef: ot.urn } });
    expect(warned(r2, 'createNodeRoleRule')).toEqual([]); // the owner reads both, and nobody else reads `owned`
  });

  it('an App-class target is a team audience that cannot be proven: warns', async () => {
    const app = await db.app.create({ data: { name: 'App', urn: 'acme.com:app', organizationId: org.id } as never });
    const team = await mkMemory({ organizationId: org.id, appId: app.id, class: 'app', urn: 'acme.com:app:team', name: 'team' });
    const r = await gql(as(admin), CREATE, { m: team.id, i: { role: 'spec', authorTaskRef: tKb.urn } });
    expect(warned(r, 'createNodeRoleRule').map((x) => x.code)).toEqual(['TASK_LESS_VISIBLE']);
  });

  it('more explicit grantees than can be point-checked within the bound warn instead of being skipped', async () => {
    for (let i = 0; i < 51; i++) {
      const u = await mkUser(200 + i, org.id, 'CONTRIBUTOR');
      await db.memoryShare.create({ data: { memoryId: mine.id, granteeId: u, grantorId: owner, role: 'reader' } });
      await db.memoryShare.create({ data: { memoryId: mine2.id, granteeId: u, grantorId: owner, role: 'reader' } });
    }
    const r = await gql(as(owner), CREATE, { m: mine.id, i: { role: 'spec', authorTaskRef: tMine2.urn } });
    expect(warned(r, 'createNodeRoleRule').map((x) => x.code)).toEqual(['TASK_LESS_VISIBLE']);
  });
});

describe('#1327 — containment shortcuts are each load-bearing', () => {
  const teamSpace = async () => {
    const app = await db.app.create({ data: { name: 'App', urn: 'acme.com:app2', organizationId: org.id } as never });
    const team = await mkMemory({ organizationId: org.id, appId: app.id, class: 'app', urn: 'acme.com:app2:team', name: 'team2' });
    return { team };
  };

  it('a task in the target memory itself never warns even where other audiences are unprovable (subscribed target)', async () => {
    await db.memorySubscription.create({ data: { memoryId: kb.id, organizationId: otherOrg.id } });
    const r = await gql(as(admin), CREATE, { m: kb.id, i: { role: 'spec', authorTaskRef: tKb.urn } });
    expect(warned(r, 'createNodeRoleRule')).toEqual([]);
  });

  it('a PUBLIC task memory covers an audience that is not enumerable (App team space target)', async () => {
    const { team } = await teamSpace();
    const r = await gql(as(admin), CREATE, { m: team.id, i: { role: 'spec', authorTaskRef: tPub.urn } });
    expect(warned(r, 'createNodeRoleRule')).toEqual([]);
  });

  it('PUBLIC target and a DIFFERENT PUBLIC task memory: no warning', async () => {
    const pub2 = await mkMemory({ organizationId: org.id, class: 'knowledge', urn: 'acme.com:pub2', name: 'pub2', visibility: 'PUBLIC' });
    const t = await mkTask(pub2.id, pub2.urn, 'tasks:p');
    const r = await gql(as(admin), CREATE, { m: pub.id, i: { role: 'spec', authorTaskRef: t.urn } });
    expect(warned(r, 'createNodeRoleRule')).toEqual([]);
  });

  it('org knowledge target, task in ANOTHER org\'s knowledge that the saver can also read: warns', async () => {
    await db.orgMember.create({ data: { organizationId: otherOrg.id, userId: admin, role: 'CONTRIBUTOR' } });
    const r = await gql(as(admin), CREATE, { m: kb.id, i: { role: 'spec', authorTaskRef: tForeign.urn } });
    expect(warned(r, 'createNodeRoleRule').map((x) => x.code)).toEqual(['TASK_LESS_VISIBLE']);
  });
});

// ---- fix head: App run grants, a fault in the advisory reads, the no-comparison read traps ----

const WARN = (role: string, field: 'authorTask' | 'validationTask', taskUrn: string | null, taskState: string | null) =>
  ({ code: 'TASK_LESS_VISIBLE', role, field, taskUrn, taskState });

describe('#1327 — a live App write or automation read grant on the target is an audience not provable here', () => {
  const mkApp = (urn: string) => db.app.create({ data: { name: urn, urn, organizationId: org.id } as never });
  const writeGrant = (appId: string, memoryId: string, revokedAt: Date | null = null) =>
    db.appMemoryWriteGrant.create({ data: { appId, memoryId, prefix: 'notes', grantedBy: admin, revokedAt, revokedBy: revokedAt ? admin : null } });
  const autoGrant = (appId: string, memoryId: string, revokedAt: Date | null = null) =>
    db.appAutomationReadGrant.create({ data: { appId, memoryId, triggerKind: 'SCHEDULE', triggerId: generateId(), grantedBy: admin, revokedAt, revokedBy: revokedAt ? admin : null } });

  it('org knowledge target: a live write grant warns; the same save without it, or with the grant revoked, does not', async () => {
    const app = await mkApp('acme.com:wg');
    const control = await gql(as(admin), CREATE, { m: kb.id, i: { role: 'ctl', authorTaskRef: tKb2.urn } });
    expect(warned(control, 'createNodeRoleRule')).toEqual([]);
    await writeGrant(app.id, kb.id, new Date());
    const revoked = await gql(as(admin), CREATE, { m: kb.id, i: { role: 'rev', authorTaskRef: tKb2.urn } });
    expect(warned(revoked, 'createNodeRoleRule')).toEqual([]);
    await writeGrant(app.id, kb.id);
    const live = await gql(as(admin), CREATE, { m: kb.id, i: { role: 'live', authorTaskRef: tKb2.urn } });
    expect(warned(live, 'createNodeRoleRule')).toEqual([WARN('live', 'authorTask', tKb2.urn, 'OK')]);
  });

  it('org knowledge target: a live automation read grant warns; a revoked one does not', async () => {
    const app = await mkApp('acme.com:ag');
    await autoGrant(app.id, kb.id, new Date());
    const revoked = await gql(as(admin), CREATE, { m: kb.id, i: { role: 'rev', authorTaskRef: tKb2.urn } });
    expect(warned(revoked, 'createNodeRoleRule')).toEqual([]);
    await autoGrant(app.id, kb.id);
    const live = await gql(as(admin), CREATE, { m: kb.id, i: { role: 'live', authorTaskRef: tKb2.urn } });
    expect(warned(live, 'createNodeRoleRule').map((x) => x.code)).toEqual(['TASK_LESS_VISIBLE']);
  });

  it('a personal target that the owner alone reads: a live write grant warns, though the owner reads the task', async () => {
    const control = await gql(as(owner), CREATE, { m: mine.id, i: { role: 'ctl', authorTaskRef: tMine2.urn } });
    expect(warned(control, 'createNodeRoleRule')).toEqual([]);
    const app = await mkApp('acme.com:wp');
    await writeGrant(app.id, mine.id);
    const r = await gql(as(owner), CREATE, { m: mine.id, i: { role: 'live', authorTaskRef: tMine2.urn } });
    expect(warned(r, 'createNodeRoleRule').map((x) => x.code)).toEqual(['TASK_LESS_VISIBLE']);
  });

  it('a grant on ANOTHER memory changes nothing', async () => {
    const app = await mkApp('acme.com:wo');
    await writeGrant(app.id, kb2.id);
    await autoGrant(app.id, kb2.id);
    const r = await gql(as(admin), CREATE, { m: kb.id, i: { role: 'spec', authorTaskRef: tKb2.urn } });
    expect(warned(r, 'createNodeRoleRule')).toEqual([]);
  });
});

describe('#1327 — a fault in the advisory reads never changes the save and never reads as clean', () => {
  afterEach(() => vi.restoreAllMocks());
  const FAULT = new Error('LOCAL diagnostic unavailable');
  const rules = (role?: string) => db.nodeRoleRule.count(role ? { where: { role } } : undefined);

  it('create: the committed rule is answered with a conservative warning from the caller\'s own projection, with one read and one write', async () => {
    const spy = vi.spyOn(db.memorySubscription, 'count').mockRejectedValueOnce(FAULT);
    const r = await gql(as(admin), CREATE, { m: kb.id, i: { role: 'spec', authorTaskRef: tKb2.urn } });
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect(r.data!.createNodeRoleRule.warnings).toEqual([WARN('spec', 'authorTask', tKb2.urn, 'OK')]);
    expect(r.data!.createNodeRoleRule.rule.authorTask).toBe(tKb2.urn);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await rules('spec')).toBe(1);
    expect(JSON.stringify(r)).not.toContain(FAULT.message);
  });

  it('update: same, and the update is applied once', async () => {
    const created = await gql(as(admin), CREATE, { m: kb.id, i: { role: 'spec' } });
    const id = created.data!.createNodeRoleRule.rule.id;
    const spy = vi.spyOn(db.memorySubscription, 'count').mockRejectedValueOnce(FAULT);
    const r = await gql(as(admin), UPDATE, { r: id, i: { validationTaskRef: tKb2.urn } });
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect(r.data!.updateNodeRoleRule.warnings).toEqual([WARN('spec', 'validationTask', tKb2.urn, 'OK')]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await db.nodeRoleRule.findUniqueOrThrow({ where: { id } })).validationTaskId).toBe(tKb2.id);
  });

  it('apply, real and dry run: both answer the same conservative warning, the real one writes once and the dry run writes nothing', async () => {
    const tpl = await gql(as(admin), CREATE_TPL, { t: 'ORGANIZATION', o: org.id, i: { name: 'base', rules: [{ role: 'spec', authorTaskRef: tKb2.urn }] } });
    const t = tpl.data!.createMemoryConfigTemplate.template;
    const dryRun = vi.spyOn(db.memorySubscription, 'count').mockRejectedValueOnce(FAULT);
    const dry = await gql(as(admin), APPLY, { t: t.id, m: kb.id, d: true });
    expect(dry.errors, JSON.stringify(dry.errors)).toBeUndefined();
    expect(dryRun).toHaveBeenCalledTimes(1);
    expect(await rules()).toBe(0);
    const real = vi.spyOn(db.memorySubscription, 'count').mockRejectedValueOnce(FAULT);
    const done = await gql(as(admin), APPLY, { t: t.id, m: kb.id, d: false });
    expect(done.errors, JSON.stringify(done.errors)).toBeUndefined();
    expect(real).toHaveBeenCalledTimes(2);
    const expected = [WARN('spec', 'authorTask', tKb2.urn, 'OK')];
    expect(dry.data!.applyMemoryConfigTemplate.warnings).toEqual(expected);
    expect(done.data!.applyMemoryConfigTemplate.warnings).toEqual(expected);
    expect(await rules('spec')).toBe(1);
  });

  it('a fault in the first reference does not hide the second: each reference is judged on its own', async () => {
    vi.spyOn(db.memorySubscription, 'count').mockRejectedValueOnce(FAULT);
    const r = await gql(as(admin), CREATE, { m: kb.id, i: { role: 'spec', authorTaskRef: tKb2.urn, validationTaskRef: tKb2.urn } });
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    // The coverage is memoised per (target, task memory): the one rejected read serves both references.
    expect(warned(r, 'createNodeRoleRule').map((x) => x.field)).toEqual(['authorTask', 'validationTask']);
  });

  it('the projection itself failing: both nullable fields are null, nothing invented, and the save stands', async () => {
    const real = db.node.findUnique.bind(db.node);
    vi.spyOn(db.node, 'findUnique').mockImplementation(((args: { select?: { loc?: boolean; memory?: unknown } }) =>
      args?.select?.loc && args.select.memory ? Promise.reject(FAULT) : real(args as never)) as never);
    const r = await gql(as(admin), `mutation($m: ID!, $i: CreateNodeRoleRuleInput!) { createNodeRoleRule(memoryRef: $m, input: $i) { rule { id role } ${W} } }`,
      { m: kb.id, i: { role: 'spec', authorTaskRef: tKb2.urn } });
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    expect(r.data!.createNodeRoleRule.warnings).toEqual([WARN('spec', 'authorTask', null, null)]);
    expect(await rules('spec')).toBe(1);
  });

  it('a ONE-SHOT projection fault with the standard selection: the saved rule is returned, no replay through authorTaskState (create, update, real apply)', async () => {
    const real = db.node.findUnique.bind(db.node);
    const oneShot = () => {
      let hit = false;
      vi.spyOn(db.node, 'findUnique').mockImplementation(((args: { select?: { loc?: boolean; memory?: unknown } }) => {
        if (!hit && args?.select?.loc && args.select.memory) { hit = true; return Promise.reject(FAULT); }
        return real(args as never);
      }) as never);
    };
    oneShot();
    const created = await gql(as(admin), CREATE, { m: kb.id, i: { role: 'spec', authorTaskRef: tKb2.urn } });
    expect(created.errors, JSON.stringify(created.errors)).toBeUndefined();
    expect(created.data!.createNodeRoleRule.rule.id).toBeTruthy();
    expect(await rules('spec')).toBe(1);
    vi.restoreAllMocks();
    oneShot();
    const updated = await gql(as(admin), UPDATE, { r: created.data!.createNodeRoleRule.rule.id, i: { enabled: false } });
    expect(updated.errors, JSON.stringify(updated.errors)).toBeUndefined();
    expect(updated.data!.updateNodeRoleRule.rule.id).toBeTruthy();
    vi.restoreAllMocks();
    const tpl = await gql(as(admin), CREATE_TPL, { t: 'ORGANIZATION', o: org.id, i: { name: 'oneshot', rules: [{ role: 'spec2', authorTaskRef: tKb2.urn }] } });
    expect(tpl.errors, JSON.stringify(tpl.errors)).toBeUndefined();
    oneShot();
    const done = await gql(as(admin), APPLY, { t: tpl.data!.createMemoryConfigTemplate.template.id, m: kb.id, d: false });
    expect(done.errors, JSON.stringify(done.errors)).toBeUndefined();
    expect(await rules('spec2')).toBe(1);
  });

  it('bulk apply: each target reports its own warnings, as the singular apply does', async () => {
    const tpl = await gql(as(admin), CREATE_TPL, { t: 'ORGANIZATION', o: org.id, i: { name: 'bulk1327', rules: [{ role: 'specb', authorTaskRef: tKb2.urn }] } });
    expect(tpl.errors, JSON.stringify(tpl.errors)).toBeUndefined();
    const r = await gql(as(admin), `mutation($t: ID!, $m: [ID!]!) { applyMemoryConfigTemplateToMemories(templateRef: $t, memoryRefs: $m) { succeeded failed results { ok result { ${W} } } } }`,
      { t: tpl.data!.createMemoryConfigTemplate.template.id, m: [kb.id] });
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    const out = r.data!.applyMemoryConfigTemplateToMemories;
    expect(out.succeeded).toBe(1);
    expect(out.results[0].result.warnings).toEqual([]); // org knowledge, task in same-org knowledge: contained
  });

  it('bulk apply: a target that does not contain the task warns, naming it, beside one that does', async () => {
    const tpl = await gql(as(admin), CREATE_TPL, { t: 'ORGANIZATION', o: org.id, i: { name: 'bulk1327b', rules: [{ role: 'specb', authorTaskRef: tKb2.urn }] } });
    expect(tpl.errors, JSON.stringify(tpl.errors)).toBeUndefined();
    const r = await gql(as(admin), `mutation($t: ID!, $m: [ID!]!, $d: Boolean) { applyMemoryConfigTemplateToMemories(templateRef: $t, memoryRefs: $m, dryRun: $d) { succeeded results { ok result { ${W} } } } }`,
      { t: tpl.data!.createMemoryConfigTemplate.template.id, m: [kb.id, pub.id], d: false });
    expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
    const res = r.data!.applyMemoryConfigTemplateToMemories.results;
    expect(res[0].result.warnings).toEqual([]);
    expect(res[1].result.warnings).toEqual([{ code: 'TASK_LESS_VISIBLE', role: 'specb', field: 'authorTask', taskUrn: tKb2.urn, taskState: 'OK' }]);
  });

  it('a known NONE reference stays silent even while the advisory reads are failing', async () => {
    vi.spyOn(db.memorySubscription, 'count').mockRejectedValue(FAULT);
    const r = await gql(as(admin), CREATE, { m: kb.id, i: { role: 'plain' } });
    expect(warned(r, 'createNodeRoleRule')).toEqual([]);
  });

  it('control: a deciding refusal is still an error, is not turned into a warning, and persists nothing', async () => {
    vi.spyOn(db.memorySubscription, 'count').mockRejectedValue(FAULT);
    const r = await gql(as(admin), CREATE, { m: kb.id, i: { role: 'spec', authorTaskRef: tForeign.urn } });
    expect(r.errors?.length).toBeGreaterThan(0);
    expect(r.data?.createNodeRoleRule ?? null).toBeNull();
    expect(await rules()).toBe(0);
    const unauthorized = await gql(as(outsider), CREATE, { m: kb.id, i: { role: 'spec' } });
    expect(unauthorized.errors?.[0]?.extensions?.code ?? unauthorized.errors?.[0]?.message).toBeDefined();
    expect(await rules()).toBe(0);
  });
});

describe('#1327 — UNREADABLE, BROKEN and NONE run no audience comparison (read traps)', () => {
  afterEach(() => vi.restoreAllMocks());
  const traps = () => [
    vi.spyOn(db.memorySubscription, 'count'),
    vi.spyOn(db.agentMemoryItem, 'count'),
    vi.spyOn(db.memoryShare, 'findMany'),
    vi.spyOn(db.memoryMember, 'findMany'),
    vi.spyOn(db.appMemoryWriteGrant, 'count'),
    vi.spyOn(db.appAutomationReadGrant, 'count'),
  ];
  const seed = async (data: Record<string, unknown>) => {
    const created = await gql(as(admin), CREATE, { m: kb.id, i: { role: 'spec' } });
    const id = created.data!.createNodeRoleRule.rule.id;
    await db.nodeRoleRule.update({ where: { id }, data });
    return id;
  };

  it('UNREADABLE: warns from the projection and reads no audience', async () => {
    const id = await seed({ authorTaskId: tForeign.id, authorTaskRequired: true });
    const spies = traps();
    const r = await gql(as(admin), UPDATE, { r: id, i: { enabled: false } });
    expect(warned(r, 'updateNodeRoleRule')).toEqual([WARN('spec', 'authorTask', null, 'UNREADABLE')]);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it('BROKEN: warns from the projection and reads no audience', async () => {
    const id = await seed({ authorTaskId: null, authorTaskRequired: true });
    const spies = traps();
    const r = await gql(as(admin), UPDATE, { r: id, i: { enabled: false } });
    expect(warned(r, 'updateNodeRoleRule')).toEqual([WARN('spec', 'authorTask', null, 'BROKEN')]);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it('NONE: no warning and no audience read', async () => {
    const id = await seed({});
    const spies = traps();
    const r = await gql(as(admin), UPDATE, { r: id, i: { enabled: false } });
    expect(warned(r, 'updateNodeRoleRule')).toEqual([]);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it('control: an OK task in another memory does read the audience', async () => {
    const id = await seed({ authorTaskId: tKb2.id, authorTaskRequired: true });
    const spies = traps();
    await gql(as(admin), UPDATE, { r: id, i: { enabled: false } });
    expect(spies.some((s) => s.mock.calls.length > 0)).toBe(true);
  });
});

describe('#1327 — the target App guard and the group bound are each load-bearing', () => {
  it('an App-scoped knowledge target warns although it is org knowledge and the task is same-org knowledge', async () => {
    const app = await db.app.create({ data: { name: 'App', urn: 'acme.com:appk', organizationId: org.id } as never });
    const target = await mkMemory({ organizationId: org.id, appId: app.id, class: 'knowledge', urn: 'acme.com:appk:kb', name: 'appkb', visibility: 'ORGANIZATION' });
    const r = await gql(as(admin), CREATE, { m: target.id, i: { role: 'spec', authorTaskRef: tKb2.urn } });
    expect(warned(r, 'createNodeRoleRule').map((x) => x.code)).toEqual(['TASK_LESS_VISIBLE']);
  });

  it('a group of 50 members who all read the task does not warn; a 51st member does', async () => {
    const grp = await mkMemory({ organizationId: org.id, class: 'group', urn: 'acme.com:grp50', name: 'grp50', visibility: 'GROUP' });
    await db.memoryMember.create({ data: { memoryId: grp.id, userId: admin, role: 'owner' } });
    for (let i = 0; i < 49; i++) {
      const u = await mkUser(400 + i, org.id, 'CONTRIBUTOR');
      await db.memoryMember.create({ data: { memoryId: grp.id, userId: u, role: 'reader' } });
    }
    const ok = await gql(as(admin), CREATE, { m: grp.id, i: { role: 'fifty', authorTaskRef: tKb2.urn } });
    expect(warned(ok, 'createNodeRoleRule')).toEqual([]);
    const extra = await mkUser(499, org.id, 'CONTRIBUTOR');
    await db.memoryMember.create({ data: { memoryId: grp.id, userId: extra, role: 'reader' } });
    const over = await gql(as(admin), CREATE, { m: grp.id, i: { role: 'fiftyone', authorTaskRef: tKb2.urn } });
    expect(warned(over, 'createNodeRoleRule').map((x) => x.code)).toEqual(['TASK_LESS_VISIBLE']);
  });
});

describe('#1327 — one memo and one read budget per call (Rook P2 at 23b6cd69)', () => {
  afterEach(() => { vi.restoreAllMocks(); scopeBudget.override = null; });

  it('bulk apply hands every target the ONE budgeted scope: an exhausted budget warns even where containment holds', async () => {
    const tpl = await gql(as(admin), CREATE_TPL, { t: 'ORGANIZATION', o: org.id, i: { name: 'bulkbudget', rules: [{ role: 'specb', authorTaskRef: tKb2.urn }] } });
    const BULK = `mutation($t: ID!, $m: [ID!]!) { applyMemoryConfigTemplateToMemories(templateRef: $t, memoryRefs: $m, dryRun: true) { results { ok result { ${W} } } } }`;
    const vars = { t: tpl.data!.createMemoryConfigTemplate.template.id, m: [kb.id, group.id] };
    const ample = await gql(as(admin), BULK, vars);
    expect(ample.data!.applyMemoryConfigTemplateToMemories.results.map((x: any) => x.result.warnings)).toEqual([[], []]);
    scopeBudget.override = 0;
    const spent = await gql(as(admin), BULK, vars);
    for (const x of spent.data!.applyMemoryConfigTemplateToMemories.results) expect(x.result.warnings).toHaveLength(1);
  });

  const rule = (taskId: string) => ({ role: 'x', authorTaskId: taskId, authorTaskRequired: false, validationTaskId: null, validationTaskRequired: false, descriptionNodeId: null });
  const run = async (target: string, scope?: WarningScope) =>
    taskVisibilityWarnings({ db, userId: admin, roles: [] } as unknown as Context, target, [rule(tKb2.id)], scope);

  it('control: an ample budget proves containment (no warning)', async () => {
    expect(await run(kb.id, newWarningScope())).toEqual([]);
  });

  it('an exhausted budget warns conservatively, never stays silent', async () => {
    const w = await run(kb.id, newWarningScope(0));
    expect(w).toEqual([{ code: 'TASK_LESS_VISIBLE', role: 'x', field: 'authorTask', taskUrn: tKb2.urn, taskState: 'OK' }]);
  });

  it('a shared scope answers a repeated (target, task memory) pair from the memo: no second lookup', async () => {
    const scope = newWarningScope();
    const spy = vi.spyOn(db.memory, 'findFirst');
    await run(kb.id, scope);
    const first = spy.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    await run(kb.id, scope);
    expect(spy.mock.calls.length).toBe(first);
  });

  it('the budget bounds the per-user point reads too, not only the coverage lookups', async () => {
    // mine: personal, strict owner only. Coverage is one lookup, the owner's read is the second.
    expect(await run(mine.id, newWarningScope(2))).toEqual([]);
    expect(await run(mine.id, newWarningScope(1))).toHaveLength(1);
  });

  it('bulk apply spends ONE budget across its targets, not one per target', async () => {
    const tpl = await gql(as(admin), CREATE_TPL, { t: 'ORGANIZATION', o: org.id, i: { name: 'bulkshared', rules: [{ role: 'specb', authorTaskRef: tKb2.urn }] } });
    const BULK = `mutation($t: ID!, $m: [ID!]!) { applyMemoryConfigTemplateToMemories(templateRef: $t, memoryRefs: $m, dryRun: true) { results { ok result { ${W} } } } }`;
    // kb costs 1 lookup; the group target costs 2 (coverage + its member's read). Alone each fits in 2; together they do not.
    scopeBudget.override = 2;
    const r = await gql(as(admin), BULK, { t: tpl.data!.createMemoryConfigTemplate.template.id, m: [kb.id, group.id] });
    expect(r.data!.applyMemoryConfigTemplateToMemories.results.map((x: any) => x.result.warnings.length)).toEqual([0, 1]);
  });

  it('disjoint-member worst case: targets with no members in common stay inside the one budget and warn once it is spent', async () => {
    const mkGroup = async (n: number) => {
      const g = await mkMemory({ organizationId: org.id, class: 'group', urn: `acme.com:dg${n}`, name: `dg${n}`, visibility: 'GROUP' });
      for (let k = 0; k < 3; k += 1) {
        const u = await mkUser(100 + n * 10 + k, org.id, 'CONTRIBUTOR');
        await db.memoryMember.create({ data: { memoryId: g.id, userId: u, role: 'reader' } });
      }
      return g.id;
    };
    const groups = [await mkGroup(1), await mkGroup(2), await mkGroup(3)];
    const tpl = await gql(as(admin), CREATE_TPL, { t: 'ORGANIZATION', o: org.id, i: { name: 'disjoint', rules: [{ role: 'specb', authorTaskRef: tKb2.urn }] } });
    const BULK = `mutation($t: ID!, $m: [ID!]!, $d: Boolean) { applyMemoryConfigTemplateToMemories(templateRef: $t, memoryRefs: $m, dryRun: $d) { succeeded results { ok result { ${W} } } } }`;
    const vars = { t: tpl.data!.createMemoryConfigTemplate.template.id, m: groups };
    const ample = await gql(as(admin), BULK, { ...vars, d: true });
    expect(ample.errors, JSON.stringify(ample.errors)).toBeUndefined();
    expect(ample.data!.applyMemoryConfigTemplateToMemories.results.map((x: any) => x.result.warnings.length)).toEqual([0, 0, 0]);
    // Each target costs 1 coverage + 3 member reads = 4; a budget of 5 funds the first and only the coverage of the second.
    scopeBudget.override = 5;
    const spent = await gql(as(admin), BULK, { ...vars, d: false });
    const out = spent.data!.applyMemoryConfigTemplateToMemories;
    expect(out.succeeded).toBe(3); // exhaustion never fails a committed target
    expect(out.results.map((x: any) => x.result.warnings.length)).toEqual([0, 1, 1]);
    expect(out.results[1].result.warnings[0]).toEqual({ code: 'TASK_LESS_VISIBLE', role: 'specb', field: 'authorTask', taskUrn: tKb2.urn, taskState: 'OK' });
  });

  it('a private target that carries a share to someone who cannot read the task warns (shares are checked for private too)', async () => {
    const priv = await mkMemory({ organizationId: org.id, class: 'private', userId: owner, urn: 'acme.com:priv', name: 'priv' });
    expect(await run(priv.id, newWarningScope())).toEqual([]); // owner alone reads org knowledge
    await db.memoryShare.create({ data: { memoryId: priv.id, granteeId: outsider, grantorId: owner, role: 'reader' } });
    expect(await run(priv.id, newWarningScope())).toHaveLength(1);
  });

  it('the shared scope spends its budget across calls', async () => {
    const scope = newWarningScope(1);
    expect(await run(kb.id, scope)).toEqual([]); // spent the one lookup
    expect(await run(pub.id, scope)).not.toEqual([]); // a new pair, budget gone: warns
  });
});
