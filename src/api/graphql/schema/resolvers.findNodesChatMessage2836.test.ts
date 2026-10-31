/**
 * #2836 (cor:api:090:02) — unqualified findNodes leaves out chat-message nodes
 * (alongside system and comments); an explicit nodeType wins; `record` stays
 * searchable. The default lives at two sites (the SQL filterClause and the
 * Prisma structuredWhere), so every mode is pinned.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import type { EmbeddingClient } from '../../../lib/embedding/index.js';
import { resetEmbeddingClientForTests, setEmbeddingClientForTests } from '../../../lib/embedding/index.js';
import { embedNode } from '../../../jobs/embedNodes.js';
import { resolvers, type Context } from './resolvers.js';

const DIM = 768;
const oneHot = (slot: number): number[] => {
  const v = new Array(DIM).fill(0);
  v[slot % DIM] = 1;
  return v;
};
const stubClient: EmbeddingClient = {
  provider: 'test',
  model: 'stub-model',
  dim: DIM,
  async embed(texts: string[]) {
    return texts.map(() => oneHot(1));
  },
};

let admin: { id: string };
let memory: { id: string };
const as = (): Context => ({ db, userId: admin.id, roles: ['ADMIN'] });
const findNodes = (args: Record<string, unknown>) => (resolvers.Query as any).findNodes(null, args, as());
const locs = (res: { hits: Array<{ node: { loc: string } }> }) => res.hits.map((h) => h.node.loc).sort();

beforeEach(async () => {
  await cleanDb(db);
  process.env.EMBEDDING_API_URL = 'http://stub.local/api/embed';
  setEmbeddingClientForTests(stubClient);
  const org = await db.organization.create({ data: { id: generateId(), name: 'Chat Org', urn: 'chat.example' } });
  admin = await db.user.create({ data: { githubId: 283601, githubUsername: 'chat-admin', handle: 'chat-admin', roles: [] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await resolvers.Mutation.createMemory(null, { orgId: org.id, name: 'chatty' }, as());
});

afterAll(() => {
  resetEmbeddingClientForTests();
  delete process.env.EMBEDDING_API_URL;
});

/** A chat root with a chat-message child, a record child and an info child, all about "deploy". */
async function seed() {
  const row = (loc: string, nodeType: string) => ({
    id: generateId(), memoryId: memory.id, loc, nodeType,
    name: `deploy ${loc}`, abstract: 'deploy notes', content: 'deploy notes text',
  });
  await db.node.createMany({
    data: [
      row('chat:root', 'info'),
      // The messages outrank the record on every lexical score, so a leak at the SQL site
      // would take the one-row page (the Prisma re-check would then drop it, leaving it empty).
      { ...row('chat:root:m1', 'chat-message'), abstract: 'deploy deploy deploy deploy', name: 'deploy deploy' },
      { ...row('chat:root:m2', 'chat-message'), abstract: 'deploy deploy deploy deploy', name: 'deploy deploy' },
      row('chat:root:r1', 'record'),
      row('doc:a', 'info'),
    ],
  });
}

const MSGS = ['chat:root:m1', 'chat:root:m2'];
const scope = () => ({ memoryIds: [memory.id] });

describe('findNodes excludes chat-message by default (cor:api:090:02)', () => {
  it('keyword, regex and filter-only browse return no chat-message nodes, and keep record and info', async () => {
    await seed();
    for (const args of [{ query: 'deploy' }, { query: 'deploy', mode: 'regex' }, {}]) {
      const res = await findNodes({ ...args, filter: scope(), limit: 50 });
      const got = locs(res);
      for (const m of MSGS) expect(got, JSON.stringify(args)).not.toContain(m);
      expect(got, JSON.stringify(args)).toContain('chat:root:r1');
      expect(got, JSON.stringify(args)).toContain('doc:a');
    }
  });

  it('the no-query browse page and SQL total are computed after the exclusion', async () => {
    await seed();
    const kept = await db.node.count({ where: { memoryId: memory.id, deletedAt: null, nodeType: { notIn: ['system', 'chat-message', 'comment'] } } });
    const page = await findNodes({ filter: scope(), limit: 50 });
    expect(page.hits).toHaveLength(kept);
    // The SQL total (filterCount) is the only place a leak at the SQL site shows in browse.
    const counted = await findNodes({ filter: scope(), includeTotal: true, limit: 1 });
    expect(counted.total).toBe(kept);
    const msgTotal = await findNodes({ filter: { ...scope(), nodeType: 'chat-message' }, includeTotal: true, limit: 1 });
    expect(msgTotal.total).toBe(2);
  });

  it('a one-row ranked page is not consumed by a chat-message that outranks the record (SQL site)', async () => {
    await seed();
    for (const mode of ['keyword', 'regex'] as const) {
      const one = await findNodes({ query: 'deploy', mode, filter: { ...scope(), locPrefix: 'chat:root:' }, limit: 1 });
      expect(one.hits.map((h: any) => h.node.loc), mode).toEqual(['chat:root:r1']);
    }
  });

  it('vector and hybrid keep returning record nodes and never a chat-message (raw chat is not embedded)', async () => {
    await db.memory.update({ where: { id: memory.id }, data: { vectorIndexEnabled: true } });
    await seed();
    for (const node of await db.node.findMany({ where: { memoryId: memory.id, nodeType: { not: 'chat-message' }, loc: { startsWith: 'chat:root' } } })) {
      await db.node.update({ where: { id: node.id }, data: { embeddingWorkToken: randomUUID(), embeddingPendingAt: new Date() } });
      expect(['embedded', 'skipped']).toContain(await embedNode(db, node.id, { abstract: node.abstract }));
    }
    for (const mode of ['vector', 'hybrid']) {
      const res = await findNodes({ query: 'deploy', mode, filter: scope(), limit: 20 });
      for (const m of MSGS) expect(locs(res), mode).not.toContain(m);
      expect(locs(res), mode).toContain('chat:root:r1');
    }
  });

  it('an explicit nodeType chat-message wins, in every lexical mode and the browse', async () => {
    await seed();
    for (const args of [{ query: 'deploy' }, { query: 'deploy', mode: 'regex' }, {}]) {
      const res = await findNodes({ ...args, filter: { ...scope(), nodeType: 'chat-message' }, limit: 50 });
      expect(locs(res), JSON.stringify(args)).toEqual(MSGS);
    }
  });

  it('a record child under a chat root is returned unqualified (the chatbot path stays searchable)', async () => {
    await seed();
    const res = await findNodes({ query: 'deploy', filter: { ...scope(), locPrefix: 'chat:root:' }, limit: 50 });
    expect(locs(res)).toEqual(['chat:root:r1']);
  });
});
