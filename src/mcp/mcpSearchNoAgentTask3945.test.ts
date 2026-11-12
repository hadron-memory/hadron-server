/**
 * #3945 (cor:api:050 recorded exception) pinned on the REGISTERED MCP tool, #3971: `hadron_search` neither lists nor
 * returns tasks. Both halves are asserted where they are served, not by reading `server.ts` as text.
 *  - "neither lists": the registered `entityTypes` schema accepts exactly the seven non-task values and rejects `agentTask`.
 *  - "nor returns": the handler, called with no `entityTypes`, returns no task for an exact-handle query, from a caller who
 *    WOULD get that task on GraphQL (an App participant), proven by a GraphQL `globalSearch` control with the same caller and query.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;

const SEVEN = ['organization', 'memory', 'node', 'agent', 'app', 'aiServiceConfig', 'user'];

describe('MCP hadron_search excludes agentTask on the registered tool (#3945, #3971)', () => {
  let user: { id: string };
  let handle: string;
  let taskId: string;
  const gqlCtx = (): Context => ({ db, userId: user.id, roles: ['READER'] });

  beforeEach(async () => {
    await cleanDb(db);
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
    const org = await db.organization.create({ data: { id: generateId(), name: 'm-org', urn: `m-org-${suffix}.com` } });
    user = await db.user.create({
      data: { id: generateId(), githubId: 99_390, githubUsername: `m-${suffix}`, roles: ['READER'] },
      select: { id: true },
    });
    const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'A', urn: `${org.urn}:a` } });
    await db.appMember.create({ data: { appId: app.id, userId: user.id, role: 'member' } });
    const task = (await M.createAgentTask({}, { input: { appRef: app.id, title: 'mcp invisible' } }, gqlCtx())) as { id: string; handle: string };
    taskId = task.id;
    handle = task.handle;
  });

  it('neither lists: the registered entityTypes schema accepts the seven non-task values and rejects agentTask', () => {
    const schema = createTestableMcpServer({ userId: user.id, roles: ['READER'] }).toolParamSchema('hadron_search', 'entityTypes');
    expect(schema.parse(SEVEN)).toEqual(SEVEN);
    for (const t of SEVEN) expect(schema.parse([t])).toEqual([t]);
    expect(() => schema.parse(['agentTask'])).toThrow();
    expect(() => schema.parse([...SEVEN, 'agentTask'])).toThrow();
  });

  it('control: the same caller and exact handle DO get the task from GraphQL globalSearch', async () => {
    const r = await Q.globalSearch({}, { query: handle }, gqlCtx());
    expect(r.hits.filter((h: { entityType: string; id: string }) => h.entityType === 'agentTask' && h.id === taskId)).toHaveLength(1);
  });

  it('nor returns: the handler, with no entityTypes, returns no task for that exact handle', async () => {
    const text = await createTestableMcpServer({ userId: user.id, roles: ['READER'] }).callToolText('hadron_search', { query: handle });
    // The tool echoes the query back in its empty answer, so assert on hit lines and the title, not on the handle text.
    expect(text).not.toContain('[agentTask]');
    expect(text).not.toContain('mcp invisible');
    expect(text.split('\n').filter((l) => l.startsWith('- ['))).toEqual([]);
    expect(text).toContain(`No results for "${handle}"`);
  });
});
