/**
 * #1334 slice 1 — applyMemoryConfigTemplate and RULE_LOCKED, through the
 * executable schema with the production error formatter.
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
const code = (r: Gql) => r.errors?.[0]?.extensions?.code;

const RULE = 'id role authorTask authorTaskState strictSubRoles writers enabled locked sourceTemplateId revision';
const APPLY = `mutation($t: ID!, $m: ID!, $v: Int, $d: Boolean) {
  applyMemoryConfigTemplate(templateRef: $t, memoryRef: $m, expectedTemplateRevision: $v, dryRun: $d) {
    memoryId templateRevision required dryRun template { id name deleted } warnings { code }
    entries { role outcome rule { ${RULE} } }
  } }`;
const CREATE_TPL = `mutation($t: MemoryConfigTemplateOwnerType!, $o: ID, $i: CreateMemoryConfigTemplateInput!) {
  createMemoryConfigTemplate(ownerType: $t, ownerRef: $o, input: $i) { template { id revision } } }`;
const UPDATE_TPL = `mutation($r: ID!, $i: UpdateMemoryConfigTemplateInput!) { updateMemoryConfigTemplate(ref: $r, input: $i) { template { revision } } }`;
const CREATE_RULE = `mutation($m: ID!, $i: CreateNodeRoleRuleInput!) { createNodeRoleRule(memoryRef: $m, input: $i) { rule { ${RULE} } } }`;
const UPDATE_RULE = `mutation($r: ID!, $i: UpdateNodeRoleRuleInput!) { updateNodeRoleRule(ref: $r, input: $i) { rule { ${RULE} } } }`;
const DELETE_RULE = `mutation($r: ID!) { deleteNodeRoleRule(ref: $r) }`;

let org: { id: string };
let orgAdmin: string, contributor: string, personalOwner: string;
let mem: { id: string; urn: string };
let personal: { id: string };
let task: { id: string; urn: string };

const as = (userId: string, extra: Partial<Context> = {}): Partial<Context> => ({ userId, ...extra });

async function mkUser(n: number, role?: 'OWNER' | 'ADMIN' | 'CONTRIBUTOR') {
  const u = await db.user.create({ data: { githubId: 72000 + n, githubUsername: `a${n}` } });
  if (role) await db.orgMember.create({ data: { organizationId: org.id, userId: u.id, role } });
  return u.id;
}

async function tpl(ctx: Partial<Context>, ownerType: string, ownerRef: string | null, input: Record<string, unknown>) {
  const r = await gql(ctx, CREATE_TPL, { t: ownerType, o: ownerRef, i: input });
  expect(r.errors, JSON.stringify(r.errors)).toBeUndefined();
  return r.data!.createMemoryConfigTemplate.template as { id: string; revision: number };
}
const apply = (ctx: Partial<Context>, t: string, m: string, extra: { v?: number; d?: boolean } = {}) => gql(ctx, APPLY, { t, m, ...extra });
const rulesOf = (memoryId: string) =>
  db.nodeRoleRule.findMany({ where: { config: { memoryId } }, orderBy: { role: 'asc' } });

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'acme', urn: 'acme.com' }, select: { id: true } });
  orgAdmin = await mkUser(1, 'ADMIN');
  contributor = await mkUser(3, 'CONTRIBUTOR');
  personalOwner = await mkUser(4, 'CONTRIBUTOR');
  const kb = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: 'acme.com:kb', name: 'kb', class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  const t = await db.node.create({ data: { id: generateId(), memoryId: kb.id, loc: 'tasks:author', name: 'Author', isRunnable: true } });
  task = { id: t.id, urn: 'hrn:node:acme.com:kb:tasks:author' };
  const m = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: 'acme.com:specs', name: 'specs', class: 'knowledge', visibility: 'ORGANIZATION' },
  });
  mem = { id: m.id, urn: 'acme.com:specs' };
  personal = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, userId: personalOwner, urn: 'acme.com:~a4', name: 'mine', class: 'private' },
    select: { id: true },
  });
});

describe('applyMemoryConfigTemplate (#1334 slice 1)', () => {
  it('APPLIED: copies every rule, stamped with provenance, unlocked for a non-required template', async () => {
    const t = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, {
      name: 'base',
      rules: [{ role: 'spec', authorTaskRef: task.urn, strictSubRoles: true, writers: 'OWNER' }, { role: 'review', enabled: false }],
    });
    const r = await apply(as(orgAdmin), t.id, mem.urn);
    expect(r.errors).toBeUndefined();
    const out = r.data!.applyMemoryConfigTemplate;
    expect(out).toMatchObject({ memoryId: mem.id, templateRevision: 1, required: false, dryRun: false, template: { id: t.id, name: 'base', deleted: false }, warnings: [] });
    expect(out.entries.map((e: any) => [e.role, e.outcome])).toEqual([['review', 'APPLIED'], ['spec', 'APPLIED']]);
    expect(out.entries[1].rule).toMatchObject({ authorTask: task.urn, authorTaskState: 'OK', strictSubRoles: true, writers: 'OWNER', locked: false, sourceTemplateId: t.id, revision: 1 });
    expect((await rulesOf(mem.id)).map((x) => [x.role, x.enabled, x.authorTaskRequired])).toEqual([['review', false, false], ['spec', true, true]]);
  });

  it('SKIPPED_CONFLICT: a non-required template never overrides the memory\'s own rule', async () => {
    await gql(as(orgAdmin), CREATE_RULE, { m: mem.id, i: { role: 'spec', writers: 'ADMIN' } });
    const t = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'base', rules: [{ role: 'spec', writers: 'ALL' }] });
    const r = await apply(as(orgAdmin), t.id, mem.id);
    expect(r.data!.applyMemoryConfigTemplate.entries).toEqual([
      expect.objectContaining({ role: 'spec', outcome: 'SKIPPED_CONFLICT', rule: expect.objectContaining({ writers: 'ADMIN', sourceTemplateId: null }) }),
    ]);
    expect((await rulesOf(mem.id))[0]).toMatchObject({ writers: 'ADMIN', revision: 1, sourceTemplateId: null });
  });

  it('REPLACED: a required template overwrites the rule and locks it; later template edits never reach it', async () => {
    const own = (await gql(as(orgAdmin), CREATE_RULE, { m: mem.id, i: { role: 'spec', writers: 'ALL' } })).data!.createNodeRoleRule.rule;
    const t = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'policy', required: true, rules: [{ role: 'spec', writers: 'ADMIN', authorTaskRef: task.id }] });
    const r = await apply(as(orgAdmin), t.id, mem.id);
    expect(r.data!.applyMemoryConfigTemplate.entries[0]).toMatchObject({
      role: 'spec', outcome: 'REPLACED', rule: { id: own.id, writers: 'ADMIN', locked: true, sourceTemplateId: t.id, revision: 2, authorTask: task.urn },
    });
    await gql(as(orgAdmin), UPDATE_TPL, { r: t.id, i: { rules: [{ role: 'spec', writers: 'OWNER' }] } });
    expect((await rulesOf(mem.id))[0]).toMatchObject({ writers: 'ADMIN', revision: 2 });
  });

  // SKIPPED_LOCKED is unreachable under H3: whoever can manage a memory's
  // config also holds its lock authority (an org memory's managers ARE its
  // org admins; any other memory has one manager). The check stays as the
  // fail-safe default for when managers widen (#1334, question to Holger).

  it('dryRun: the same report under the same checks, nothing written (not even the config row)', async () => {
    const t = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'base', rules: [{ role: 'spec' }] });
    const r = await apply(as(orgAdmin), t.id, mem.id, { d: true });
    expect(r.data!.applyMemoryConfigTemplate).toMatchObject({ dryRun: true, entries: [{ role: 'spec', outcome: 'APPLIED', rule: null }] });
    expect(await db.memoryConfig.count({ where: { memoryId: mem.id } })).toBe(0);
    await gql(as(orgAdmin), CREATE_RULE, { m: mem.id, i: { role: 'spec' } });
    const req = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'policy', required: true, rules: [{ role: 'spec', writers: 'ADMIN' }] });
    const dry = await apply(as(orgAdmin), req.id, mem.id, { d: true });
    expect(dry.data!.applyMemoryConfigTemplate.entries[0]).toMatchObject({ outcome: 'REPLACED', rule: { writers: 'ALL', locked: false } });
    expect((await rulesOf(mem.id))[0]).toMatchObject({ writers: 'ALL', locked: false, revision: 1 });
  });

  it('an empty template, or one whose every role is skipped, writes nothing: the config stays lazy (#1399 review)', async () => {
    const empty = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'empty' });
    const r = await apply(as(orgAdmin), empty.id, mem.id);
    expect(r.errors).toBeUndefined();
    expect(r.data!.applyMemoryConfigTemplate.entries).toEqual([]);
    expect(await db.memoryConfig.count({ where: { memoryId: mem.id } })).toBe(0);
    // All-skipped: the existing config is not stamped.
    await gql(as(orgAdmin), CREATE_RULE, { m: mem.id, i: { role: 'spec' } });
    const before = await db.memoryConfig.findUniqueOrThrow({ where: { memoryId: mem.id } });
    const soft = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'soft', rules: [{ role: 'spec', writers: 'ADMIN' }] });
    expect((await apply(as(orgAdmin), soft.id, mem.id)).data!.applyMemoryConfigTemplate.entries[0].outcome).toBe('SKIPPED_CONFLICT');
    const after = await db.memoryConfig.findUniqueOrThrow({ where: { memoryId: mem.id } });
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('expectedTemplateRevision: a template changed since the dry run is CONFLICT, and nothing is written', async () => {
    const t = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'base', rules: [{ role: 'spec' }] });
    await gql(as(orgAdmin), UPDATE_TPL, { r: t.id, i: { description: 'edited' } });
    const r = await apply(as(orgAdmin), t.id, mem.id, { v: 1 });
    expect(code(r)).toBe('CONFLICT');
    expect(r.errors![0].extensions).toMatchObject({ currentRevision: 2 });
    expect(await rulesOf(mem.id)).toEqual([]);
    expect((await apply(as(orgAdmin), t.id, mem.id, { v: 2 })).errors).toBeUndefined();
  });

  it('a template rule whose task was deleted (H5) refuses the WHOLE apply', async () => {
    const t = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'base', rules: [{ role: 'aaa' }, { role: 'spec', authorTaskRef: task.id }] });
    await db.node.delete({ where: { id: task.id } });
    const r = await apply(as(orgAdmin), t.id, mem.id);
    expect(code(r)).toBe('NODE_ROLE_RULE_REF_BROKEN');
    expect(r.errors![0].extensions).toMatchObject({ role: 'spec', field: 'authorTask' });
    expect(await rulesOf(mem.id)).toEqual([]);
  });

  it('references are re-validated for the caller: a soft-deleted task is NODE_NOT_FOUND, nothing written', async () => {
    const t = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'base', rules: [{ role: 'aaa' }, { role: 'spec', authorTaskRef: task.id }] });
    await db.node.update({ where: { id: task.id }, data: { deletedAt: new Date() } });
    expect(code(await apply(as(orgAdmin), t.id, mem.id))).toBe('NODE_NOT_FOUND');
    expect(await rulesOf(mem.id)).toEqual([]);
  });

  it('gates: an unmanageable memory reads as missing, an unmanageable template as missing; impersonation never writes', async () => {
    const t = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'base', rules: [{ role: 'spec' }] });
    expect(code(await apply(as(contributor), t.id, mem.id))).toBe('MEMORY_NOT_FOUND');
    // The org admin manages the memory, but not a user's own template.
    const theirs = await tpl(as(personalOwner), 'USER', null, { name: 'theirs', rules: [{ role: 'spec' }] });
    expect(code(await apply(as(orgAdmin), theirs.id, mem.id))).toBe('MEMORY_CONFIG_TEMPLATE_NOT_FOUND');
    const imp = as(orgAdmin, { impersonation: { sessionId: 'imp', actorUserId: orgAdmin, orgId: org.id, expiresAt: new Date(Date.now() + 60_000) } } as Partial<Context>);
    expect((await apply(imp, t.id, mem.id)).errors).toBeDefined();
    expect(await rulesOf(mem.id)).toEqual([]);
  });
});

describe('RULE_LOCKED (#1334 slice 1)', () => {
  it('a locked rule stays editable by its org admins, who hold lock authority; the lock is kept', async () => {
    const policy = await tpl(as(orgAdmin), 'ORGANIZATION', org.id, { name: 'policy', required: true, rules: [{ role: 'spec', writers: 'ADMIN' }] });
    const [entry] = (await apply(as(orgAdmin), policy.id, mem.id)).data!.applyMemoryConfigTemplate.entries;
    const upd = await gql(as(orgAdmin), UPDATE_RULE, { r: entry.rule.id, i: { writers: 'OWNER' } });
    expect(upd.errors).toBeUndefined();
    expect(upd.data!.updateNodeRoleRule.rule).toMatchObject({ writers: 'OWNER', locked: true, sourceTemplateId: policy.id, revision: 2 });
    expect((await gql(as(orgAdmin), DELETE_RULE, { r: entry.rule.id })).data!.deleteNodeRoleRule).toBe(true);
  });

  it('a personal/private memory: its strict owner is the only manager, so also the lock authority', async () => {
    const mine = await tpl(as(personalOwner), 'USER', null, { name: 'mine', required: true, rules: [{ role: 'spec', writers: 'ADMIN' }] });
    const [entry] = (await apply(as(personalOwner), mine.id, personal.id)).data!.applyMemoryConfigTemplate.entries;
    expect(entry.rule).toMatchObject({ locked: true });
    expect((await gql(as(personalOwner), UPDATE_RULE, { r: entry.rule.id, i: { writers: 'ALL' } })).errors).toBeUndefined();
    // An org admin does not manage a private memory's config at all (H3).
    expect(code(await gql(as(orgAdmin), UPDATE_RULE, { r: entry.rule.id, i: { writers: 'OWNER' } }))).toBe('NOT_FOUND');
  });
});
