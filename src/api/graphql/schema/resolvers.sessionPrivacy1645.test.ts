/** #1645 / DT: sessions and nested events honor bound strict-owner memories. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });
let owner: string,
  member: string,
  admin: string,
  platform: string,
  org: string,
  app: string;
let privateSession: string, personalSession: string, workerSession: string;
let privateMemory: string, personalMemory: string;
const context = (userId?: string, roles = ['READER'], extra = {}): Context =>
  ({ db, userId, roles, ...extra }) as Context;
async function execute(query: string, ctx: Context) {
  const r = await server.executeOperation({ query }, { contextValue: ctx });
  if (r.body.kind !== 'single') throw new Error('incremental response');
  expect(r.body.singleResult.errors).toBeUndefined();
  return r.body.singleResult.data as any;
}
beforeEach(async () => {
  await cleanDb(db);
  const users = await Promise.all(
    ['owner', 'member', 'admin', 'platform'].map((handle) =>
      db.user.create({
        data: {
          id: generateId(),
          handle: 'sp-' + handle,
          roles: handle === 'platform' ? ['ADMIN'] : ['READER'],
        },
      }),
    ),
  );
  [owner, member, admin, platform] = users.map((u) => u.id);
  org = (
    await db.organization.create({
      data: { id: generateId(), urn: 'sp-org', name: 'Privacy org' },
    })
  ).id;
  await db.orgMember.createMany({
    data: [
      { organizationId: org, userId: owner, role: 'READER' },
      { organizationId: org, userId: member, role: 'READER' },
      { organizationId: org, userId: admin, role: 'ADMIN' },
    ],
  });
  app = (
    await db.app.create({
      data: {
        id: generateId(),
        organizationId: org,
        urn: 'sp-org:team',
        name: 'Team',
      },
    })
  ).id;
  const memories = await Promise.all(
    ['private', 'personal'].map((cls) =>
      db.memory.create({
        data: {
          id: generateId(),
          organizationId: org,
          userId: owner,
          urn: 'sp-org:' + cls,
          name: cls,
          class: cls as 'private' | 'personal',
        },
      }),
    ),
  );
  [privateMemory, personalMemory] = memories.map((m) => m.id);
  const sessions = await Promise.all(
    [privateMemory, personalMemory, null].map((memoryId, i) =>
      db.session.create({
        data: {
          id: generateId(),
          appId: app,
          userId: owner,
          memoryId,
          type: i === 2 ? 'DEVELOPER' : 'CHATBOT',
          summary: 'summary-' + i,
          startedAt: new Date(Date.now() + i * 1000),
        },
      }),
    ),
  );
  [privateSession, personalSession, workerSession] = sessions.map((s) => s.id);
  await db.usageEvent.createMany({
    data: [
      {
        id: generateId(),
        type: 'action-run',
        sessionId: privateSession,
        memoryId: privateMemory,
        nodeLoc: 'owner-private',
      },
      {
        id: generateId(),
        type: 'action-run',
        sessionId: workerSession,
        memoryId: privateMemory,
        nodeLoc: 'strict-event',
      },
      {
        id: generateId(),
        type: 'session-summary',
        sessionId: workerSession,
        nodeLoc: 'unbound-event',
      },
    ],
  });
});
describe('#1645 session privacy', () => {
  it('allows a pure App key only its bound conversation, not a sibling or a hybrid principal', async () => {
    const ctx = context(undefined, [], {
      appId: app,
      sessionId: privateSession,
    });
    const out = await execute(
      `{sessions{id} own:session(id:"${privateSession}"){id} sibling:session(id:"${personalSession}"){id}}`,
      ctx,
    );
    expect(out.own.id).toBe(privateSession);
    expect(out.sibling).toBeNull();
    expect(out.sessions.map((s: any) => s.id).sort()).toEqual(
      [privateSession, workerSession].sort(),
    );
    const hybrid = await execute(
      `{session(id:"${privateSession}"){id}}`,
      context(member, [], { appId: app, sessionId: privateSession }),
    );
    expect(hybrid.session).toBeNull();
    const foreignApp = await execute(
      `{session(id:"${privateSession}"){id}}`,
      context(undefined, [], {
        appId: 'another-app',
        sessionId: privateSession,
      }),
    );
    expect(foreignApp.session).toBeNull();
  });

  it('lets the bound App read licensed conversation events, and fails closed after subscription revocation', async () => {
    const agent = await db.agent.create({
      data: {
        id: generateId(),
        organizationId: org,
        urn: 'sp-org:agent',
        name: 'Agent',
      },
    });
    await db.appAgent.create({ data: { appId: app, agentId: agent.id } });
    await db.agentSubscription.create({
      data: { userId: owner, agentId: agent.id, activatedAt: new Date() },
    });
    await db.memory.update({
      where: { id: privateMemory },
      data: { appId: app, userMemoryOfAgentId: agent.id },
    });
    await db.session.update({
      where: { id: privateSession },
      data: { agentId: agent.id },
    });
    const query = `{session(id:"${privateSession}"){events{nodeLoc}} other:session(id:"${workerSession}"){events{nodeLoc}}}`;
    const out = await execute(
      query,
      context(undefined, [], { appId: app, sessionId: privateSession }),
    );
    expect(out.session.events).toEqual([{ nodeLoc: 'owner-private' }]);
    expect(out.other.events).toEqual([{ nodeLoc: 'unbound-event' }]);
    await db.agentSubscription.update({
      where: { userId_agentId: { userId: owner, agentId: agent.id } },
      data: { revokedAt: new Date() },
    });
    const revoked = await execute(
      query,
      context(undefined, [], { appId: app, sessionId: privateSession }),
    );
    expect(revoked.session.events).toEqual([]);
  });

  it('preserves knowledge-bound sessions and computes the events memory set once per request', async () => {
    const knowledge = await db.memory.create({
      data: {
        id: generateId(),
        organizationId: org,
        urn: 'sp-org:knowledge',
        name: 'Knowledge',
        class: 'knowledge',
      },
    });
    await db.session.update({
      where: { id: workerSession },
      data: { memoryId: knowledge.id },
    });
    const findMany = vi.spyOn(db.memory, 'findMany');
    try {
      const out = await execute(`{sessions{ id events{id} }}`, context(owner));
      expect(out.sessions.map((s: any) => s.id)).toContain(workerSession);
      // One strict-owner memory query despite three nested events resolutions.
      const eventFilters = findMany.mock.calls.filter(([args]) => {
        const first = (args?.where as any)?.AND?.[0];
        return first?.OR?.[0]?.OR?.[0]?.class?.notIn?.includes('private');
      });
      expect(eventFilters).toHaveLength(1);
    } finally {
      findMany.mockRestore();
    }
  });

  it('does not expose user-owned App sessions through impersonation or an unauthenticated audience', async () => {
    const personalApp = await db.app.create({
      data: {
        id: generateId(),
        ownerUserId: owner,
        name: 'Personal App',
        urn: 'sp-owner:app',
      },
    });
    const session = await db.session.create({
      data: { id: generateId(), appId: personalApp.id },
    });
    const query = `{session(id:"${session.id}"){id} sessions{id}}`;
    const mine = await execute(query, context(owner));
    expect(mine.session.id).toBe(session.id);
    expect(mine.sessions.map((s: any) => s.id)).toContain(session.id);
    for (const ctx of [
      context(owner, [], { impersonation: { orgId: org } }),
      context(),
    ]) {
      const out = await execute(query, ctx);
      expect(out.session).toBeNull();
      expect(out.sessions.map((s: any) => s.id)).not.toContain(session.id);
    }
  });

  it('independently gates the sibling top-level usageEvents query', async () => {
    for (const ctx of [
      context(member),
      context(admin),
      context(platform, ['ADMIN']),
    ]) {
      const out = await execute('{usageEvents{nodeLoc}}', ctx);
      expect(out.usageEvents.map((e: any) => e.nodeLoc)).not.toContain(
        'owner-private',
      );
      expect(out.usageEvents.map((e: any) => e.nodeLoc)).not.toContain(
        'strict-event',
      );
    }
    const out = await execute('{usageEvents{nodeLoc}}', context(owner));
    expect(out.usageEvents.map((e: any) => e.nodeLoc)).toContain(
      'owner-private',
    );
  });
  it('denies org/member/admin/App-key/impersonation strict-session reads before paging; preserves unbound sessions', async () => {
    const callers = [
      context(member),
      context(admin),
      context(platform, ['ADMIN']),
      context(undefined, [], { appId: app }),
      context(owner, [], { impersonation: { orgId: org } }),
    ];
    for (const ctx of callers) {
      const out = await execute(
        `{sessions(limit:1){id summary} private:session(id:"${privateSession}"){id summary events{id}} personal:session(id:"${personalSession}"){id}}`,
        ctx,
      );
      expect(out.private).toBeNull();
      expect(out.personal).toBeNull();
      expect(out.sessions).toEqual([
        { id: workerSession, summary: 'summary-2' },
      ]);
      const offset = await execute('{sessions(limit:1,offset:1){id}}', ctx);
      expect(offset.sessions).toEqual([]);
    }
  });
  it('lets the owner read bound sessions and their events', async () => {
    const out = await execute(
      `{session(id:"${privateSession}"){id summary events{nodeLoc}} sessions{ id }}`,
      context(owner),
    );
    expect(out.session).toMatchObject({
      id: privateSession,
      summary: 'summary-0',
      events: [{ nodeLoc: 'owner-private' }],
    });
    expect(out.sessions.map((s: any) => s.id).sort()).toEqual(
      [privateSession, personalSession, workerSession].sort(),
    );
  });
  it('filters memory-scoped events of a readable unbound session, including eager events', async () => {
    for (const ctx of [
      context(member),
      context(admin),
      context(platform, ['ADMIN']),
    ]) {
      const out = await execute(
        `{session(id:"${workerSession}"){events{nodeLoc}}}`,
        ctx,
      );
      expect(out.session.events).toEqual([{ nodeLoc: 'unbound-event' }]);
    }
    const out = await execute(
      `{session(id:"${workerSession}"){events{nodeLoc}}}`,
      context(owner),
    );
    expect(out.session.events.map((e: any) => e.nodeLoc).sort()).toEqual([
      'strict-event',
      'unbound-event',
    ]);
  });
});
