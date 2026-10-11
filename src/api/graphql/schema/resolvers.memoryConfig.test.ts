/**
 * #1325 part (b) — the MemoryConfig / NodeRoleRule API, through the executable
 * schema with the production error formatter, so the codes asserted here are
 * the wire codes the CLI (hadron-cli#716) maps.
 *
 * Numbered after the design's test plan (#1325, as amended by Holger's H1–H6):
 * T1 initialization, T5 references, T6 fail-closed, T7 permissions, T8 reads,
 * T9 uniqueness/format, plus the optimistic-concurrency contract (cli#716 Q1).
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
import { mergeUsers } from '../../../test/mergeConsent.js';

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

const RULE_FIELDS = `id role authorTask authorTaskId authorTaskState validationTask validationTaskId validationTaskState descriptionNode descriptionNodeId descriptionNodeState
  strictSubRoles writers validateBy enabled locked sourceTemplateId sourceTemplate { id name deleted } revision createdBy updatedBy`;
const CONFIG = `query($m: ID!) { memoryConfig(memoryRef: $m) { id memoryId rules { ${RULE_FIELDS} } } }`;
const CREATE = `mutation($m: ID!, $i: CreateNodeRoleRuleInput!) { createNodeRoleRule(memoryRef: $m, input: $i) { rule { ${RULE_FIELDS} } warnings { code } } }`;
const UPDATE = `mutation($r: ID!, $i: UpdateNodeRoleRuleInput!, $v: Int) { updateNodeRoleRule(ref: $r, input: $i, expectedRevision: $v) { rule { ${RULE_FIELDS} } } }`;
const DELETE = `mutation($r: ID!, $v: Int) { deleteNodeRoleRule(ref: $r, expectedRevision: $v) }`;

let org: { id: string; urn: string };
let otherOrg: { id: string };
let orgOwner: string, orgAdmin: string, contributor: string, reader: string, outsider: string, personalOwner: string, platformAdmin: string;
let kb: { id: string; urn: string };
let personal: { id: string; urn: string };
let userOwned: { id: string; urn: string };
let task: { id: string; urn: string };
let plainNode: { id: string; urn: string };
let foreignTask: { id: string; urn: string };

const as = (userId: string, extra: Partial<Context> = {}): Partial<Context> => ({ userId, ...extra });

async function mkUser(n: number, orgId?: string, role?: 'OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER', roles: Role[] = []) {
  const u = await db.user.create({ data: { githubId: 70000 + n, githubUsername: `u${n}`, roles } });
  if (orgId && role) await db.orgMember.create({ data: { organizationId: orgId, userId: u.id, role } });
  return u.id;
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'acme', urn: 'acme.com' }, select: { id: true, urn: true } });
  otherOrg = await db.organization.create({ data: { id: generateId(), name: 'other', urn: 'other.com' }, select: { id: true } });
  orgOwner = await mkUser(1, org.id, 'OWNER');
  orgAdmin = await mkUser(2, org.id, 'ADMIN');
  contributor = await mkUser(3, org.id, 'CONTRIBUTOR');
  reader = await mkUser(4, org.id, 'READER');
  outsider = await mkUser(5, otherOrg.id, 'OWNER');
  personalOwner = await mkUser(6, org.id, 'CONTRIBUTOR');
  platformAdmin = await mkUser(7, undefined, undefined, ['ADMIN']);

  kb = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: 'acme.com:kb', name: 'kb', class: 'knowledge', visibility: 'ORGANIZATION' },
    select: { id: true, urn: true },
  });
  personal = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: 'acme.com:mine', name: 'mine', class: 'personal', userId: personalOwner },
    select: { id: true, urn: true },
  });
  userOwned = await db.memory.create({
    data: { id: generateId(), ownerUserId: personalOwner, urn: '@u6:notes', name: 'notes', class: 'knowledge' },
    select: { id: true, urn: true },
  });
  const t = await db.node.create({ data: { id: generateId(), memoryId: kb.id, loc: 'tasks:author', name: 'Author', isRunnable: true } });
  task = { id: t.id, urn: 'hrn:node:acme.com:kb:tasks:author' };
  const p = await db.node.create({ data: { id: generateId(), memoryId: kb.id, loc: 'guide', name: 'Guide' } });
  plainNode = { id: p.id, urn: 'hrn:node:acme.com:kb:guide' };
  const foreignMem = await db.memory.create({
    data: { id: generateId(), organizationId: otherOrg.id, urn: 'other.com:secret', name: 'secret', class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  const ft = await db.node.create({ data: { id: generateId(), memoryId: foreignMem.id, loc: 'tasks:x', name: 'X', isRunnable: true } });
  foreignTask = { id: ft.id, urn: 'hrn:node:other.com:secret:tasks:x' };
});

describe('T1 — initialization: a config exists for every memory without a row', () => {
  it('an existing memory reads the empty config: null id, no rules, no row written', async () => {
    const r = await gql(as(orgAdmin), CONFIG, { m: kb.id });
    expect(r.errors).toBeUndefined();
    expect(r.data!.memoryConfig).toEqual({ id: null, memoryId: kb.id, rules: [] });
    expect(await db.memoryConfig.count()).toBe(0);
  });

  it('the first rule write materializes exactly one row; two first writes still make one', async () => {
    const [a, b] = await Promise.all([
      gql(as(orgAdmin), CREATE, { m: kb.id, i: { role: 'spec' } }),
      gql(as(orgOwner), CREATE, { m: kb.id, i: { role: 'review' } }),
    ]);
    expect(a.errors).toBeUndefined();
    expect(b.errors).toBeUndefined();
    expect(await db.memoryConfig.count({ where: { memoryId: kb.id } })).toBe(1);
    const cfg = await gql(as(orgAdmin), CONFIG, { m: kb.id });
    expect(cfg.data!.memoryConfig.id).not.toBeNull();
    expect(cfg.data!.memoryConfig.rules.map((x: { role: string }) => x.role)).toEqual(['review', 'spec']);
  });
});

describe('T7 — the MANAGE gate, and a non-manager is answered like a missing memory', () => {
  const missing = async (userId: string, extra: Partial<Context> = {}, memoryRef = kb.id) => {
    const got = await gql(as(userId, extra), CONFIG, { m: memoryRef });
    const none = await gql(as(userId, extra), CONFIG, { m: generateId() });
    return { got: code(got), none: code(none) };
  };

  it('org OWNER and ADMIN manage an org memory', async () => {
    for (const u of [orgOwner, orgAdmin]) expect((await gql(as(u), CONFIG, { m: kb.id })).errors).toBeUndefined();
  });

  it('CONTRIBUTOR, READER and an outsider get MEMORY_NOT_FOUND — the same code as a nonexistent memory', async () => {
    for (const u of [contributor, reader, outsider]) {
      expect(await missing(u)).toEqual({ got: 'MEMORY_NOT_FOUND', none: 'MEMORY_NOT_FOUND' });
    }
  });

  it('H3: only the strict owner manages a personal memory — the org OWNER, an ADMIN and a platform admin do not', async () => {
    expect((await gql(as(personalOwner), CONFIG, { m: personal.id })).errors).toBeUndefined();
    for (const u of [orgOwner, orgAdmin]) {
      expect(code(await gql(as(u), CONFIG, { m: personal.id }))).toBe('MEMORY_NOT_FOUND');
    }
    expect(code(await gql(as(platformAdmin, { roles: ['ADMIN'] }), CONFIG, { m: personal.id }))).toBe('MEMORY_NOT_FOUND');
  });

  it('a user-owned memory is managed by its owner only, not a platform admin', async () => {
    expect((await gql(as(personalOwner), CONFIG, { m: userOwned.id })).errors).toBeUndefined();
    expect(code(await gql(as(platformAdmin, { roles: ['ADMIN'] }), CONFIG, { m: userOwned.id }))).toBe('MEMORY_NOT_FOUND');
  });

  it('impersonation never manages a personal memory, and never writes', async () => {
    const imp = { impersonation: { adminUserId: platformAdmin } } as unknown as Partial<Context>;
    expect(code(await gql(as(personalOwner, imp), CONFIG, { m: personal.id }))).toBe('MEMORY_NOT_FOUND');
    const w = await gql(as(orgAdmin, imp), CREATE, { m: kb.id, i: { role: 'spec' } });
    expect(w.errors).toBeDefined();
    expect(await db.nodeRoleRule.count()).toBe(0);
  });

  it('a non-manager cannot write either, and the refusal reads like a missing memory', async () => {
    const w = await gql(as(contributor), CREATE, { m: kb.id, i: { role: 'spec' } });
    expect(code(w)).toBe('MEMORY_NOT_FOUND');
    expect(await db.memoryConfig.count()).toBe(0);
  });

  it('a rule a caller cannot manage reads as NOT_FOUND on update and delete, like one that does not exist', async () => {
    const rule = (await gql(as(orgAdmin), CREATE, { m: kb.id, i: { role: 'spec' } })).data!.createNodeRoleRule.rule;
    for (const [q, v] of [[UPDATE, { r: rule.id, i: { enabled: false } }], [DELETE, { r: rule.id }]] as const) {
      expect(code(await gql(as(contributor), q, v))).toBe('NOT_FOUND');
      expect(code(await gql(as(orgAdmin), q, { ...v, r: generateId() }))).toBe('NOT_FOUND');
    }
    expect((await db.nodeRoleRule.findUniqueOrThrow({ where: { id: rule.id } })).enabled).toBe(true);
  });
});

describe('T8 — Memory.config is null for anyone who does not manage the memory', () => {
  const Q = `query($id: ID!) { memory(ref: $id) { id config { id rules { role } } } }`;
  it('a READER who can read the memory sees config: null; an ADMIN sees it', async () => {
    await gql(as(orgAdmin), CREATE, { m: kb.id, i: { role: 'spec' } });
    const rd = await gql(as(reader), Q, { id: kb.id });
    expect(rd.errors).toBeUndefined();
    expect(rd.data!.memory.id).toBe(kb.id);
    expect(rd.data!.memory.config).toBeNull();
    const ad = await gql(as(orgAdmin), Q, { id: kb.id });
    expect(ad.data!.memory.config.rules).toEqual([{ role: 'spec' }]);
  });
});

describe('T5 — references: accepted as a URN, stored as an id, returned as a URN', () => {
  it('a task URN goes in, the id is stored, the URN comes out with state OK', async () => {
    const r = await gql(as(orgAdmin), CREATE, {
      m: kb.id,
      i: { role: 'spec', authorTaskRef: task.urn, validationTaskRef: task.id, descriptionNodeRef: plainNode.urn, validateBy: 'AGENT' },
    });
    expect(r.errors).toBeUndefined();
    const rule = r.data!.createNodeRoleRule.rule;
    expect(rule).toMatchObject({
      authorTask: task.urn, authorTaskState: 'OK',
      validationTask: task.urn, validationTaskState: 'OK',
      descriptionNode: plainNode.urn, descriptionNodeState: 'OK',
      validateBy: 'AGENT', revision: 1, createdBy: orgAdmin, locked: false, sourceTemplate: null,
    });
    const row = await db.nodeRoleRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect([row.authorTaskId, row.authorTaskRequired, row.validationTaskRequired]).toEqual([task.id, true, true]);
  });

  it('a non-runnable node as a task is NOT_A_TASK; as a description node it is fine', async () => {
    expect(code(await gql(as(orgAdmin), CREATE, { m: kb.id, i: { role: 'spec', authorTaskRef: plainNode.urn } }))).toBe('NOT_A_TASK');
    expect((await gql(as(orgAdmin), CREATE, { m: kb.id, i: { role: 'spec', descriptionNodeRef: plainNode.id } })).errors).toBeUndefined();
  });

  it('an unreadable task and a missing one get the IDENTICAL NODE_NOT_FOUND, and nothing is written', async () => {
    const unreadable = await gql(as(orgAdmin), CREATE, { m: kb.id, i: { role: 'spec', authorTaskRef: foreignTask.id } });
    const missing = await gql(as(orgAdmin), CREATE, { m: kb.id, i: { role: 'spec', authorTaskRef: generateId() } });
    expect(code(unreadable)).toBe('NODE_NOT_FOUND');
    expect(code(missing)).toBe('NODE_NOT_FOUND');
    // Readability is judged before runnability: an unreadable NON-task says NODE_NOT_FOUND,
    // never NOT_A_TASK — which would confirm that the node exists.
    const foreignPlain = await db.node.create({ data: { id: generateId(), memoryId: (await db.node.findUniqueOrThrow({ where: { id: foreignTask.id } })).memoryId, loc: 'plain', name: 'P' } });
    expect(code(await gql(as(orgAdmin), CREATE, { m: kb.id, i: { role: 'spec', authorTaskRef: foreignPlain.id } }))).toBe('NODE_NOT_FOUND');
    expect(await db.nodeRoleRule.count()).toBe(0);
  });

  it('the reference survives a move of the task node (the id is stable)', async () => {
    const rule = (await gql(as(orgAdmin), CREATE, { m: kb.id, i: { role: 'spec', authorTaskRef: task.urn } })).data!.createNodeRoleRule.rule;
    await db.node.update({ where: { id: task.id }, data: { loc: 'tasks:renamed' } });
    const cfg = await gql(as(orgAdmin), CONFIG, { m: kb.id });
    expect(cfg.data!.memoryConfig.rules[0]).toMatchObject({ id: rule.id, authorTask: 'hrn:node:acme.com:kb:tasks:renamed', authorTaskState: 'OK' });
  });

  it('validateBy needs a configured validation task', async () => {
    const r = await gql(as(orgAdmin), CREATE, { m: kb.id, i: { role: 'spec', validateBy: 'PLATFORM' } });
    expect(code(r)).toBe('BAD_USER_INPUT');
    expect(r.errors![0].extensions).toMatchObject({ field: 'validateBy', reason: 'VALIDATION_TASK_REQUIRED' });
  });
});

describe('T6 — fail closed (H5): a deleted task is BROKEN, never silently unrequired', () => {
  it('hard delete: the FK nulls, the marker holds, the rule reads BROKEN with no URN', async () => {
    const rule = (await gql(as(orgAdmin), CREATE, { m: kb.id, i: { role: 'spec', authorTaskRef: task.urn, descriptionNodeRef: plainNode.urn } }))
      .data!.createNodeRoleRule.rule;
    await db.node.delete({ where: { id: task.id } });
    await db.node.delete({ where: { id: plainNode.id } });
    const row = await db.nodeRoleRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect([row.authorTaskId, row.authorTaskRequired]).toEqual([null, true]);
    const got = (await gql(as(orgAdmin), CONFIG, { m: kb.id })).data!.memoryConfig.rules[0];
    expect(got).toMatchObject({ authorTask: null, authorTaskState: 'BROKEN', descriptionNode: null, descriptionNodeState: 'NONE' });
  });

  it('soft delete: the FK stays, and the rule still reads BROKEN', async () => {
    await gql(as(orgAdmin), CREATE, { m: kb.id, i: { role: 'spec', authorTaskRef: task.urn } });
    await db.node.update({ where: { id: task.id }, data: { deletedAt: new Date() } });
    const got = (await gql(as(orgAdmin), CONFIG, { m: kb.id })).data!.memoryConfig.rules[0];
    expect(got).toMatchObject({ authorTask: null, authorTaskState: 'BROKEN' });
  });

  it('BROKEN is not UNREADABLE: a task that exists but the manager cannot read withholds its URN as UNREADABLE', async () => {
    const rule = (await gql(as(orgAdmin), CREATE, { m: kb.id, i: { role: 'spec' } })).data!.createNodeRoleRule.rule;
    await db.nodeRoleRule.update({ where: { id: rule.id }, data: { authorTaskId: foreignTask.id, authorTaskRequired: true } });
    const got = (await gql(as(orgAdmin), CONFIG, { m: kb.id })).data!.memoryConfig.rules[0];
    expect(got).toMatchObject({ authorTask: null, authorTaskState: 'UNREADABLE' });
  });

  it('a BROKEN validation task does not block an unrelated edit of the rule', async () => {
    const rule = (await gql(as(orgAdmin), CREATE, { m: kb.id, i: { role: 'spec', validationTaskRef: task.urn, validateBy: 'AGENT' } }))
      .data!.createNodeRoleRule.rule;
    await db.node.delete({ where: { id: task.id } });
    const r = await gql(as(orgAdmin), UPDATE, { r: rule.id, i: { enabled: false } });
    expect(r.errors).toBeUndefined();
    expect(r.data!.updateNodeRoleRule.rule).toMatchObject({ enabled: false, validationTaskState: 'BROKEN' });
  });
});

describe('updates, clears and optimistic concurrency (cli#716 Q1)', () => {
  const mk = async (i: Record<string, unknown>) => (await gql(as(orgAdmin), CREATE, { m: kb.id, i: { role: 'spec', ...i } })).data!.createNodeRoleRule.rule;

  it('an omitted field is unchanged; a given one changes; revision and updatedBy move', async () => {
    const rule = await mk({ authorTaskRef: task.urn, writers: 'ADMIN' });
    const r = await gql(as(orgOwner), UPDATE, { r: rule.id, i: { strictSubRoles: true } });
    expect(r.data!.updateNodeRoleRule.rule).toMatchObject({ strictSubRoles: true, writers: 'ADMIN', authorTask: task.urn, revision: 2, updatedBy: orgOwner });
  });

  it('a null or "" reference is an explicit clear, and drops the fail-closed marker with it', async () => {
    const rule = await mk({ authorTaskRef: task.urn, descriptionNodeRef: plainNode.urn });
    const r = await gql(as(orgAdmin), UPDATE, { r: rule.id, i: { authorTaskRef: '', descriptionNodeRef: null } });
    expect(r.data!.updateNodeRoleRule.rule).toMatchObject({ authorTaskState: 'NONE', descriptionNodeState: 'NONE' });
    const row = await db.nodeRoleRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect([row.authorTaskId, row.authorTaskRequired, row.descriptionNodeId]).toEqual([null, false, null]);
  });

  it('a stale expectedRevision is CONFLICT with currentRevision, and writes nothing', async () => {
    const rule = await mk({});
    await gql(as(orgAdmin), UPDATE, { r: rule.id, i: { enabled: false }, v: 1 });
    const stale = await gql(as(orgOwner), UPDATE, { r: rule.id, i: { writers: 'OWNER' }, v: 1 });
    expect(code(stale)).toBe('CONFLICT');
    expect(stale.errors![0].extensions).toMatchObject({ currentRevision: 2 });
    const row = await db.nodeRoleRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect([row.writers, row.revision]).toEqual(['ALL', 2]);
    expect(code(await gql(as(orgOwner), DELETE, { r: rule.id, v: 1 }))).toBe('CONFLICT');
    expect(await db.nodeRoleRule.count()).toBe(1);
  });

  it('delete with the current revision removes the rule; the config row stays', async () => {
    const rule = await mk({});
    const r = await gql(as(orgAdmin), DELETE, { r: rule.id, v: 1 });
    expect(r.data!.deleteNodeRoleRule).toBe(true);
    expect(await db.nodeRoleRule.count()).toBe(0);
    expect((await gql(as(orgAdmin), CONFIG, { m: kb.id })).data!.memoryConfig.rules).toEqual([]);
  });

  it('clearing validateBy while its task is gone is allowed; setting it without one is not', async () => {
    const rule = await mk({});
    expect(code(await gql(as(orgAdmin), UPDATE, { r: rule.id, i: { validateBy: 'AGENT' } }))).toBe('BAD_USER_INPUT');
    expect((await gql(as(orgAdmin), UPDATE, { r: rule.id, i: { validateBy: 'AGENT', validationTaskRef: task.urn } })).errors).toBeUndefined();
    expect((await gql(as(orgAdmin), UPDATE, { r: rule.id, i: { validateBy: null, validationTaskRef: null } })).errors).toBeUndefined();
  });
});

describe('T9 — uniqueness and format', () => {
  it('a second rule for the same role is NODE_ROLE_RULE_EXISTS', async () => {
    await gql(as(orgAdmin), CREATE, { m: kb.id, i: { role: 'spec.rule' } });
    const dup = await gql(as(orgAdmin), CREATE, { m: kb.id, i: { role: 'spec.rule' } });
    expect(code(dup)).toBe('NODE_ROLE_RULE_EXISTS');
    expect(dup.errors![0].extensions).toMatchObject({ role: 'spec.rule' });
  });

  it.each([
    ['', 'EMPTY'],
    ['Spec', 'BAD_SEGMENT'],
    ['spec..rule', 'BAD_SEGMENT'],
    ['spec_rule', 'BAD_SEGMENT'],
    ['.spec', 'BAD_SEGMENT'],
    ['x'.repeat(65), 'TOO_LONG'],
  ])('role %j is INVALID_NODE_ROLE with reason %s (#1322 grammar, cli#716 Q9), nothing written', async (role, reason) => {
    const r = await gql(as(orgAdmin), CREATE, { m: kb.id, i: { role } });
    expect(code(r)).toBe('INVALID_NODE_ROLE');
    expect(r.errors![0].extensions).toMatchObject({ role, reason });
    expect(await db.memoryConfig.count()).toBe(0);
  });

  it('H2: every setting is storable now — nothing is refused as not yet enforced', async () => {
    const r = await gql(as(orgAdmin), CREATE, {
      m: kb.id,
      i: { role: 'spec', strictSubRoles: true, writers: 'OWNER', enabled: false, authorTaskRef: task.urn, validationTaskRef: task.urn, validateBy: 'PLATFORM' },
    });
    expect(r.errors).toBeUndefined();
    expect(r.data!.createNodeRoleRule).toMatchObject({ warnings: [], rule: { strictSubRoles: true, writers: 'OWNER', enabled: false, validateBy: 'PLATFORM' } });
  });

  it('a memory hard delete cascades its config and rules', async () => {
    await gql(as(orgAdmin), CREATE, { m: kb.id, i: { role: 'spec' } });
    await db.node.deleteMany({ where: { memoryId: kb.id } });
    await db.memory.delete({ where: { id: kb.id } });
    expect([await db.memoryConfig.count(), await db.nodeRoleRule.count()]).toEqual([0, 0]);
  });
});

/** Resolve once `ms` has passed — long enough for a launched mutation to reach a lock wait. */
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('#1360 review — gates, concurrency, audit, and unaddressable references', () => {
  const mk = async (i: Record<string, unknown>) => (await gql(as(orgAdmin), CREATE, { m: kb.id, i: { role: 'spec', ...i } })).data!.createNodeRoleRule.rule;
  const imp = (orgId: string) =>
    ({ impersonation: { sessionId: 'imp', actorUserId: platformAdmin, orgId, expiresAt: new Date(Date.now() + 60_000) } }) as Partial<Context>;

  it('impersonation reads an org memory config as its target would, only in the shared org, and never writes', async () => {
    await mk({});
    const read = await gql(as(orgAdmin, imp(org.id)), CONFIG, { m: kb.id });
    expect(read.errors).toBeUndefined();
    expect(read.data!.memoryConfig.rules).toHaveLength(1);
    expect(code(await gql(as(orgAdmin, imp(otherOrg.id)), CONFIG, { m: kb.id }))).toBe('MEMORY_NOT_FOUND');
    expect((await gql(as(orgAdmin, imp(org.id)), CREATE, { m: kb.id, i: { role: 'review' } })).errors).toBeDefined();
    expect(await db.nodeRoleRule.count()).toBe(1);
  });

  it('an operational failure in the manage gate propagates instead of reading as a missing memory', async () => {
    const spy = vi.spyOn(db.orgMember, 'findFirst').mockRejectedValue(new Error('connection timeout'));
    try {
      const r = await gql(as(orgAdmin), CONFIG, { m: kb.id });
      expect(r.errors).toBeDefined();
      expect(code(r)).not.toBe('MEMORY_NOT_FOUND');
      const viaMemory = await gql(as(orgAdmin), `query($id: ID!) { memory(ref: $id) { config { id } } }`, { id: kb.id });
      expect(viaMemory.errors).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('OK gives the id; a node whose legacy memory URN cannot address it is OK with a null URN and its id', async () => {
    const legacy = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: 'acme.com:team:team:shared', name: 'shared', class: 'knowledge', visibility: 'ORGANIZATION' },
    });
    const lt = await db.node.create({ data: { id: generateId(), memoryId: legacy.id, loc: 'tasks:t', name: 'T', isRunnable: true } });
    const rule = await mk({ authorTaskRef: lt.id, validationTaskRef: task.urn });
    expect(rule).toMatchObject({
      authorTask: null, authorTaskId: lt.id, authorTaskState: 'OK',
      validationTask: task.urn, validationTaskId: task.id, validationTaskState: 'OK',
      descriptionNodeId: null, descriptionNodeState: 'NONE',
    });
    // The id it hands out is a working ref: it round-trips into another rule.
    expect((await gql(as(orgAdmin), CREATE, { m: kb.id, i: { role: 'review', authorTaskRef: rule.authorTaskId } })).errors).toBeUndefined();
  });

  it('UNREADABLE and BROKEN withhold the id as well as the URN', async () => {
    const rule = await mk({ authorTaskRef: task.urn });
    await db.nodeRoleRule.update({ where: { id: rule.id }, data: { validationTaskId: foreignTask.id, validationTaskRequired: true } });
    await db.node.update({ where: { id: task.id }, data: { deletedAt: new Date() } });
    const got = (await gql(as(orgAdmin), CONFIG, { m: kb.id })).data!.memoryConfig.rules[0];
    expect(got).toMatchObject({
      authorTask: null, authorTaskId: null, authorTaskState: 'BROKEN',
      validationTask: null, validationTaskId: null, validationTaskState: 'UNREADABLE',
    });
  });

  it('validateBy is judged on the row as it is when written: a clear that commits first is not overwritten into a taskless validateBy', async () => {
    const rule = await mk({ validationTaskRef: task.urn });
    let setting: Promise<Gql> | undefined;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "node_role_rules" WHERE "id" = ${rule.id} FOR UPDATE`;
      setting = gql(as(orgOwner), UPDATE, { r: rule.id, i: { validateBy: 'AGENT' } });
      await pause(400);
      await tx.nodeRoleRule.update({
        where: { id: rule.id },
        data: { validationTaskId: null, validationTaskRequired: false, validateBy: null, revision: { increment: 1 } },
      });
    });
    const r = await setting!;
    expect(r.errors?.[0]?.extensions).toMatchObject({ reason: 'VALIDATION_TASK_REQUIRED' });
    const row = await db.nodeRoleRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect([row.validateBy, row.validationTaskId, row.validationTaskRequired]).toEqual([null, null, false]);
  });

  it('a task made non-runnable while the rule write is in flight is refused NOT_A_TASK', async () => {
    let creating: Promise<Gql> | undefined;
    await db.$transaction(async (tx) => {
      await tx.node.update({ where: { id: task.id }, data: { isRunnable: false } });
      creating = gql(as(orgAdmin), CREATE, { m: kb.id, i: { role: 'spec', authorTaskRef: task.urn } });
      await pause(400);
    });
    expect(code(await creating!)).toBe('NOT_A_TASK');
    expect(await db.nodeRoleRule.count()).toBe(0);
  });

  it('a task moved out of the saver\'s reach while the rule write is in flight is refused NODE_NOT_FOUND', async () => {
    const foreignMemoryId = (await db.node.findUniqueOrThrow({ where: { id: foreignTask.id } })).memoryId;
    let creating: Promise<Gql> | undefined;
    await db.$transaction(async (tx) => {
      await tx.node.update({ where: { id: task.id }, data: { memoryId: foreignMemoryId, loc: 'tasks:moved' } });
      creating = gql(as(orgAdmin), CREATE, { m: kb.id, i: { role: 'spec', authorTaskRef: task.id } });
      await pause(400);
    });
    expect(code(await creating!)).toBe('NODE_NOT_FOUND');
    expect(await db.nodeRoleRule.count()).toBe(0);
  });

  it('access to an UNMOVED task revoked while the write is in flight is re-checked, not read from the request cache', async () => {
    const other = await db.organization.create({ data: { id: generateId(), name: 'third', urn: 'third.com' } });
    const shared = await db.memory.create({
      data: { id: generateId(), organizationId: other.id, urn: 'third.com:shared', name: 'shared', class: 'knowledge', visibility: 'ORGANIZATION' },
    });
    const t = await db.node.create({ data: { id: generateId(), memoryId: shared.id, loc: 'tasks:t', name: 'T', isRunnable: true } });
    await db.orgMember.create({ data: { organizationId: other.id, userId: orgAdmin, role: 'READER' } });
    let creating: Promise<Gql> | undefined;
    await db.$transaction(async (tx) => {
      await tx.node.update({ where: { id: t.id }, data: { name: 'T2' } });
      await tx.orgMember.updateMany({ where: { organizationId: other.id, userId: orgAdmin }, data: { deletedAt: new Date() } });
      creating = gql(as(orgAdmin), CREATE, { m: kb.id, i: { role: 'spec', authorTaskRef: t.id } });
      await pause(400);
    });
    expect(code(await creating!)).toBe('NODE_NOT_FOUND');
    expect(await db.nodeRoleRule.count()).toBe(0);
  });

  // Codex P1 on a4ee5c0: the MANAGE gate is re-asked inside the transaction
  // after its lock waits. Demoting ADMIN → READER keeps kb (and its task)
  // readable, so each refusal below is the manage re-check and nothing else.
  const demoteAdmin = (tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]) =>
    tx.orgMember.updateMany({ where: { organizationId: org.id, userId: orgAdmin }, data: { role: 'READER' } });

  it('a manager demoted while a CREATE waits on its task lock is refused MEMORY_NOT_FOUND, and nothing is written', async () => {
    let creating: Promise<Gql> | undefined;
    await db.$transaction(async (tx) => {
      await tx.node.update({ where: { id: task.id }, data: { name: 'Author 2' } });
      await demoteAdmin(tx);
      creating = gql(as(orgAdmin), CREATE, { m: kb.id, i: { role: 'spec', authorTaskRef: task.urn } });
      await pause(400);
    });
    expect(code(await creating!)).toBe('MEMORY_NOT_FOUND');
    expect(await db.nodeRoleRule.count()).toBe(0);
    expect(await db.memoryConfig.count()).toBe(0);
  });

  it('a manager demoted while an UPDATE waits on the rule lock is refused NOT_FOUND, and the rule is unchanged', async () => {
    const rule = await mk({});
    let updating: Promise<Gql> | undefined;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "node_role_rules" WHERE "id" = ${rule.id} FOR UPDATE`;
      await demoteAdmin(tx);
      updating = gql(as(orgAdmin), UPDATE, { r: rule.id, i: { enabled: false } });
      await pause(400);
    });
    expect(code(await updating!)).toBe('NOT_FOUND');
    const row = await db.nodeRoleRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect([row.enabled, row.revision]).toEqual([true, rule.revision]);
  });

  it('a manager demoted while a DELETE waits on the rule lock is refused NOT_FOUND, and the rule survives', async () => {
    const rule = await mk({});
    let deleting: Promise<Gql> | undefined;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "node_role_rules" WHERE "id" = ${rule.id} FOR UPDATE`;
      await demoteAdmin(tx);
      deleting = gql(as(orgAdmin), DELETE, { r: rule.id });
      await pause(400);
    });
    expect(code(await deleting!)).toBe('NOT_FOUND');
    expect(await db.nodeRoleRule.count({ where: { id: rule.id } })).toBe(1);
  });

  it('a memory soft-deleted while a DELETE waits on the rule lock refuses the delete', async () => {
    const rule = await mk({});
    let deleting: Promise<Gql> | undefined;
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "node_role_rules" WHERE "id" = ${rule.id} FOR UPDATE`;
      await tx.memory.update({ where: { id: kb.id }, data: { deletedAt: new Date() } });
      deleting = gql(as(orgAdmin), DELETE, { r: rule.id });
      await pause(400);
    });
    expect(code(await deleting!)).toBe('NOT_FOUND');
    expect(await db.nodeRoleRule.count({ where: { id: rule.id } })).toBe(1);
  });

  it('a task moved to another memory the saver CAN read while the write is in flight is still accepted', async () => {
    const kb2 = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: 'acme.com:kb2', name: 'kb2', class: 'knowledge', visibility: 'ORGANIZATION' },
    });
    let creating: Promise<Gql> | undefined;
    await db.$transaction(async (tx) => {
      await tx.node.update({ where: { id: task.id }, data: { memoryId: kb2.id } });
      creating = gql(as(orgAdmin), CREATE, { m: kb.id, i: { role: 'spec', authorTaskRef: task.id } });
      await pause(400);
    });
    const r = await creating!;
    expect(r.errors).toBeUndefined();
    expect(r.data!.createNodeRoleRule.rule).toMatchObject({ authorTask: 'hrn:node:acme.com:kb2:tasks:author', authorTaskState: 'OK' });
  });

  it('each concurrent update returns its OWN write', async () => {
    const rule = await mk({});
    const writers = ['ALL', 'OWNER', 'ADMIN', 'ALL', 'OWNER', 'ADMIN', 'ALL', 'OWNER'];
    const results = await Promise.all(writers.map((w) => gql(as(orgAdmin), UPDATE, { r: rule.id, i: { writers: w } })));
    const got = results.map((r) => r.data!.updateNodeRoleRule.rule);
    expect(got.map((g) => g.writers)).toEqual(writers);
    expect(new Set(got.map((g) => g.revision)).size).toBe(writers.length);
  });

  it('every rule change stamps the config audit fields', async () => {
    const Q = `query($m: ID!) { memoryConfig(memoryRef: $m) { updatedBy updatedAt } }`;
    const cfg = async () => (await gql(as(orgAdmin), Q, { m: kb.id })).data!.memoryConfig;
    const rule = await mk({});
    const c1 = await cfg();
    expect(c1.updatedBy).toBe(orgAdmin);
    expect(c1.updatedAt).not.toBeNull();
    await gql(as(orgOwner), UPDATE, { r: rule.id, i: { enabled: false } });
    const c2 = await cfg();
    expect(c2.updatedBy).toBe(orgOwner);
    expect(new Date(c2.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(c1.updatedAt).getTime());
    await gql(as(orgAdmin), DELETE, { r: rule.id });
    expect((await cfg()).updatedBy).toBe(orgAdmin);
  });

  it('a user merge reassigns the config and rule audit stamps to the surviving account', async () => {
    const survivor = await mkUser(8, org.id, 'ADMIN');
    const rule = await mk({});
    await mergeUsers(db, { sourceUserId: orgAdmin, targetUserId: survivor });
    const row = await db.nodeRoleRule.findUniqueOrThrow({ where: { id: rule.id } });
    const config = await db.memoryConfig.findUniqueOrThrow({ where: { memoryId: kb.id } });
    expect([row.createdBy, row.updatedBy, config.createdBy, config.updatedBy]).toEqual([survivor, survivor, survivor, survivor]);
  });
});
