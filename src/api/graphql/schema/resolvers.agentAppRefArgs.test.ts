/**
 * #789 / cor:api:140 — entity-identifying arguments on the agent/app WRITE
 * surface accept a PK **or** a fully-qualified URN, and are named `<entity>Ref`.
 *
 * Bucket 1 (the real blocker) was `updateAgent` / `deleteAgent`: both did a
 * PK-only `findUniqueOrThrow`, so a URN-holding caller had to pre-resolve. The
 * rest of the surface already resolved refs but advertised a PK-only name —
 * hiding the capability and inviting a future PK-only reimplementation, which
 * is exactly the #542 drift class.
 *
 * The auth caveat from #554 is the other half: widening an arg to accept a URN
 * broadens the *reachable* set, so the resource-scoped write gate must still
 * run on the RESOLVED entity. Resolution is not authorization.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { emitEntityUrnV2 } from '../../../lib/urnEmit.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;

let org: { id: string; urn: string };
let admin: { id: string };
let outsider: { id: string };
let agent: { id: string; urn: string };
let memory: { id: string; urn: string };

const adminCtx = (): Context => ({ db, userId: admin.id, roles: ['ADMIN'] });
const outsiderCtx = (): Context => ({ db, userId: outsider.id, roles: ['READER'] });

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({
    data: { id: generateId(), name: 'refargs', urn: `refargs-${generateId()}` },
  });
  admin = await db.user.create({ data: { id: generateId(), githubId: 53101, githubUsername: 'ra-admin' } });
  outsider = await db.user.create({ data: { id: generateId(), githubId: 53102, githubUsername: 'ra-outsider' } });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  agent = await db.agent.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:helper`,
      name: 'Helper', visibility: 'ORGANIZATION',
    },
  });
  memory = await db.memory.create({
    data: {
      id: generateId(), organizationId: org.id, urn: `${org.urn}:knowledge`,
      name: 'Knowledge', class: 'knowledge', visibility: 'ORGANIZATION',
    },
  });
});

/** The emitted, fully-qualified form a URN-holding client would actually send. */
const agentUrn = () => emitEntityUrnV2('agent', agent.urn);

describe('Bucket 1 — updateAgent / deleteAgent were PK-ONLY (#789)', () => {
  it('updateAgent accepts a fully-qualified URN', async () => {
    // Before #789 this threw: the resolver did findUniqueOrThrow({ id: ref }).
    const updated = await M.updateAgent({}, { ref: agentUrn(), description: 'via urn' }, adminCtx());
    expect(updated.id).toBe(agent.id);
    expect(updated.description).toBe('via urn');
  });

  it('updateAgent still accepts a bare PK', async () => {
    const updated = await M.updateAgent({}, { ref: agent.id, description: 'via pk' }, adminCtx());
    expect(updated.description).toBe('via pk');
  });

  it('deleteAgent accepts a fully-qualified URN', async () => {
    expect(await M.deleteAgent({}, { ref: agentUrn() }, adminCtx())).toBe(true);
    expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).deletedAt).not.toBeNull();
  });

  it('deleteAgent still accepts a bare PK', async () => {
    const second = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:second`, name: 'Second' },
    });
    expect(await M.deleteAgent({}, { ref: second.id }, adminCtx())).toBe(true);
  });
});

describe('#554 — widening to a URN does NOT widen authorization (#789)', () => {
  it('updateAgent by URN still requires the org write gate', async () => {
    await expect(
      M.updateAgent({}, { ref: agentUrn(), description: 'nope' }, outsiderCtx()),
    ).rejects.toThrow(/Forbidden/i);
    // Unchanged on disk.
    expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).description).toBeNull();
  });

  it('deleteAgent by URN still requires the org write gate', async () => {
    await expect(M.deleteAgent({}, { ref: agentUrn() }, outsiderCtx())).rejects.toThrow(/Forbidden/i);
    expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).deletedAt).toBeNull();
  });

  it('the PK path is gated identically — the ref shape changes nothing', async () => {
    await expect(
      M.updateAgent({}, { ref: agent.id, description: 'nope' }, outsiderCtx()),
    ).rejects.toThrow(/Forbidden/i);
  });
});

describe('Bucket 2 — the memory-link trio takes refs by name now (#789)', () => {
  // These ALREADY resolved via resolveAgentRef/resolveMemoryRef — the issue
  // filed them as Bucket 1 (PK-only), which was wrong. What changed is the
  // NAME, so the capability stops being hidden.
  it('addMemoryToAgent accepts URNs for both entities', async () => {
    const result = await M.addMemoryToAgent(
      {},
      { agentRef: agentUrn(), memoryRef: emitEntityUrnV2('mem', memory.urn), role: 'read' },
      adminCtx(),
    );
    expect(result.id).toBe(agent.id);
    const link = await db.agentMemoryItem.findUniqueOrThrow({
      where: { agentId_memoryId: { agentId: agent.id, memoryId: memory.id } },
    });
    expect(link.role).toBe('read');
  });

  it('updateAgentMemoryRole and removeMemoryFromAgent round-trip by URN', async () => {
    const refs = { agentRef: agentUrn(), memoryRef: emitEntityUrnV2('mem', memory.urn) };
    await M.addMemoryToAgent({}, { ...refs, role: 'read' }, adminCtx());
    await M.updateAgentMemoryRole({}, { ...refs, role: 'read-write' }, adminCtx());
    expect(
      (await db.agentMemoryItem.findUniqueOrThrow({
        where: { agentId_memoryId: { agentId: agent.id, memoryId: memory.id } },
      })).role,
    ).toBe('read-write');
    await M.removeMemoryFromAgent({}, refs, adminCtx());
    expect(
      await db.agentMemoryItem.findUnique({
        where: { agentId_memoryId: { agentId: agent.id, memoryId: memory.id } },
      }),
    ).toBeNull();
  });
});

describe('Bucket 2 — app write surface takes refs by name (#789)', () => {
  it('createApp accepts orgRef + agentRef as URNs, and the App round-trips by ref', async () => {
    const app = await M.createApp(
      {},
      { orgRef: emitEntityUrnV2('org', org.urn), agentRef: agentUrn(), name: 'Ref App' },
      adminCtx(),
    );
    expect(app.organizationId).toBe(org.id);

    const appUrn = emitEntityUrnV2('app', app.urn);
    const updated = await M.updateApp({}, { ref: appUrn, description: 'via urn' }, adminCtx());
    expect(updated.description).toBe('via urn');

    const key = await M.createAppKey({}, { appRef: appUrn, label: 'k' }, adminCtx());
    expect(key.rawKey).toBeTruthy();

    expect(await M.deleteApp({}, { ref: appUrn }, adminCtx())).toBe(true);
  });

  it('installAgentIntoApp / uninstallAgentFromApp take appRef + agentRef', async () => {
    const app = await M.createApp(
      {},
      { orgRef: org.id, agentRef: agent.id, name: 'Install App' },
      adminCtx(),
    );
    const second = await db.agent.create({
      data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:second`, name: 'Second' },
    });
    const installed = await M.installAgentIntoApp(
      {},
      { appRef: emitEntityUrnV2('app', app.urn), agentRef: emitEntityUrnV2('agent', second.urn) },
      adminCtx(),
    );
    expect(installed.appAgent.agentId).toBe(second.id);

    await M.uninstallAgentFromApp({}, { appRef: app.id, agentRef: second.id }, adminCtx());
    expect(await db.appAgent.findFirst({ where: { appId: app.id, agentId: second.id } })).toBeNull();
  });
});
