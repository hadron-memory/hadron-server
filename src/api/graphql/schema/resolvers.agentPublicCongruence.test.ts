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
    await M.addMemoryToAgent({}, { agentRef: agent.id, memoryRef: orgMem.id }, ctx()); // ok: agent still ORGANIZATION
    await expect(M.updateAgent({}, { ref: agent.id, visibility: 'PUBLIC' }, ctx())).rejects.toThrow(/non-public|PUBLIC/i);
    expect((await setVisibility(agent.id))?.visibility).toBe('ORGANIZATION'); // unchanged
  });

  it('ignores a stored link whose role grants no read when publishing the Agent', async () => {
    await db.agentMemoryItem.create({
      data: { id: generateId(), agentId: agent.id, memoryId: orgMem.id, role: 'bogus' },
    });
    expect((await M.updateAgent({}, { ref: agent.id, visibility: 'PUBLIC' }, ctx())).visibility).toBe('PUBLIC');
  });

  it('allows when there are no links, or all linked knowledge is PUBLIC', async () => {
    // no links → congruent
    expect((await M.updateAgent({}, { ref: agent.id, visibility: 'PUBLIC' }, ctx())).visibility).toBe('PUBLIC');
    // back to ORGANIZATION, link a PUBLIC memory, then PUBLIC again → still ok
    await M.updateAgent({}, { ref: agent.id, visibility: 'ORGANIZATION' }, ctx());
    await M.addMemoryToAgent({}, { agentRef: agent.id, memoryRef: pubMem.id }, ctx());
    expect((await M.updateAgent({}, { ref: agent.id, visibility: 'PUBLIC' }, ctx())).visibility).toBe('PUBLIC');
  });

  it('a per-user personal memory linked to the agent does not block PUBLIC', async () => {
    const personal = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:mine`, name: 'mine', class: 'personal', userId: admin.id },
    });
    // The LINK is now built directly rather than through addMemoryToAgent,
    // which refuses a strict-owner class as of #1101 (an attach is a grant to
    // an audience, and personal/private have exactly one legitimate reader).
    //
    // The property under test is UNCHANGED and still worth pinning: the covered
    // set excludes personal/private, so such a link does not block PUBLIC. That
    // arm of `cor:acl:080:03` is now reachable only by rows attached BEFORE the
    // refusal existed — which is precisely why it must keep working, and why
    // this test builds the row the way those rows exist rather than deleting
    // the case. See #1101 for the open question of whether the spec's wording
    // should say "legacy" here.
    await db.agentMemoryItem.create({
      data: { id: generateId(), agentId: agent.id, memoryId: personal.id, role: 'read' },
    });
    expect((await M.updateAgent({}, { ref: agent.id, visibility: 'PUBLIC' }, ctx())).visibility).toBe('PUBLIC');
  });

  it('a legacy per-user holding is outside the PUBLIC covered set even when its column is non-public', async () => {
    const holding = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:covered-holding`,
        name: 'Covered holding', class: 'knowledge', visibility: 'ORGANIZATION',
        userMemoryOfAgentId: agent.id, createdBy: admin.id,
      },
    });
    await db.agentMemoryItem.create({ data: { agentId: agent.id, memoryId: holding.id, role: 'read-write' } });
    expect((await M.updateAgent({}, { ref: agent.id, visibility: 'PUBLIC' }, ctx())).visibility).toBe('PUBLIC');
  });
});

describe('addMemoryToAgent onto a PUBLIC agent', () => {
  beforeEach(async () => {
    await M.updateAgent({}, { ref: agent.id, visibility: 'PUBLIC' }, ctx()); // no links yet → ok
  });
  it('rejects linking a non-PUBLIC memory', async () => {
    await expect(M.addMemoryToAgent({}, { agentRef: agent.id, memoryRef: orgMem.id }, ctx())).rejects.toThrow(/non-public|PUBLIC/i);
  });
  it('allows linking a PUBLIC memory', async () => {
    await expect(M.addMemoryToAgent({}, { agentRef: agent.id, memoryRef: pubMem.id }, ctx())).resolves.toBeTruthy();
  });
});

describe('covered-set exclusions — app-scoped memories (#610 review / cor:acl:080:03)', () => {
  it('app-scoped knowledge never counts: it neither blocks PUBLIC nor is blocked when linked/changed', async () => {
    // App-scoped knowledge is App-internal even at PUBLIC (#653), so it is
    // excluded from the covered set — the createMemoryInApp path can't leave a
    // PUBLIC agent "linked to non-public data" in a way that matters.
    const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:app`, name: 'app' } });
    // The current attach gate admits App-scoped knowledge only read-only to
    // an Agent installed in that same App. Keep this a supported-path control.
    await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });
    const appMem = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:app-know`, name: 'app-know', class: 'knowledge', visibility: 'ORGANIZATION', appId: app.id },
    });
    // link app-scoped knowledge, then set the agent PUBLIC → allowed (excluded)
    await M.addMemoryToAgent({}, { agentRef: agent.id, memoryRef: appMem.id }, ctx());
    expect((await M.updateAgent({}, { ref: agent.id, visibility: 'PUBLIC' }, ctx())).visibility).toBe('PUBLIC');
    // linking ANOTHER app-scoped memory to the now-PUBLIC agent → allowed
    const appMem2 = await db.memory.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:app-know2`, name: 'app-know2', class: 'knowledge', visibility: 'ORGANIZATION', appId: app.id },
    });
    await expect(M.addMemoryToAgent({}, { agentRef: agent.id, memoryRef: appMem2.id }, ctx())).resolves.toBeTruthy();
    // changing the app-scoped memory's visibility while linked to the PUBLIC agent → not blocked
    expect((await M.updateMemory({}, { id: appMem.id, visibility: 'ORGANIZATION' }, ctx())).visibility).toBe('ORGANIZATION');
  });
});

describe('updateMemory un-PUBLIC-ing knowledge of a PUBLIC agent', () => {
  it('is rejected while the agent stays PUBLIC', async () => {
    await M.addMemoryToAgent({}, { agentRef: agent.id, memoryRef: pubMem.id }, ctx());
    await M.updateAgent({}, { ref: agent.id, visibility: 'PUBLIC' }, ctx());
    await expect(M.updateMemory({}, { id: pubMem.id, visibility: 'ORGANIZATION' }, ctx())).rejects.toThrow(/non-public|PUBLIC/i);
    // once the agent is no longer PUBLIC, the memory can change freely
    await M.updateAgent({}, { ref: agent.id, visibility: 'ORGANIZATION' }, ctx());
    expect((await M.updateMemory({}, { id: pubMem.id, visibility: 'ORGANIZATION' }, ctx())).visibility).toBe('ORGANIZATION');
  });

  it('ignores a stored link whose role grants no read when narrowing the Memory', async () => {
    await M.updateAgent({}, { ref: agent.id, visibility: 'PUBLIC' }, ctx());
    await db.agentMemoryItem.create({
      data: { id: generateId(), agentId: agent.id, memoryId: pubMem.id, role: 'bogus' },
    });
    expect((await M.updateMemory({}, { id: pubMem.id, visibility: 'ORGANIZATION' }, ctx())).visibility)
      .toBe('ORGANIZATION');
  });
});

/**
 * #759 — the covered-set exclusions above are exactly what makes this
 * reachable: a PUBLIC agent may legally link a NON-public personal/private or
 * app-scoped memory, and `agent(ref:)` / `publicAgents` hand `memoryItems[].memory`
 * to anonymous callers. The Memory type gates only userId/shares/members, so
 * the object scalars (name / shortDescription / description / data) leaked.
 */
describe('Agent.memoryItems — non-public linked memories are gated (#759)', () => {
  const A = resolvers.Agent as any;
  const anon = (): Context => ({ db, roles: ['READER'] });
  const outsider = (id: string): Context => ({ db, userId: id, roles: ['READER'] });

  let pubAgent: { id: string };
  let appMem: { id: string };
  let stranger: { id: string };

  beforeEach(async () => {
    pubAgent = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:pub-agent`, name: 'pub-agent', visibility: 'PUBLIC' },
    });
    // An app-scoped memory: excluded from the covered set, so it may be linked
    // to a PUBLIC agent while itself being non-public (#653).
    const app = await db.app.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:app-${generateId()}`, name: 'App' },
    });
    appMem = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:app-mem`,
        name: 'App Internal', class: 'knowledge', visibility: 'ORGANIZATION',
        appId: app.id, shortDescription: 'INTERNAL-ONLY', description: 'SECRET-DESCRIPTION',
      },
    });
    await db.agentMemoryItem.create({ data: { agentId: pubAgent.id, memoryId: appMem.id } });
    await db.agentMemoryItem.create({ data: { agentId: pubAgent.id, memoryId: pubMem.id } });
    stranger = await db.user.create({
      data: { id: generateId(), githubId: 56002, githubUsername: 'cong-stranger', roles: [] },
    });
  });

  /** The eager shape AGENT_INCLUDE produces, which the resolver receives. */
  const eagerAgent = () =>
    db.agent.findUniqueOrThrow({
      where: { id: pubAgent.id },
      include: { memoryItems: { where: { deletedAt: null }, include: { memory: true } } },
    });

  it('an ANONYMOUS caller sees only the PUBLIC memory', async () => {
    const items = await A.memoryItems(await eagerAgent(), {}, anon());
    expect(items.map((i: { memoryId: string }) => i.memoryId)).toEqual([pubMem.id]);
  });

  it('the app-scoped memory’s scalars are unreachable to an outsider', async () => {
    const items = await A.memoryItems(await eagerAgent(), {}, outsider(stranger.id));
    const descriptions = items.map((i: { memory?: { description?: string | null } }) => i.memory?.description);
    expect(descriptions).not.toContain('SECRET-DESCRIPTION');
    expect(items.map((i: { memoryId: string }) => i.memoryId)).toEqual([pubMem.id]);
  });

  it('does not publish legacy per-user holding metadata through a PUBLIC Agent', async () => {
    const holding = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:legacy-holding`,
        name: 'Legacy Holding', class: 'knowledge', visibility: 'PUBLIC',
        userMemoryOfAgentId: pubAgent.id, createdBy: admin.id,
      },
    });
    await db.agentMemoryItem.create({ data: { agentId: pubAgent.id, memoryId: holding.id } });
    const anonymous = await A.memoryItems(await eagerAgent(), {}, anon());
    const outside = await A.memoryItems(await eagerAgent(), {}, outsider(stranger.id));
    const creator = await A.memoryItems(await eagerAgent(), {}, outsider(admin.id));
    expect(anonymous.map((i: { memoryId: string }) => i.memoryId)).not.toContain(holding.id);
    expect(outside.map((i: { memoryId: string }) => i.memoryId)).not.toContain(holding.id);
    expect(creator.map((i: { memoryId: string }) => i.memoryId)).toContain(holding.id);
  });

  it('does not admit a null creator to a caller-less App context', async () => {
    const holding = await db.memory.create({
      data: {
        id: generateId(), organizationId: org.id, urn: `${org.urn}:null-creator-holding`,
        name: 'Null creator holding', class: 'knowledge', visibility: 'PUBLIC',
        userMemoryOfAgentId: pubAgent.id, createdBy: null,
      },
    });
    await db.agentMemoryItem.create({ data: { agentId: pubAgent.id, memoryId: holding.id } });
    const items = await A.memoryItems(await eagerAgent(), {}, { db, roles: [], userId: null } as unknown as Context);
    expect(items.map((i: { memoryId: string }) => i.memoryId)).not.toContain(holding.id);
  });

  // PR #846 review (Copilot): this said "org member" but used ctx() — a
  // platform ADMIN, whose bypass masked the very regression the reviewers
  // found. An ORDINARY org member must still see the app-scoped memory, since
  // Query.memory grants them the record read; the node-content gate would have
  // dropped it.
  it('an ordinary ORG MEMBER still sees both (record-level gate, not node-content)', async () => {
    const orgMember = await db.user.create({
      data: { id: generateId(), githubId: 56003, githubUsername: 'cong-member', roles: [] },
    });
    await db.orgMember.create({
      data: { id: generateId(), organizationId: org.id, userId: orgMember.id, role: 'READER' },
    });
    const items = await A.memoryItems(await eagerAgent(), {}, outsider(orgMember.id));
    expect(items.map((i: { memoryId: string }) => i.memoryId).sort())
      .toEqual([appMem.id, pubMem.id].sort());
  });

  it('a REVOKED org member does NOT see the app-scoped memory', async () => {
    const exMember = await db.user.create({
      data: { id: generateId(), githubId: 56004, githubUsername: 'cong-ex', roles: [] },
    });
    await db.orgMember.create({
      data: { id: generateId(), organizationId: org.id, userId: exMember.id, role: 'READER', deletedAt: new Date() },
    });
    const items = await A.memoryItems(await eagerAgent(), {}, outsider(exMember.id));
    expect(items.map((i: { memoryId: string }) => i.memoryId)).toEqual([pubMem.id]);
  });

  it('a platform ADMIN sees both', async () => {
    const items = await A.memoryItems(await eagerAgent(), {}, ctx());
    expect(items.map((i: { memoryId: string }) => i.memoryId).sort())
      .toEqual([appMem.id, pubMem.id].sort());
  });

  it('falls back to a query when memoryItems lacks its memory relation', async () => {
    // The eager payload exists but was selected without `memory` — every item
    // would look unreadable and the list would silently empty out.
    const bare = await db.agent.findUniqueOrThrow({
      where: { id: pubAgent.id },
      include: { memoryItems: { where: { deletedAt: null } } },
    });
    const items = await A.memoryItems(bare, {}, anon());
    expect(items.map((i: { memoryId: string }) => i.memoryId)).toEqual([pubMem.id]);
  });

  it('falls back to a query when memoryItems was not eager-loaded', async () => {
    const items = await A.memoryItems({ id: pubAgent.id }, {}, anon());
    expect(items.map((i: { memoryId: string }) => i.memoryId)).toEqual([pubMem.id]);
  });
});
