/**
 * #5485 Ask 4 — the readers that must keep finding tasks and processes once they are node type `system`
 * (Agent system memories, stage 1). No test covered a runnable `system` node before this one.
 *
 * Fixture: an Agent whose system memory holds `system` tasks (role `task`, runnable) and a `system` process.
 * The unranked lists never looked at the type; the ranked list and `agentInstructions` reach the keyword search with
 * `filter: { isRunnable: true }`, which Ask 3 keeps finding `system` nodes for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { setEmbeddingClientForTests, resetEmbeddingClientForTests } from '../../../lib/embedding/index.js';
import { upsertAbstractVector } from '../../../services/embedding/vectors.js';
import { createTestableMcpServer } from '../../../mcp/server.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const Q = resolvers.Query as any;
const DIM = 768;
const basis = (i: number) => Array.from({ length: DIM }, (_, k) => (k === i ? 1 : 0));

let org: { id: string; urn: string };
let admin: string;
let agentId: string;
let memId: string;
let ids: Record<string, string>;
const ctx = (): Context => ({ db, userId: admin, roles: ['READER'] });
const mcp = () => createTestableMcpServer({ userId: admin, roles: ['READER'], clientId: `user:${admin}` } as never);

async function node(key: string, loc: string, extra: Record<string, unknown> = {}) {
  ids[key] = (await db.node.create({ data: { memoryId: memId, loc, name: key, content: `${key} body`, nodeType: 'system', ...extra } })).id;
  return ids[key];
}
let edgeN = 0;
const edge = (source: string, target: string, name: string) =>
  db.edge.create({ data: { memoryId: memId, sourceId: ids[source], targetId: ids[target], name, loc: `e${++edgeN}` } });

beforeEach(async () => {
  await cleanDb(db);
  ids = {};
  const n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Sys Tasks', urn: `systasks5485-${n}.example` }, select: { id: true, urn: true } });
  admin = (await db.user.create({ data: { handle: `st-admin-${n}`, roles: ['READER'] } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin, role: 'ADMIN' } });
  memId = (await db.memory.create({ data: { class: 'system', organizationId: org.id, name: 'bot system', urn: `${org.urn}:bot-system` } })).id;
  agentId = (await db.agent.create({ data: { organizationId: org.id, name: 'bot', urn: `${org.urn}:bot`, visibility: 'ORGANIZATION', systemMemoryId: memId } })).id;
  const app = await db.app.create({ data: { name: 'App', urn: `${org.urn}:app`, organizationId: org.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId } });

  await node('tasksIndex', 'tasks');
  await node('deploy', 'tasks:deploy', { isRunnable: true, role: 'task', abstract: 'Fix a failed deployment' });
  await node('review', 'tasks:review', { isRunnable: true, role: 'task.role', abstract: 'Review a pull request' });
  await node('procIndex', 'processes');
  await node('release', 'processes:release', { role: 'process' });
  await edge('deploy', 'tasksIndex', 'when deploying');
  await edge('review', 'tasksIndex', 'when reviewing');
  await edge('release', 'procIndex', 'when I cut a release');
  await edge('release', 'deploy', 'stage 2: deploy');
  await db.agent.update({ where: { id: agentId }, data: { tasksIndexRef: ids.tasksIndex, processesIndexRef: ids.procIndex } });
});
afterEach(() => { vi.unstubAllEnvs(); resetEmbeddingClientForTests(); });

const embeddingsOn = async () => {
  vi.stubEnv('EMBEDDING_API_URL', 'http://stub.invalid');
  vi.stubEnv('EMBEDDING_BACKEND', 'http');
  resetEmbeddingClientForTests();
  setEmbeddingClientForTests({ provider: 'test', model: '5485', dim: DIM, embed: async (texts: string[]) => texts.map(() => basis(0)) } as never);
  await db.memory.update({ where: { id: memId }, data: { vectorIndexEnabled: true } });
  await upsertAbstractVector(db, { nodeId: ids.deploy, memoryId: memId, provider: 'test', model: '5485', dim: DIM, embedding: basis(0) });
  await upsertAbstractVector(db, { nodeId: ids.review, memoryId: memId, provider: 'test', model: '5485', dim: DIM, embedding: basis(1) });
};

describe('#5485 the unranked lists read system nodes', () => {
  it('agentTaskList lists the system tasks and agentProcessList the system process', async () => {
    const tasks = await Q.agentTaskList({}, { ref: agentId }, ctx());
    expect(tasks.map((t: any) => t.node.id).sort()).toEqual([ids.deploy, ids.review].sort());
    const processes = await Q.agentProcessList({}, { ref: agentId }, ctx());
    expect(processes.map((p: any) => p.node.id)).toEqual([ids.release]);
  });
});

describe('#5485 the ranked list finds system tasks, embeddings off and on', () => {
  it('off: the keyword half ranks them', async () => {
    const hits = await Q.agentTaskList({}, { ref: agentId, phrase: 'deployment' }, ctx());
    expect(hits.map((h: any) => h.node.id)).toEqual([ids.deploy]);
    expect(hits[0].matchedBy).toBe('KEYWORD');
  });

  it('on: the vector and keyword halves rank them', async () => {
    await embeddingsOn();
    const hits = await Q.agentTaskList({}, { ref: agentId, phrase: 'deployment' }, ctx());
    expect(hits[0].node.id).toBe(ids.deploy);
    expect(hits[0].matchedBy).toBe('BOTH');
  });

  it('MCP hadron_agent_tasks with a phrase lists them', async () => {
    const text = await mcp().callToolText('hadron_agent_tasks', { agentRef: agentId, phrase: 'deployment' });
    expect(text).toContain('tasks:deploy');
  });
});

describe('#5485 agentInstructions lists them', () => {
  it('nearest (embeddings off: keyword only, no score reaches the floor) carries the system task', async () => {
    const res = await Q.agentInstructions({}, { agentRef: agentId, phrase: 'deployment' }, ctx());
    expect(res.state).toBe('NO_MATCH');
    expect(res.nearest.map((t: any) => t.node.id)).toEqual([ids.deploy]);
  });

  it('hadron_get_instructions lists it under nearest too', async () => {
    const text = await mcp().callToolText('hadron_get_instructions', { agentRef: agentId, phrase: 'deployment' });
    expect(text).toContain('tasks:deploy');
  });
});
