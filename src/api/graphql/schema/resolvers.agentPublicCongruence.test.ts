/**
 * cor:acl:080:03 (#610 Phase 2) — the Agent-PUBLIC congruence invariant,
 * enforced write-time on all three sides:
 *   - updateAgent → PUBLIC is rejected if a linked (non-per-user) knowledge
 *     memory is not PUBLIC; allowed when all linked knowledge is PUBLIC / none.
 *   - addMemoryToAgent rejects linking a non-PUBLIC memory to a PUBLIC agent.
 *   - updateMemory rejects un-PUBLIC-ing a memory a PUBLIC agent links.
 * Per-user personal/private memories are excluded; the system memory is
 * class='system' (never PUBLIC-visibility) and governed by its class.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const M = resolvers.Mutation as any;
const ctx = (): Context => ({ db, userId: admin.id, roles: ['ADMIN'] });

let org: { id: string; urn: string };
let admin: { id: string };
let agent: { id: string };
let pubMem: { id: string };
let orgMem: { id: string };

const mkMemory = (visibility: 'PUBLIC' | 'ORGANIZATION', slug: string) =>
  db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:${slug}`, name: slug, class: 'knowledge', visibility },
  });

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'cong', urn: `cong-${Date.now()}` } });
  admin = await db.user.create({ data: { id: generateId(), githubId: 56001, githubUsername: 'cong-admin', roles: [] } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:agent`, name: 'cong-agent', visibility: 'ORGANIZATION' } });
  pubMem = await mkMemory('PUBLIC', 'pub-know');
  orgMem = await mkMemory('ORGANIZATION', 'org-know');
});

const setVisibility = (id: string) => db.agent.findUnique({ where: { id }, select: { visibility: true } });

describe('updateAgent → PUBLIC', () => {
  it('rejects when a linked knowledge memory is not PUBLIC', async () => {
    await M.addMemoryToAgent({}, { agentId: agent.id, memoryId: orgMem.id }, ctx()); // ok: agent still ORGANIZATION
    await expect(M.updateAgent({}, { id: agent.id, visibility: 'PUBLIC' }, ctx())).rejects.toThrow(/non-public|PUBLIC/i);
    expect((await setVisibility(agent.id))?.visibility).toBe('ORGANIZATION'); // unchanged
  });

  it('allows when there are no links, or all linked knowledge is PUBLIC', async () => {
    // no links → congruent
    expect((await M.updateAgent({}, { id: agent.id, visibility: 'PUBLIC' }, ctx())).visibility).toBe('PUBLIC');
    // back to ORGANIZATION, link a PUBLIC memory, then PUBLIC again → still ok
    await M.updateAgent({}, { id: agent.id, visibility: 'ORGANIZATION' }, ctx());
    await M.addMemoryToAgent({}, { agentId: agent.id, memoryId: pubMem.id }, ctx());
    expect((await M.updateAgent({}, { id: agent.id, visibility: 'PUBLIC' }, ctx())).visibility).toBe('PUBLIC');
  });

  it('a per-user personal memory linked to the agent does not block PUBLIC', async () => {
    const personal = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:mine`, name: 'mine', class: 'personal', userId: admin.id },
    });
    await M.addMemoryToAgent({}, { agentId: agent.id, memoryId: personal.id }, ctx());
    expect((await M.updateAgent({}, { id: agent.id, visibility: 'PUBLIC' }, ctx())).visibility).toBe('PUBLIC');
  });
});

describe('addMemoryToAgent onto a PUBLIC agent', () => {
  beforeEach(async () => {
    await M.updateAgent({}, { id: agent.id, visibility: 'PUBLIC' }, ctx()); // no links yet → ok
  });
  it('rejects linking a non-PUBLIC memory', async () => {
    await expect(M.addMemoryToAgent({}, { agentId: agent.id, memoryId: orgMem.id }, ctx())).rejects.toThrow(/non-public|PUBLIC/i);
  });
  it('allows linking a PUBLIC memory', async () => {
    await expect(M.addMemoryToAgent({}, { agentId: agent.id, memoryId: pubMem.id }, ctx())).resolves.toBeTruthy();
  });
});

describe('covered-set exclusions — app-scoped memories (#610 review / cor:acl:080:03)', () => {
  it('app-scoped knowledge never counts: it neither blocks PUBLIC nor is blocked when linked/changed', async () => {
    // App-scoped knowledge is App-internal even at PUBLIC (#653), so it is
    // excluded from the covered set — the createMemoryInApp path can't leave a
    // PUBLIC agent "linked to non-public data" in a way that matters.
    const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:app`, name: 'app' } });
    const appMem = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:app-know`, name: 'app-know', class: 'knowledge', visibility: 'ORGANIZATION', appId: app.id },
    });
    // link app-scoped knowledge, then set the agent PUBLIC → allowed (excluded)
    await M.addMemoryToAgent({}, { agentId: agent.id, memoryId: appMem.id }, ctx());
    expect((await M.updateAgent({}, { id: agent.id, visibility: 'PUBLIC' }, ctx())).visibility).toBe('PUBLIC');
    // linking ANOTHER app-scoped memory to the now-PUBLIC agent → allowed
    const appMem2 = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:app-know2`, name: 'app-know2', class: 'knowledge', visibility: 'ORGANIZATION', appId: app.id },
    });
    await expect(M.addMemoryToAgent({}, { agentId: agent.id, memoryId: appMem2.id }, ctx())).resolves.toBeTruthy();
    // changing the app-scoped memory's visibility while linked to the PUBLIC agent → not blocked
    expect((await M.updateMemory({}, { id: appMem.id, visibility: 'ORGANIZATION' }, ctx())).visibility).toBe('ORGANIZATION');
  });
});

describe('updateMemory un-PUBLIC-ing knowledge of a PUBLIC agent', () => {
  it('is rejected while the agent stays PUBLIC', async () => {
    await M.addMemoryToAgent({}, { agentId: agent.id, memoryId: pubMem.id }, ctx());
    await M.updateAgent({}, { id: agent.id, visibility: 'PUBLIC' }, ctx());
    await expect(M.updateMemory({}, { id: pubMem.id, visibility: 'ORGANIZATION' }, ctx())).rejects.toThrow(/non-public|PUBLIC/i);
    // once the agent is no longer PUBLIC, the memory can change freely
    await M.updateAgent({}, { id: agent.id, visibility: 'ORGANIZATION' }, ctx());
    expect((await M.updateMemory({}, { id: pubMem.id, visibility: 'ORGANIZATION' }, ctx())).visibility).toBe('ORGANIZATION');
  });
});
