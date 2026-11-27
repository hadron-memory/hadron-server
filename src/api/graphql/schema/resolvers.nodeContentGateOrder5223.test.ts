/**
 * #5223: the five remaining content-ceiling doors measure size only AFTER the role-writer and
 * authoring gates (#5160 item 10 closed writeNodeCore's create branch and MCP hadron_create_node;
 * these are the doors it left). A size refusal counts stored fields, so a writer those gates
 * refuse must not learn the over/under bit. RED on main: every "gate's own refusal" case below
 * answers NODE_CONTENT_TOO_LARGE there. The refusals keep carrying only `maxBytes`, never the
 * measured size, and each refused case writes nothing.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { Client } from 'pg';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { sessionKeyCache } from '../../../lib/sessionKeyCache.js';
import { formatGraphQLError } from '../formatError.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
beforeAll(() => server.start());
afterAll(() => server.stop());
interface Result { data?: Record<string, any> | null; errors?: ReadonlyArray<{ message: string; extensions?: Record<string, unknown> }> }
let u: string, admin: string, orgId: string, mem: string;
async function gql(query: string, variables: Record<string, unknown>, ctx: Partial<Context> = {}): Promise<Result> {
  const contextValue = { db, userId: u, roles: ['READER'], ...ctx } as Context;
  const res = await server.executeOperation({ query, variables }, { contextValue });
  if (res.body.kind !== 'single') throw new Error('unexpected');
  return res.body.singleResult as Result;
}
const UPDATE = `mutation($input: UpdateNodeInput!) { updateNode(input: $input) { id } }`;
const REPLACE = `mutation($input: SearchReplaceInNodesInput!) { searchReplaceInNodes(input: $input) { nodesChanged } }`;
const MERGE = `mutation($input: MergeNodesInput!) { mergeNodes(input: $input) { id } }`;
const RESTORE = `mutation($ref: String!) { restoreNodeRevision(nodeRevRef: $ref) { id } }`;

const cap = (n: number | '') => vi.stubEnv('NODE_CONTENT_MAX_BYTES', String(n));
const a = (n: number) => 'a'.repeat(n);
const code = (r: Result) => r.errors?.[0]?.extensions?.code;
const node = (loc: string, extra: Record<string, unknown> = {}, memoryId = mem) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, ...extra } });
const row = (id: string) => db.node.findUniqueOrThrow({ where: { id } });
/** The rulebook rows a door's role/authoring gate reads, on the memory under test. */
async function rules(memoryId: string, ...rows: Array<Record<string, unknown>>) {
  const config = await db.memoryConfig.create({ data: { id: generateId(), memoryId } });
  for (const r of rows) await db.nodeRoleRule.create({ data: { id: generateId(), configId: config.id, ...r } });
  return config;
}

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  u = (await db.user.create({ data: { id: generateId(), handle: 'go5223-u', email: 'go5223-u@example.test', roles: ['READER'] } })).id;
  admin = (await db.user.create({ data: { id: generateId(), handle: 'go5223-a', email: 'go5223-a@example.test', roles: ['ADMIN'] } })).id;
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'go5223', urn: 'go5223-org' } })).id;
  for (const userId of [u, admin]) await db.orgMember.create({ data: { organizationId: orgId, userId, role: 'OWNER' } });
  mem = (await db.memory.create({ data: { id: generateId(), name: 'm', urn: 'go5223-org:m', class: 'knowledge', organizationId: orgId, vectorIndexEnabled: false } })).id;
  cap(1000);
});
afterEach(() => { vi.unstubAllEnvs(); sessionKeyCache.clear(); });

describe('#5223 door 1 — mergeNodes: the role and authoring gates answer before the ceiling', () => {
  it('a demoted writer gets ROLE_WRITER_LEVEL_REQUIRED, not the size bit', async () => {
    await db.orgMember.updateMany({ where: { userId: u }, data: { role: 'CONTRIBUTOR' } });
    await rules(mem, { role: 'policy', writers: 'ADMIN' });
    const s = await node('s', { content: a(600) });
    const t = await node('t', { role: 'policy', content: a(600) });
    expect(code(await gql(MERGE, { input: { source: s.id, target: t.id, deleteSource: true } }))).toBe('ROLE_WRITER_LEVEL_REQUIRED');
    expect((await row(t.id)).content).toBe(a(600));
    expect((await row(s.id)).deletedAt).toBeNull();
    expect(await db.nodeRevision.count({ where: { nodeId: t.id } })).toBe(0);
  });

  it('a writer without the authoring claim gets AUTHORING_ATTESTATION_MISSING, not the size bit', async () => {
    const task = await node('author-task', { isRunnable: true, content: 'instructions' });
    await rules(mem, { role: 'guide', authorTaskId: task.id, authorTaskRequired: true });
    const s = await node('s', { content: a(600) });
    const t = await node('t', { role: 'guide', content: a(600) });
    expect(code(await gql(MERGE, { input: { source: s.id, target: t.id } }))).toBe('AUTHORING_ATTESTATION_MISSING');
    expect((await row(t.id)).content).toBe(a(600));
    expect(await db.nodeRevision.count({ where: { nodeId: t.id } })).toBe(0);
  });
});

describe('#5223 door 2 — restoreNodeRevision: the locked row\'s role gate answers before the ceiling', () => {
  // The rulebook lands while the restore is blocked on the revision row lock, so only the
  // authoritative in-transaction gate can see it — the fast pre-transaction refusal passed.
  it('a rule that appears under the revision lock refuses a demoted writer, not the size bit', async () => {
    cap('');
    const n = await node('n', { role: 'policy', content: a(2000) });
    await gql(UPDATE, { input: { ref: n.id, content: 'short' } });
    const rev = await db.nodeRevision.findFirstOrThrow({ where: { nodeId: n.id } });
    cap(1000);
    await db.orgMember.updateMany({ where: { userId: u }, data: { role: 'CONTRIBUTOR' } });
    // A raw pg connection on the per-worker DATABASE_URL (never TEST_DATABASE_URL): the same
    // database the server under test pools into.
    const holder = new Client({ connectionString: process.env.DATABASE_URL });
    const observer = new Client({ connectionString: process.env.DATABASE_URL });
    await holder.connect();
    await observer.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM node_revisions WHERE id = $1 FOR UPDATE', [rev.id]);
      const restore = gql(RESTORE, { ref: rev.id });
      const deadline = Date.now() + 4000;
      for (;;) {
        const { rows } = await observer.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%node_revisions%' AND pid <> pg_backend_pid()`);
        if (rows[0].n > 0) break;
        if (Date.now() > deadline) throw new Error('the restore never blocked on the revision row lock');
        await new Promise((res) => setTimeout(res, 25));
      }
      const configId = generateId();
      await observer.query('INSERT INTO memory_configs (id, memory_id, created_at) VALUES ($1, $2, now())', [configId, mem]);
      await observer.query(`INSERT INTO node_role_rules (id, config_id, role, writers) VALUES ($1, $2, 'policy', 'ADMIN')`, [generateId(), configId]);
      await holder.query('ROLLBACK');
      expect(code(await restore)).toBe('ROLE_WRITER_LEVEL_REQUIRED');
      expect((await row(n.id)).content).toBe('short');
      expect(await db.nodeRevision.count({ where: { nodeId: n.id } })).toBe(1);
    } finally {
      await observer.end();
      await holder.end();
    }
  }, 15_000);
});

describe('#5223 door 3a — searchReplaceInSpecNodes: authoring answers before the ceiling, and a dry run previews', () => {
  it('a dry run previews the over-size change; an apply without the claim is refused for authoring and writes nothing', async () => {
    const draft = await resolvers.Mutation.createMemory(null, { orgRef: orgId, name: 'specs-draft', draftCorpus: true } as never, { db, roles: ['ADMIN'], userId: admin } as Context) as { id: string };
    const task = await node('author-task', { isRunnable: true, content: 'instructions' }, draft.id);
    const spec = await node('pas:010:01', { content: `cat ${a(990)}`, role: 'spec' }, draft.id);
    await rules(draft.id, { role: 'spec', authorTaskId: task.id, authorTaskRequired: true });
    const input = { memoryRef: draft.id, nodeRefs: [spec.id], oldText: 'cat', newText: a(20), fields: ['content'] as Array<'content'>, dryRun: true };
    const run = (extra: Record<string, unknown> = {}) => resolvers.Mutation.searchReplaceInSpecNodes(null, { input: { ...input, ...extra } } as never, { db, roles: ['ADMIN'], userId: admin } as Context);
    const dry = await run() as { nodesChanged: number; plan: string };
    expect(dry.nodesChanged).toBe(1);
    await expect(run({ dryRun: false, expectedPlan: dry.plan })).rejects.toMatchObject({ extensions: { code: 'AUTHORING_ATTESTATION_MISSING' } });
    expect((await row(spec.id)).content).toContain('cat');
    expect(await db.nodeRevision.count({ where: { nodeId: spec.id } })).toBe(0);
  });
});

describe('#5223 door 3b — searchReplaceInNodes: authoring answers before the ceiling, and a dry run previews', () => {
  it('a dry run previews the over-size change; an apply without the claim is refused for authoring and writes nothing', async () => {
    const task = await node('author-task', { isRunnable: true, content: 'instructions' });
    await rules(mem, { role: 'guide', authorTaskId: task.id, authorTaskRequired: true });
    const n = await node('n', { role: 'guide', content: `cat ${a(990)}` });
    const input = { oldText: 'cat', newText: a(20), nodeRefs: [n.id], fields: ['content'] };
    const dry = await gql(REPLACE, { input: { ...input, dryRun: true } });
    expect(dry.errors).toBeUndefined();
    expect(dry.data!.searchReplaceInNodes.nodesChanged).toBe(1);
    expect(code(await gql(REPLACE, { input }))).toBe('AUTHORING_ATTESTATION_MISSING');
    expect((await row(n.id)).content).toBe(`cat ${a(990)}`);
    expect(await db.nodeRevision.count({ where: { nodeId: n.id } })).toBe(0);
  });
});

describe('#5223 door 4 — updateNode: the authoring gate answers before the ceiling', () => {
  it('a writer without the authoring claim gets AUTHORING_ATTESTATION_MISSING, not the size bit', async () => {
    const task = await node('author-task', { isRunnable: true, content: 'instructions' });
    await rules(mem, { role: 'guide', authorTaskId: task.id, authorTaskRequired: true });
    const n = await node('n', { role: 'guide', content: 'short' });
    expect(code(await gql(UPDATE, { input: { ref: n.id, content: a(1001) } }))).toBe('AUTHORING_ATTESTATION_MISSING');
    expect((await row(n.id)).content).toBe('short');
    expect(await db.nodeRevision.count({ where: { nodeId: n.id } })).toBe(0);
  });
});
