import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
/**
 * #928 — persona DRESSING on agents, re-cut by #974 (Worker model,
 * hadron-concept 2026-08-14-agent-persona-scoping).
 *
 * An Agent carries only the reusable persona dressing — `personaRole` (the
 * cast-list role its template answers) and `systemPrompt` (the identity
 * TEMPLATE with `{{name}}`/`{{role}}` placeholders). The NAMED identity
 * ("Iris") is a Worker row (cor:dmo:050:11), so `createAgent`/`updateAgent`
 * accept no `personaName` at all; name permanence lives on Worker rows,
 * which is why the tombstone URN reclaim refuses (`AGENT_URN_TAKEN`) exactly
 * when a casting still references the tombstone (agent FK Restrict).
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
const Q = resolvers.Query as any;

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
let adminA: { id: string };
let readerA: { id: string };
let outsider: { id: string };
let userOne: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  orgA = await db.organization.create({
    data: { id: generateId(), name: 'persona-a', urn: `persona-a-${suffix}.com` },
  });
  adminA = await db.user.create({
    data: { id: generateId(), githubId: 92801, githubUsername: `persona-admin-a-${suffix}`, roles: ['READER'] },
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
  await db.orgMember.create({
    data: { id: generateId(), organizationId: orgA.id, userId: adminA.id, role: 'ADMIN' },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: orgA.id, userId: readerA.id, role: 'READER' },
  });
});

describe('createAgent — prompt template and persona role (#1241)', () => {
  it('persists personaRole/systemPrompt without a named identity on agents', async () => {
    const agent = await M.createAgent(
      {},
      {
        orgId: orgA.id,
        name: 'Backend Worker',
        personaRole: 'backend-engineer',
        systemPrompt: 'You are {{name}}, a senior {{role}}.',
      },
      ctx(adminA.id),
    );
    expect(agent.personaRole).toBe('backend-engineer');
    expect(agent.systemPrompt).toBe('You are {{name}}, a senior {{role}}.');
    // #974: the named identity lives on Worker rows — the Agent row carries
    // no personaName column at all.
    expect(agent.personaName).toBeUndefined();
  });

  it('trims personaRole while preserving systemPrompt text', async () => {
    const blank = await M.createAgent(
      {},
      { orgId: orgA.id, name: 'Blank One', personaRole: ' ', systemPrompt: '' },
      ctx(adminA.id),
    );
    expect(blank.personaRole).toBeNull();
    expect(blank.systemPrompt).toBe('');
    const trimmed = await M.createAgent(
      {},
      { orgId: orgA.id, name: 'Trimmed One', personaRole: '  backend-engineer  ' },
      ctx(adminA.id),
    );
    expect(trimmed.personaRole).toBe('backend-engineer');
  });
});

describe('updateAgent — prompt template and persona role (#1241)', () => {
  it('updates the prompt while normalizing personaRole', async () => {
    const agent = await M.createAgent({}, { orgId: orgA.id, name: 'Worker B' }, ctx(adminA.id));

    const set = await M.updateAgent(
      {},
      { ref: agent.id, personaRole: ' backend-engineer ', systemPrompt: 'You are {{name}}.' },
      ctx(adminA.id),
    );
    expect(set.personaRole).toBe('backend-engineer');
    expect(set.systemPrompt).toBe('You are {{name}}.');

    // Omitted preserves.
    const kept = await M.updateAgent(
      {},
      { ref: agent.id, systemPrompt: 'You are {{name}}, a {{role}}.' },
      ctx(adminA.id),
    );
    expect(kept.personaRole).toBe('backend-engineer');
    expect(kept.systemPrompt).toBe('You are {{name}}, a {{role}}.');

    // Explicit null clears the role; omitted prompt keeps its text.
    const cleared = await M.updateAgent(
      {},
      { ref: agent.id, personaRole: null },
      ctx(adminA.id),
    );
    expect(cleared.personaRole).toBeNull();
    expect(cleared.systemPrompt).toBe('You are {{name}}, a {{role}}.');
  });
});

describe('createAgent — tombstone URN reclaim (#974)', () => {
  it("reclaims a soft-deleted agent's URN by hard-deleting the tombstone", async () => {
    const first = await M.createAgent({}, { orgId: orgA.id, name: 'Recast Agent' }, ctx(adminA.id));
    // The REAL delete path (soft-deletes the agent AND its system memory —
    // the memory tombstone is reclaimed by the same create).
    await M.deleteAgent({}, { ref: first.id }, ctx(adminA.id));
    const second = await M.createAgent({}, { orgId: orgA.id, name: 'Recast Agent' }, ctx(adminA.id));
    expect(second.urn).toBe(first.urn);
    expect(second.id).not.toBe(first.id);
    // The tombstone is gone — reclaim hard-deletes it (name permanence lives
    // on Worker rows, never on agent tombstones).
    expect(await db.agent.findUnique({ where: { id: first.id } })).toBeNull();
  });

  it('refuses AGENT_URN_TAKEN when a Worker casting still references the tombstone', async () => {
    const cast = await M.createAgent({}, { orgId: orgA.id, name: 'Cast Agent' }, ctx(adminA.id));
    const teamApp = await db.app.create({
      data: { id: generateId(), organizationId: orgA.id, name: 'Team App', urn: `${orgA.urn}:team` },
    });
    // The casting (agent FK Restrict): its history keeps the URN reserved.
    await db.worker.create({
      data: { ...WORKER_SIGNATURE_DEFAULTS, appId: teamApp.id, agentId: cast.id, name: 'Iris', slug: 'iris' },
    });
    await M.deleteAgent({}, { ref: cast.id }, ctx(adminA.id));

    await expectCode(
      M.createAgent({}, { orgId: orgA.id, name: 'Cast Agent' }, ctx(adminA.id)),
      'AGENT_URN_TAKEN',
    );
    // The tombstone and its casting both survive the refused reclaim.
    expect(await db.agent.findUnique({ where: { id: cast.id } })).not.toBeNull();
    expect(await db.worker.count({ where: { agentId: cast.id } })).toBe(1);
  });

  it('a live agent at the URN still refuses AGENT_URN_TAKEN', async () => {
    await M.createAgent({}, { orgId: orgA.id, name: 'Live Agent' }, ctx(adminA.id));
    await expectCode(
      M.createAgent({}, { orgId: orgA.id, name: 'Live Agent' }, ctx(adminA.id)),
      'AGENT_URN_TAKEN',
    );
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
      { orgId: orgA.id, name: 'Backend Worker' },
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

  it('treats a whitespace-only agentRef as absent (#929 review)', async () => {
    const s = await M.startSession(
      {},
      { input: { id: generateId(), agentRef: '   ', tool: 'claude-code' } },
      ctx(readerA.id),
    );
    expect(s.agentId).toBeNull();
  });

  it('attributes the session to the calling user and makes it readable by its creator (#929 review P1)', async () => {
    // `outsider` belongs to NO org, so pre-P1 both read gates (app-scoped
    // only) would hide this session from its own creator.
    const s = await M.startSession(
      {},
      { input: { id: generateId(), tool: 'claude-code', host: 'mbp' } },
      ctx(outsider.id),
    );
    expect(s.userId).toBe(outsider.id);
    // Single read: creator sees it; an unrelated user does not.
    const single = await Q.session({}, { id: s.id }, ctx(outsider.id));
    expect(single?.id).toBe(s.id);
    expect(await Q.session({}, { id: s.id }, ctx(userOne.id))).toBeNull();
    // List: creator's scope includes it; an unrelated user's does not.
    const mine = await Q.sessions({}, {}, ctx(outsider.id));
    expect(mine.map((x: { id: string }) => x.id)).toContain(s.id);
    const others = await Q.sessions({}, {}, ctx(userOne.id));
    expect(others.map((x: { id: string }) => x.id)).not.toContain(s.id);
  });

  it('refuses to attribute a session to a non-public agent the caller cannot read', async () => {
    const agent = await M.createAgent(
      {},
      { orgId: orgA.id, name: 'Backend Worker' },
      ctx(adminA.id),
    );
    await expect(
      M.startSession(
        {},
        { input: { id: generateId(), agentRef: agent.id } },
        ctx(outsider.id),
      ),
    // #1944: an Agent the caller can't read answers exactly as an absent one.
    ).rejects.toThrow(`Agent not found: ${agent.id}`);
  });
});
