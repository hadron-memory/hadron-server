/**
 * #5080 acceptance, "a URN works on every renamed name": through a real ApolloServer, the primary key and a
 * fully-qualified URN give the same result on each renamed field. Rows 8, 19 and 20 are held in
 * resolvers.entityRefInputs775.test.ts and row 21 in resolvers.deliveryBatchSelf.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { formatGraphQLError } from '../formatError.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/objectstore/index.js', () => ({
  mintPutUrl: vi.fn().mockResolvedValue('https://r2.example/presigned-put'),
  mintGetUrl: vi.fn().mockResolvedValue('https://bucket/presigned-get'),
  headObject: vi.fn(), deleteObject: vi.fn(), copyObject: vi.fn(), readObjectPrefix: vi.fn(),
  getObjectStoreBucket: vi.fn().mockReturnValue('test-bucket'),
}));

const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;

let org: { id: string; urn: string };
let admin: { id: string };
let appId: string;
let agent: { id: string; urn: string };
let mem: { id: string; urn: string };
let draft: { id: string; urn: string };
let source: { id: string; urn: string };
let target: { id: string; urn: string };
let spec: { id: string; urn: string };

const ctx = (): Context => ({ db, userId: admin.id, roles: ['ADMIN'] } as Context);
async function ok(query: string, variables: Record<string, unknown>): Promise<any> {
  const res = await server.executeOperation({ query, variables }, { contextValue: ctx() });
  if (res.body.kind !== 'single') throw new Error('unexpected incremental response');
  expect(res.body.singleResult.errors).toBeUndefined();
  return res.body.singleResult.data;
}

beforeEach(async () => {
  await cleanDb(db);
  const t = generateId().slice(-8);
  org = await db.organization.create({ data: { id: generateId(), name: `ru-${t}`, urn: `ru-${t}.example` } });
  admin = await db.user.create({ data: { id: generateId(), handle: `rua${t}`, roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const made = await M.createAgent!({}, { orgRef: org.id, name: 'Ref Agent' }, ctx());
  agent = await db.agent.findUniqueOrThrow({ where: { id: made.id }, select: { id: true, urn: true } }) as { id: string; urn: string };
  appId = (await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } })).id;
  await db.appAgent.create({ data: { appId, agentId: agent.id } });
  await db.appMember.create({ data: { appId, userId: admin.id, role: 'owner' } });
  const memory = async (name: string, draftCorpus: boolean) => {
    const m = await M.createMemory!({}, { orgRef: org.id, name, draftCorpus }, ctx());
    return { id: m.id as string, urn: `hrn:mem:${org.urn}:${name}` };
  };
  mem = await memory('know', false);
  draft = await memory('draft', true);
  const node = async (m: { id: string; urn: string }, name: string, loc: string, extra: Record<string, unknown> = {}) => {
    const row = await db.node.create({ data: { id: generateId(), memoryId: m.id, loc, name: loc, content: 'cat', ...extra } });
    return { id: row.id, urn: `hrn:node:${org.urn}:${name}:${loc}` };
  };
  source = await node(mem, 'know', 'source');
  target = await node(mem, 'know', 'target');
  spec = await node(draft, 'draft', 'pas:010:01', { role: 'spec' });
  await db.edge.create({ data: { id: generateId(), memoryId: mem.id, sourceId: source.id, targetId: target.id, name: 'rel', loc: 'source:rel:target' } as never });
});

/** Asks once with the primary key and once with the URN; both answers must be the same and non-empty. */
async function same(pk: string, urn: string, run: (ref: string) => Promise<unknown>) {
  const byPk = await run(pk);
  expect(await run(urn)).toEqual(byPk);
  return byPk as any;
}

describe('filters (rows 1-6)', () => {
  it('NodeFilter.memoryRefs', async () => {
    const a = await same(mem.id, mem.urn, async (r) => (await ok('query($f:NodeFilter){findNodes(filter:$f){hits{node{id}}}}', { f: { memoryRefs: [r] } })).findNodes.hits.map((h: any) => h.node.id).sort());
    expect(a).toEqual([source.id, target.id].sort());
  });
  it.each(['memoryRef', 'sourceRef', 'targetRef'] as const)('EdgeFilter.%s', async (field) => {
    const [pk, urn] = field === 'memoryRef' ? [mem.id, mem.urn] : field === 'sourceRef' ? [source.id, source.urn] : [target.id, target.urn];
    const a = await same(pk, urn, async (r) => (await ok('query($f:EdgeFilter){edges(filter:$f){total items{id}}}', { f: { [field]: r } })).edges);
    expect(a.total).toBe(1);
  });
  it('AppFilter.agentRef', async () => {
    const a = await same(agent.id, agent.urn, async (r) => (await ok('query($f:AppFilter){apps(filter:$f){items{id}}}', { f: { agentRef: r } })).apps.items);
    expect(a).toEqual([{ id: appId }]);
  });
  it('createAiServiceConfig(ownerRef:) and AiServiceConfigFilter.ownerRef', async () => {
    const CREATE = 'mutation($r:ID!,$n:String!){createAiServiceConfig(ownerType:AGENT,ownerRef:$r,name:$n,provider:"openai",model:"m",apiKey:"k"){ownerId}}';
    for (const [i, r] of [agent.id, agent.urn].entries()) {
      expect((await ok(CREATE, { r, n: `c${i}` })).createAiServiceConfig.ownerId).toBe(agent.id);
    }
    const a = await same(agent.id, agent.urn, async (r) => (await ok('query($f:AiServiceConfigFilter){aiServiceConfigs(filter:$f){total}}', { f: { ownerType: 'AGENT', ownerRef: r } })).aiServiceConfigs.total);
    expect(a).toBe(2);
  });
});

describe('node doors (rows 7, 9-16)', () => {
  it('NodeAuthoringCheckInput.memoryRef', async () => {
    await same(mem.id, mem.urn, async (r) => (await ok('query($i:NodeAuthoringCheckInput!){nodeAuthoringCheck(input:$i){state code}}', { i: { memoryRef: r, loc: 'source' } })).nodeAuthoringCheck);
  });
  it('UpdateNodeInput.ref', async () => {
    for (const r of [source.id, source.urn]) {
      expect((await ok('mutation($i:UpdateNodeInput!){updateNode(input:$i){id}}', { i: { ref: r, content: `by ${r}` } })).updateNode.id).toBe(source.id);
      expect((await db.node.findUniqueOrThrow({ where: { id: source.id } })).content).toBe(`by ${r}`);
    }
  });
  it('UpdateNodeInput.memoryRef', async () => {
    for (const r of [mem.id, mem.urn]) {
      expect((await ok('mutation($i:UpdateNodeInput!){updateNode(input:$i){id}}', { i: { memoryRef: r, loc: 'source', content: `by ${r}` } })).updateNode.id).toBe(source.id);
      expect((await db.node.findUniqueOrThrow({ where: { id: source.id } })).content).toBe(`by ${r}`);
    }
  });
  it('ImportNodeInput.memoryRef', async () => {
    const ids: string[] = [];
    for (const r of [mem.id, mem.urn]) {
      ids.push((await ok('mutation($i:ImportNodeInput!){importNode(input:$i){node{id}}}', { i: { memoryRef: r, loc: 'imported', content: '# x', contentType: 'text/markdown' } })).importNode.node.id);
    }
    expect(ids[1]).toBe(ids[0]);
  });
  it('NodeEdgeInput.targetRef', async () => {
    for (const [i, r] of [target.id, target.urn].entries()) {
      const made = (await ok('mutation($i:CreateNodeInput!){createNode(input:$i){id}}', { i: { memoryRef: mem.id, loc: `linked-${i}`, name: 'l', edges: [{ targetRef: r, name: 'to' }] } })).createNode;
      expect((await db.edge.findMany({ where: { sourceId: made.id } })).map((e) => e.targetId)).toEqual([target.id]);
    }
  });
  const REPLACE = 'mutation($i:SearchReplaceInNodesInput!){searchReplaceInNodes(input:$i){nodesSelected nodesChanged}}';
  const replace = async (selector: Record<string, unknown>) => (await ok(REPLACE, { i: { ...selector, oldText: 'cat', newText: 'dog', fields: ['content'], dryRun: true } })).searchReplaceInNodes;
  it('SearchReplaceInNodesInput.nodeRefs', async () => {
    expect(await same(source.id, source.urn, (r) => replace({ nodeRefs: [r] }))).toEqual({ nodesSelected: 1, nodesChanged: 1 });
  });
  it('SearchReplaceInNodesInput.memoryRefs', async () => {
    expect(await same(mem.id, mem.urn, (r) => replace({ memoryRefs: [r] }))).toEqual({ nodesSelected: 2, nodesChanged: 2 });
  });
  it('SpecSearchReplaceInput.nodeRefs', async () => {
    const a = await same(spec.id, spec.urn, async (r) => (await ok('mutation($i:SpecSearchReplaceInput!){searchReplaceInSpecNodes(input:$i){nodesSelected nodesChanged plan}}', { i: { memoryRef: draft.id, nodeRefs: [r], oldText: 'cat', newText: 'dog', fields: ['content'], dryRun: true } })).searchReplaceInSpecNodes);
    expect(a.nodesChanged).toBe(1);
  });
  it('BeginAssetUploadV2Input.memoryRef', async () => {
    // The upload is only recorded in process; the storage key's prefix names the memory it was begun in.
    const prefix = await same(mem.id, mem.urn, async (r) => {
      const made = (await ok('mutation($i:BeginAssetUploadV2Input!){beginAssetUploadV2(input:$i){storageKey}}', { i: { memoryRef: r, filename: 'a.pdf', mimeType: 'application/pdf', sizeBytes: 10, uploadIntent: 'USER' } })).beginAssetUploadV2;
      return (made.storageKey as string).split('/').slice(0, -1).join('/').replace(/[0-9a-f]{32}/g, '*');
    });
    expect(prefix).toContain('know');
  });
});

describe('tasks (rows 17, 18)', () => {
  const root = () => M.createAgentTask!({}, { input: { appRef: appId, title: 'root', assignee: { user: admin.id }, source: 'synthetic' } }, ctx());
  const parentOf = async (id: string) => (await db.agentTask.findUniqueOrThrow({ where: { id } })).parentTaskId;
  const urnOf = (handle: string) => `hrn:agenttask:${org.urn}:team:${handle.toLowerCase()}`;

  it('CreateAgentTaskInput.parentTaskRef', async () => {
    const parent = await root();
    await M.startAgentTask!({}, { taskRef: parent.id }, ctx());
    for (const r of [parent.id, urnOf(parent.handle)]) {
      const made = (await ok('mutation($i:CreateAgentTaskInput!){createAgentTask(input:$i){id}}', { i: { parentTaskRef: r, title: 'child', source: 'synthetic' } })).createAgentTask;
      expect(await parentOf(made.id)).toBe(parent.id);
    }
  });
  it('CloneAgentTaskInput.parentTaskRef', async () => {
    const parent = await root();
    const from = await root();
    await M.startAgentTask!({}, { taskRef: parent.id }, ctx());
    for (const r of [parent.id, urnOf(parent.handle)]) {
      const made = (await ok('mutation($r:ID!,$i:CloneAgentTaskInput){cloneAgentTask(taskRef:$r,input:$i){id}}', { r: from.id, i: { parentTaskRef: r } })).cloneAgentTask;
      expect(await parentOf(made.id)).toBe(parent.id);
    }
  });
});
