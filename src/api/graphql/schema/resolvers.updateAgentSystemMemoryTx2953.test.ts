/**
 * #2953 — the in-transaction twin of #2856's system-memory refusal.
 *
 * `updateAgent` refuses a change of an Agent's system memory twice: once on
 * the pre-transaction read, and again on the row re-read under the deciding
 * transaction. The second guard only decides when the first saw no system
 * memory (a first-attach) and a concurrent attach landed in between. #2856's
 * own pins never reach it: deleting it left all four green. This one stages
 * that stale pre-transaction read (the Agent has NO system memory there, and
 * has one in the transaction) so the second guard alone decides, and asserts
 * the same answer as the first.
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

const MESSAGE = "Cannot unset or change an agent's system memory. Delete the agent to replace it.";

let org: { id: string; urn: string };
let admin: { id: string };
let agent: { id: string; name: string; systemMemoryId: string | null };
let otherMemory: { id: string };

/**
 * A context whose first plain `agent.findUnique({ where: { id } })` (the
 * pre-transaction read: no `select`) answers the Agent as it was before a
 * concurrent first-attach, i.e. with no system memory. Everything else,
 * including the transaction's own client, is the real database.
 */
function staleCtx(userId: string): { ctx: Context; staleReads: () => number } {
  let stale = 0;
  const agentDelegate = new Proxy(db.agent, {
    get(target, prop, receiver) {
      if (prop === 'findUnique') {
        return async (args: any) => {
          const row = await (target as any).findUnique(args);
          if (stale === 0 && row && row.id === agent.id && !args?.select && !args?.include) {
            stale++;
            return { ...row, systemMemoryId: null };
          }
          return row;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const staleDb = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'agent') return agentDelegate;
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { ctx: { db: staleDb as typeof db, userId, roles: ['READER'] }, staleReads: () => stale };
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'sysmem-2953', urn: `sysmem-2953-${suffix}.com` },
  });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 92953, githubUsername: `sysmem-tx-admin-${suffix}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  agent = await M.createAgent({}, { orgId: org.id, name: 'Sysmem Tx Agent' }, { db, userId: admin.id, roles: ['READER'] });
  // The fixture must really have a system memory, or these pins would pass
  // down a different path (a first-attach) than the one they describe.
  expect(agent.systemMemoryId).not.toBeNull();
  otherMemory = await db.memory.create({
    data: { id: generateId(), name: 'other', urn: `other-2953-${suffix}`, organizationId: org.id, class: 'knowledge' },
  });
});

describe('updateAgent: the in-transaction system-memory guard (#2953)', () => {
  it('refuses with the same BAD_USER_INPUT and message as the pre-transaction guard, and writes nothing', async () => {
    const { ctx, staleReads } = staleCtx(admin.id);
    let err: GraphQLError | undefined;
    try {
      await M.updateAgent({}, { ref: agent.id, name: 'Renamed', systemMemoryId: otherMemory.id }, ctx);
    } catch (e) {
      err = e as GraphQLError;
    }
    expect(staleReads()).toBe(1); // the stale snapshot was actually served
    expect(err).toBeInstanceOf(GraphQLError);
    expect(err!.extensions?.code).toBe('BAD_USER_INPUT');
    expect(err!.message).toBe(MESSAGE);

    const after = await db.agent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(after.systemMemoryId).toBe(agent.systemMemoryId);
    expect(after.name).toBe('Sysmem Tx Agent');
    const target = await db.memory.findUniqueOrThrow({ where: { id: otherMemory.id } });
    expect(target.class).toBe('knowledge'); // not promoted to a system memory
  });
});
