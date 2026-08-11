/**
 * #928 — team-persona phase 1 (hadron-concept 2026-08-11-agent-personas).
 *
 * A persona — a named AI team member ("Iris") driven by external coding
 * sessions or portal chat — IS an Agent: `personaName` / `personaRole` /
 * `personaPrompt` are pure-metadata columns. `personaName` is unique per
 * owner (org XOR user), case-insensitively, via raw partial indexes; a
 * collision is the typed `PERSONA_NAME_TAKEN` error — the atomic
 * name-allocation primitive callers retry against (D-2026-08-11-006).
 *
 * Session grows coding-provenance fields (`transcriptPath` / `host` /
 * `tool`) and an `agentRef` input (cor:api:140) that resolves to
 * `Session.agentId`, gated by the agent read gate.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
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

const M = resolvers.Mutation as any;

function ctx(userId?: string): Context {
  return { db, userId, roles: ['READER'] };
}

async function expectCode(p: Promise<unknown>, code: string) {
  try {
    await p;
    expect.fail(`expected rejection with extensions.code=${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    expect((e as GraphQLError).extensions?.code).toBe(code);
  }
}

let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let adminA: { id: string };
let adminB: { id: string };
let readerA: { id: string };
let outsider: { id: string };
let userOne: { id: string };
let userTwo: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  orgA = await db.organization.create({
    data: { id: generateId(), name: 'persona-a', urn: `persona-a-${suffix}.com` },
  });
  orgB = await db.organization.create({
    data: { id: generateId(), name: 'persona-b', urn: `persona-b-${suffix}.com` },
  });
  adminA = await db.user.create({
    data: { id: generateId(), githubId: 92801, githubUsername: `persona-admin-a-${suffix}`, roles: ['READER'] },
  });
  adminB = await db.user.create({
    data: { id: generateId(), githubId: 92802, githubUsername: `persona-admin-b-${suffix}`, roles: ['READER'] },
  });
  readerA = await db.user.create({
    data: { id: generateId(), githubId: 92803, githubUsername: `persona-reader-a-${suffix}`, roles: ['READER'] },
  });
  outsider = await db.user.create({
    data: { id: generateId(), githubId: 92804, githubUsername: `persona-outsider-${suffix}`, roles: ['READER'] },
  });
  userOne = await db.user.create({
    data: { id: generateId(), name: 'User One', handle: `persona-user-one-${suffix}`, roles: ['READER'] },
  });
  userTwo = await db.user.create({
    data: { id: generateId(), name: 'User Two', handle: `persona-user-two-${suffix}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: orgA.id, userId: adminA.id, role: 'ADMIN' },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: orgB.id, userId: adminB.id, role: 'ADMIN' },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: orgA.id, userId: readerA.id, role: 'READER' },
  });
});

describe('createAgent — persona columns (#928)', () => {
  it('persists and returns personaName / personaRole / personaPrompt', async () => {
    const agent = await M.createAgent(
      {},
      {
        orgId: orgA.id,
        name: 'Backend Worker',
        personaName: 'Iris',
        personaRole: 'backend-engineer',
        personaPrompt: 'You are Iris, a senior backend engineer.',
      },
      ctx(adminA.id),
    );
    expect(agent.personaName).toBe('Iris');
    expect(agent.personaRole).toBe('backend-engineer');
    expect(agent.personaPrompt).toBe('You are Iris, a senior backend engineer.');
    const row = await db.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(row.personaName).toBe('Iris');
  });

  it('rejects a case-insensitive duplicate personaName in the same org with PERSONA_NAME_TAKEN', async () => {
    await M.createAgent(
      {},
      { orgId: orgA.id, name: 'Backend Worker', personaName: 'Iris' },
      ctx(adminA.id),
    );
    await expectCode(
      M.createAgent(
        {},
        { orgId: orgA.id, name: 'Another Worker', personaName: 'iris' },
        ctx(adminA.id),
      ),
      'PERSONA_NAME_TAKEN',
    );
  });

  it('allows the same personaName in a different org', async () => {
    await M.createAgent(
      {},
      { orgId: orgA.id, name: 'Backend Worker', personaName: 'Iris' },
      ctx(adminA.id),
    );
    const other = await M.createAgent(
      {},
      { orgId: orgB.id, name: 'Backend Worker', personaName: 'Iris' },
      ctx(adminB.id),
    );
    expect(other.personaName).toBe('Iris');
  });

  it('user-owned: uniqueness is per owner — two users may both have Iris, one user may not have her twice', async () => {
    const first = await M.createAgent(
      {},
      { name: 'My Backend Helper', personaName: 'Iris' },
      ctx(userOne.id),
    );
    expect(first.ownerUserId).toBe(userOne.id);
    const second = await M.createAgent(
      {},
      { name: 'My Backend Helper', personaName: 'Iris' },
      ctx(userTwo.id),
    );
    expect(second.ownerUserId).toBe(userTwo.id);
    await expectCode(
      M.createAgent(
        {},
        { name: 'Another Helper', personaName: 'IRIS' },
        ctx(userOne.id),
      ),
      'PERSONA_NAME_TAKEN',
    );
  });
});

describe('updateAgent — persona columns (#928)', () => {
  it('sets, collides, and clears persona fields', async () => {
    const a = await M.createAgent(
      {},
      { orgId: orgA.id, name: 'Worker A', personaName: 'Iris' },
      ctx(adminA.id),
    );
    const b = await M.createAgent(
      {},
      { orgId: orgA.id, name: 'Worker B' },
      ctx(adminA.id),
    );

    const updated = await M.updateAgent(
      {},
      { ref: b.id, personaName: 'Henry', personaRole: 'backend-engineer', personaPrompt: 'You are Henry.' },
      ctx(adminA.id),
    );
    expect(updated.personaName).toBe('Henry');
    expect(updated.personaRole).toBe('backend-engineer');

    // Collision on update maps to the same typed code as on create.
    await expectCode(
      M.updateAgent({}, { ref: b.id, personaName: 'iris' }, ctx(adminA.id)),
      'PERSONA_NAME_TAKEN',
    );

    // Explicit null clears (omitted preserves — exercised implicitly above:
    // the collision attempt did not touch personaRole).
    const cleared = await M.updateAgent(
      {},
      { ref: a.id, personaName: null },
      ctx(adminA.id),
    );
    expect(cleared.personaName).toBeNull();
  });
});

describe('startSession — coding provenance + agentRef (#928)', () => {
  it('persists transcriptPath / host / tool', async () => {
    const s = await M.startSession(
      {},
      {
        input: {
          id: generateId(),
          repo: 'hadron-memory/hadron-cli',
          branch: 'main',
          transcriptPath: '/Users/x/.claude/projects/p/session.jsonl',
          host: 'mbp-holger',
          tool: 'claude-code',
        },
      },
      ctx(readerA.id),
    );
    expect(s.type).toBe('DEVELOPER');
    expect(s.transcriptPath).toBe('/Users/x/.claude/projects/p/session.jsonl');
    expect(s.host).toBe('mbp-holger');
    expect(s.tool).toBe('claude-code');
    expect(s.agentId).toBeNull();
  });

  it('resolves agentRef (URN) to Session.agentId for an org member', async () => {
    const agent = await M.createAgent(
      {},
      { orgId: orgA.id, name: 'Backend Worker', personaName: 'Iris' },
      ctx(adminA.id),
    );
    const s = await M.startSession(
      {},
      { input: { id: generateId(), agentRef: agent.urn, tool: 'claude-code' } },
      ctx(readerA.id),
    );
    expect(s.agentId).toBe(agent.id);
  });

  it('rejects an unknown agentRef with BAD_USER_INPUT', async () => {
    await expectCode(
      M.startSession(
        {},
        { input: { id: generateId(), agentRef: `${orgA.urn}:no-such-agent` } },
        ctx(readerA.id),
      ),
      'BAD_USER_INPUT',
    );
  });

  it('refuses to attribute a session to a non-public agent the caller cannot read', async () => {
    const agent = await M.createAgent(
      {},
      { orgId: orgA.id, name: 'Backend Worker', personaName: 'Iris' },
      ctx(adminA.id),
    );
    await expect(
      M.startSession(
        {},
        { input: { id: generateId(), agentRef: agent.id } },
        ctx(outsider.id),
      ),
    ).rejects.toThrow(/Forbidden/);
  });
});
