/**
 * #2971 Slice 2: Holger's list ruling already holds on main. Pin the default
 * page and the explicit-limit compatibility path used by CLI v0.32.1.
 * These are green-on-main controls; changing the default or bypassing the
 * workers resolver's clampListTake must turn them red (gate 6549527563).
 */
import { ApolloServer } from '@apollo/server';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { serveAgentBootPrompt } from '../../../test/servedBootPrompt.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));

const COUNT = 205;
const names = Array.from({ length: COUNT }, (_, i) => `PageWorker${String(i).padStart(3, '0')}`);
const QUERY = `query WorkersPage2971($app: ID!, $limit: Int, $offset: Int, $includeRetired: Boolean) {
  workers(appRef: $app, limit: $limit, offset: $offset, includeRetired: $includeRetired) {
    total
    items { id name prompt }
  }
}`;
type Page = { total: number; items: Array<{ id: string; name: string; prompt: string | null }> };
let api: ApolloServer<Context>;
let appId: string;
let userId: string;

beforeAll(async () => { api = new ApolloServer<Context>({ typeDefs, resolvers }); });
afterAll(async () => { await api.stop(); });
beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { name: 'Pages', urn: `pages-${generateId().toLowerCase()}.example` } });
  userId = (await db.user.create({ data: { roles: ['READER'] } })).id;
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
  const ctx: Context = { db, userId, roles: ['READER'] };
  const agent = await resolvers.Mutation.createAgent({}, { orgId: org.id, name: 'Page Agent', personaRole: 'engineer' }, ctx);
  await serveAgentBootPrompt(db, agent.id, 'PAGE-PROMPT {{worker.name}}');
  const app = await db.app.create({ data: { organizationId: org.id, name: 'Pages', urn: `${org.urn}:pages` } });
  appId = app.id;
  await db.appAgent.create({ data: { appId, agentId: agent.id } });
  const start = Date.UTC(2026, 0, 1);
  await db.worker.createMany({ data: names.map((name, i) => ({
    ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId: agent.id,
    name, slug: name.toLowerCase(), role: 'engineer', heldByUserId: userId,
    createdAt: new Date(start + i),
  })) });
});

async function page(args: { limit?: number; offset?: number; includeRetired?: boolean } = {}): Promise<Page> {
  const response = await api.executeOperation({ query: QUERY, variables: { app: appId, ...args } }, {
    contextValue: { db, userId, roles: ['READER'] },
  });
  expect(response.body.kind).toBe('single');
  if (response.body.kind !== 'single') throw new Error('unexpected incremental response');
  expect(response.body.singleResult.errors).toBeUndefined();
  const result = response.body.singleResult.data?.workers as Page;
  // A prompt selection must not impose a separate cap or silently null it.
  for (const worker of result.items) expect(worker.prompt).toContain(`PAGE-PROMPT ${worker.name}`);
  return result;
}

it('omitting limit returns exactly the first 20 workers with the real total', async () => {
  const result = await page();
  expect(result.total).toBe(COUNT);
  expect(result.items.map((w) => w.name)).toEqual(names.slice(0, 20));
});

it('explicit limit 200 pages to exhaustion and finds the 21st worker, like old scanWorkers', async () => {
  const found: Page['items'] = [];
  const sizes: number[] = [];
  // Bound the loop so an offset regression fails rather than hanging the suite.
  let offset = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await page({ limit: 200, offset, includeRetired: true });
    expect(result.total).toBe(COUNT);
    sizes.push(result.items.length);
    found.push(...result.items);
    offset += result.items.length;
    if (result.items.length < 200 || offset >= result.total) break;
  }
  expect(sizes).toEqual([200, 5]);
  expect(found.map((w) => w.name)).toEqual(names);
  expect(new Set(found.map((w) => w.id)).size).toBe(COUNT);
  expect(found.find((w) => w.name === names[20])?.name).toBe('PageWorker020');
});

it('explicit limit above 200 is clamped to the existing maximum with the real total', async () => {
  const result = await page({ limit: 201 });
  expect(result.total).toBe(COUNT);
  expect(result.items.map((w) => w.name)).toEqual(names.slice(0, 200));
});
