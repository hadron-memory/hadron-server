/**
 * spec 047 — handle rename propagates to every user-owned entity URN.
 *
 * When a user changes their handle via updateMyProfile, their user-owned App /
 * Agent / Memory URNs (namespaced `@<handle>:<slug>`, including a user-owned
 * agent's `-system` memory) must move to `@<new>:<slug>` in lockstep. Org-owned
 * entities are untouched. Node URNs (composed on read) self-heal.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

function ctx(over: Partial<Context> = {}): Context {
  return { db, ...over };
}

let userId: string;
let orgId: string;
let publicAgentId: string;

beforeEach(async () => {
  await cleanDb(db);
  const user = await db.user.create({
    data: { id: generateId(), name: 'Renamer', handle: 'old-handle', roles: ['READER'] },
  });
  userId = user.id;
  // A PUBLIC org-owned agent the user can install into a personal App.
  const org = await db.organization.create({
    data: { id: generateId(), name: 'pub-org', urn: `pub-org-${generateId()}` },
  });
  orgId = org.id;
  const pub = await db.agent.create({
    data: { id: generateId(), name: 'Public Agent', urn: `${org.urn}:public-agent`, organizationId: org.id, visibility: 'PUBLIC' },
  });
  publicAgentId = pub.id;
});

describe('updateMyProfile — handle rename URN propagation', () => {
  it('re-namespaces user-owned Agent + its system memory, and App', async () => {
    const c = ctx({ userId, roles: ['READER'] });
    const agent = await resolvers.Mutation.createAgent({}, { name: 'My Agent' }, c);
    const app = await resolvers.Mutation.createApp({}, { agentId: publicAgentId, name: 'My App' }, c);

    expect(agent.urn).toBe('@old-handle:my-agent');
    expect(app.urn).toBe('@old-handle:my-app');

    await resolvers.Mutation.updateMyProfile({}, { handle: 'new-handle' }, c);

    const renamedAgent = await db.agent.findUniqueOrThrow({ where: { id: agent.id } });
    const renamedSys = await db.memory.findUniqueOrThrow({ where: { id: agent.systemMemoryId! } });
    const renamedApp = await db.app.findUniqueOrThrow({ where: { id: app.id } });
    expect(renamedAgent.urn).toBe('@new-handle:my-agent');
    expect(renamedSys.urn).toBe('@new-handle:my-agent-system');
    expect(renamedApp.urn).toBe('@new-handle:my-app');
  });

  it('leaves ORG-owned entities untouched', async () => {
    const c = ctx({ userId, roles: ['READER'] });
    await resolvers.Mutation.createAgent({}, { name: 'My Agent' }, c);
    const pubBefore = await db.agent.findUniqueOrThrow({ where: { id: publicAgentId } });

    await resolvers.Mutation.updateMyProfile({}, { handle: 'new-handle' }, c);

    const pubAfter = await db.agent.findUniqueOrThrow({ where: { id: publicAgentId } });
    expect(pubAfter.urn).toBe(pubBefore.urn); // org agent's URN unchanged
  });

  it('composed node URNs reflect the new handle after rename', async () => {
    const c = ctx({ userId, roles: ['READER'] });
    const agent = await resolvers.Mutation.createAgent({}, { name: 'My Agent' }, c);
    // A node in the user-owned system memory.
    await db.node.create({
      data: { id: generateId(), memoryId: agent.systemMemoryId!, loc: 'intro', name: 'Intro' },
    });

    await resolvers.Mutation.updateMyProfile({}, { handle: 'new-handle' }, c);

    // The node's URN is composed from the (now-renamed) memory URN.
    const node = await resolvers.Query.node(null, { ref: `hrn:node:@new-handle::my-agent-system::intro` }, c);
    expect(node?.loc).toBe('intro');
  });

  it('changing only the name does not rewrite URNs', async () => {
    const c = ctx({ userId, roles: ['READER'] });
    const agent = await resolvers.Mutation.createAgent({}, { name: 'My Agent' }, c);
    await resolvers.Mutation.updateMyProfile({}, { name: 'New Name' }, c);
    const still = await db.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(still.urn).toBe('@old-handle:my-agent');
  });
});
