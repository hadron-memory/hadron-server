/**
 * #4216 (ruled option A, cor:dmo:050:01): a private or personal memory is never
 * promoted to an Agent's system memory. createAgent's `systemMemoryId` and
 * updateAgent's first attach refuse it with a typed BAD_USER_INPUT that names
 * its class; before this, the promotion write left `user_id` set on a row
 * whose visibility became NULL, broke `chk_personal_visibility_user`, and the
 * caller got INTERNAL_SERVER_ERROR.
 *
 * Cases A-D (createAgent) and G-J (updateAgent first attach) follow the
 * QA matrix on the issue; E and F are the no-`systemMemoryId` controls.
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
const userCtx = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

async function refusal(p: Promise<unknown>): Promise<GraphQLError> {
  try {
    await p;
  } catch (e) {
    return e as GraphQLError;
  }
  throw new Error('expected a rejection');
}

const wire = (e: GraphQLError) => JSON.stringify({ message: e.message, extensions: e.extensions ?? {} });

type Klass = 'private' | 'personal';

let org: { id: string; urn: string };
let owner: { id: string }; // org ADMIN who owns the private/personal sources
let stranger: { id: string }; // org ADMIN who cannot read the owner's private memory

async function source(klass: Klass, where: 'user' | 'org', userId = owner.id) {
  return db.memory.create({
    data: {
      id: generateId(), urn: `src4216-${generateId()}`, name: `src-${klass}-${where}`, class: klass,
      userId, createdBy: userId, ...(where === 'org' ? { organizationId: org.id } : { ownerUserId: userId }),
    },
  });
}

async function snapshot(id: string) {
  const m = await db.memory.findUniqueOrThrow({ where: { id } });
  return { class: m.class, visibility: m.visibility, userId: m.userId, name: m.name, acceptsUploads: m.acceptsUploads };
}

/** An Agent with no system memory yet (the updateAgent first-attach shape). */
async function brainlessAgent(where: 'user' | 'org', name: string): Promise<{ id: string }> {
  const args = where === 'org' ? { orgId: org.id, name } : { name, visibility: 'PERSONAL' };
  const created = await M.createAgent({}, args, userCtx(owner.id));
  await db.agent.update({ where: { id: created.id }, data: { systemMemoryId: null } });
  return { id: created.id };
}

const agentCount = () => db.agent.count();

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'priv4216', urn: `priv4216-${suffix}.com` } });
  const mk = (n: number) =>
    db.user.create({ data: { id: generateId(), githubId: 421600 + n, githubUsername: `priv4216-${n}-${suffix}`, roles: ['READER'] } });
  owner = await mk(1);
  stranger = await mk(2);
  for (const u of [owner, stranger]) {
    await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: u.id, role: 'ADMIN' } });
  }
});

const SHAPES: Array<{ id: string; klass: Klass; where: 'user' | 'org' }> = [
  { id: 'A/G', klass: 'private', where: 'user' },
  { id: 'B/H', klass: 'personal', where: 'user' },
  { id: 'C/I', klass: 'private', where: 'org' },
  { id: 'D/J', klass: 'personal', where: 'org' },
];

describe('createAgent(systemMemoryId) refuses a private or personal source (A-D)', () => {
  for (const s of SHAPES) {
    it(`${s.id}: ${s.where}-owned Agent over a ${s.klass} memory is a typed refusal naming the class, and nothing changes`, async () => {
      const src = await source(s.klass, s.where);
      const before = await snapshot(src.id);
      const agents = await agentCount();
      const args = s.where === 'org'
        ? { orgId: org.id, name: 'B', systemMemoryId: src.id }
        : { name: 'B', systemMemoryId: src.id, visibility: 'PERSONAL' };
      const err = await refusal(M.createAgent({}, args, userCtx(owner.id)));
      expect(err).toBeInstanceOf(GraphQLError);
      expect(err.extensions?.code).toBe('BAD_USER_INPUT');
      expect(err.message).toContain(s.klass);
      expect(await snapshot(src.id)).toEqual(before);
      expect(await agentCount()).toBe(agents);
    });
  }
});

describe('updateAgent first attach refuses a private or personal source (G-J)', () => {
  for (const s of SHAPES) {
    it(`${s.id}: ${s.where}-owned Agent over a ${s.klass} memory is a typed refusal; the Agent's call applies nothing`, async () => {
      const src = await source(s.klass, s.where);
      const before = await snapshot(src.id);
      const agent = await brainlessAgent(s.where, 'C');
      const err = await refusal(
        M.updateAgent({}, { ref: agent.id, systemMemoryId: src.id, description: 'must not land' }, userCtx(owner.id)),
      );
      expect(err).toBeInstanceOf(GraphQLError);
      expect(err.extensions?.code).toBe('BAD_USER_INPUT');
      expect(err.message).toContain(s.klass);
      expect(await snapshot(src.id)).toEqual(before);
      const a = await db.agent.findUniqueOrThrow({ where: { id: agent.id } });
      expect(a.systemMemoryId).toBeNull();
      expect(a.description).not.toBe('must not land');
    });
  }
});

describe('controls and concealment', () => {
  it('E/F: createAgent without systemMemoryId still succeeds, user-owned and org-owned', async () => {
    const e = await M.createAgent({}, { name: 'E', visibility: 'PERSONAL' }, userCtx(owner.id));
    const f = await M.createAgent({}, { orgId: org.id, name: 'F' }, userCtx(owner.id));
    expect(e.systemMemoryId).toBeTruthy();
    expect(f.systemMemoryId).toBeTruthy();
  });

  it('a non-reader of the private source gets the byte-identical not-found of a missing id, never the class refusal', async () => {
    const src = await source('private', 'org');
    const missing = generateId();
    const mk = (id: string) => M.createAgent({}, { orgId: org.id, name: 'S', systemMemoryId: id }, userCtx(stranger.id));
    const real = await refusal(mk(src.id));
    const gone = await refusal(mk(missing));
    expect(real.extensions?.code).toBe('MEMORY_NOT_FOUND');
    expect(wire(real)).toBe(wire(gone));
    const brainless = await brainlessAgent('org', 'S2');
    const upd = await refusal(M.updateAgent({}, { ref: brainless.id, systemMemoryId: src.id }, userCtx(stranger.id)));
    expect(upd.extensions?.code).toBe('MEMORY_NOT_FOUND');
  });

  it('a plain knowledge memory (not private or personal) is still promotable', async () => {
    const plain = await db.memory.create({
      data: { id: generateId(), urn: `plain4216-${generateId()}`, name: 'plain', class: 'knowledge', organizationId: org.id },
    });
    const b = await M.createAgent({}, { orgId: org.id, name: 'P', systemMemoryId: plain.id }, userCtx(owner.id));
    expect(b.systemMemoryId).toBe(plain.id);
  });
});
