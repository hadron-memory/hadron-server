/**
 * #574 — create/rename resolvers must slugify the display name into a valid URN
 * atom, never persist it verbatim. Regression cover for the `holger-pers:Flow Lab`
 * class of malformed URN (spaces + uppercase) seen in prod.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

let org: { id: string };
let ctx: Context;

beforeEach(async () => {
  await cleanDb(db);
  const user = await db.user.create({
    data: { githubId: 5740, githubUsername: 'slug-admin', roles: ['ADMIN'] },
  });
  org = await db.organization.create({
    data: { id: generateId(), name: 'slug-org', urn: 'slug-org' },
  });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.id, role: 'ADMIN' } });
  ctx = { db, roles: ['ADMIN'], userId: user.id };
});

describe('#574 — display name → slug at create', () => {
  it('createMemory slugifies a spacey, uppercase name', async () => {
    const mem = await resolvers.Mutation.createMemory(
      {}, { orgId: org.id, name: 'Flow Lab Notes' }, ctx,
    );
    expect(mem.urn).toBe('slug-org:flow-lab-notes');
    expect(mem.urn).not.toMatch(/[A-Z ]/);
  });

  it('createAgent slugifies the name, and its system memory inherits the clean slug', async () => {
    const agent = await resolvers.Mutation.createAgent(
      {}, { orgId: org.id, name: 'Flow Lab' }, ctx,
    );
    expect(agent.urn).toBe('slug-org:flow-lab');
    const sysMem = await db.memory.findUniqueOrThrow({ where: { id: agent.systemMemoryId! } });
    // System memory URN derives from the agent URN → also clean (was `Flow Lab-system`).
    expect(sysMem.urn).toBe('slug-org:flow-lab-system');
  });

  it('createApp still slugifies (shared helper, dots now preserved)', async () => {
    const app = await resolvers.Mutation.createApp(
      {}, { orgId: org.id, name: 'My Cool App', agentId: (await resolvers.Mutation.createAgent(
        {}, { orgId: org.id, name: 'helper agent' }, ctx,
      )).id }, ctx,
    );
    expect(app.urn).toBe('slug-org:my-cool-app');
  });
});

describe('#574 — display name → slug at rename', () => {
  it('updateMemory slugifies an explicit rename slug', async () => {
    const mem = await resolvers.Mutation.createMemory({}, { orgId: org.id, name: 'start' }, ctx);
    const renamed = await resolvers.Mutation.updateMemory(
      {}, { id: mem.id, urn: 'New Slug Value' }, ctx,
    );
    expect(renamed.urn).toBe('slug-org:new-slug-value');
  });

  it('updateAgent slugifies an explicit rename slug', async () => {
    const agent = await resolvers.Mutation.createAgent({}, { orgId: org.id, name: 'start-agent' }, ctx);
    const renamed = await resolvers.Mutation.updateAgent(
      {}, { id: agent.id, urn: 'Renamed Agent' }, ctx,
    );
    expect(renamed.urn).toBe('slug-org:renamed-agent');
  });
});
