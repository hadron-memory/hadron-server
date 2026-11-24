/**
 * #5039 — the #5028 follow-ups on the agentRevisions snapshot read (cor:dmo:050:23 S6).
 *
 * readAgentRevisionList re-reads the Agent inside its snapshot. That re-read must gate the served row: a soft-deleted
 * Agent is absent, exactly as the read gate answers it (#1944), never served its revision list. Its result also tells
 * "absent" from "no system memory": one bare null for both is what let the deleted case hide behind the wrong message.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { generateId } from '../../../lib/id.js';
import { readAgentRevisionList } from '../../../lib/agentRevisionSnapshot.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

let manager: { id: string };
let agent: { id: string; systemMemoryId: string | null };
const ctx = (over?: Partial<Context>): Context => ({ db, roles: ['READER'], userId: manager.id, ...over });
const save = () => resolvers.Mutation.createRevision({}, { agentRef: agent.id }, ctx());
const softDelete = () => db.agent.update({ where: { id: agent.id }, data: { deletedAt: new Date() } });

/** What a refusal looks like on the wire: its class name, message and extensions (compared raw, not normalised). */
async function refusal(p: Promise<unknown>) {
  const e = await p.then(() => null, (err: unknown) => err as Error & { extensions?: unknown });
  if (!e) throw new Error('expected a refusal, got a result');
  return { name: e.name, message: e.message, extensions: e.extensions };
}

/**
 * A ctx.db whose snapshot transaction first runs `before` on the real client: the window between the resolver's read
 * gate and the snapshot's own Agent re-read. One-shot. It also counts the gate's reads of this Agent that returned the
 * LIVE row, and records that count when the hook fires: a nonzero count proves the gate read and passed the live Agent
 * before the delete landed, so the refusal can only come from the snapshot's re-read (#5107 F1).
 */
function dbWithHookBeforeSnapshot(agentId: string, before: () => Promise<unknown>) {
  const state = { ran: false, liveGateReads: 0, liveGateReadsAtHook: -1 };
  const agentDelegate = new Proxy(db.agent, {
    get(target, prop, receiver) {
      if (prop === 'findUnique') {
        return async (args: Parameters<typeof db.agent.findUnique>[0]) => {
          const row = await target.findUnique(args);
          if (row && (row as { id?: string }).id === agentId && (row as { deletedAt?: Date | null }).deletedAt === null) state.liveGateReads++;
          return row;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'agent') return agentDelegate;
      if (prop === '$transaction') {
        return async (...args: unknown[]) => {
          if (!state.ran) { state.ran = true; state.liveGateReadsAtHook = state.liveGateReads; await before(); }
          return (target.$transaction as (...a: unknown[]) => unknown)(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { proxy: proxy as typeof db, state };
}

beforeEach(async () => {
  await cleanDb(db);
  manager = await db.user.create({ data: { githubId: 85039, githubUsername: 'rev5039-mgr', roles: ['READER'] } });
  const org = await db.organization.create({ data: { id: generateId(), name: 'rev5039', urn: 'rev5039' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: manager.id, role: 'ADMIN' } });
  agent = await resolvers.Mutation.createAgent({}, { orgRef: org.id, name: 'agent-5039', visibility: 'PERSONAL' }, ctx());
  expect(agent.systemMemoryId).toBeTruthy();
});

describe('#5039 item 1: the snapshot re-read gates the served row', () => {
  it('a soft-deleted Agent that still has its system memory reads as absent, not as its revision list', async () => {
    await save();
    await softDelete();
    expect(await readAgentRevisionList(db, agent.id)).toEqual({ kind: 'absent' });
  });

  it('an Agent deleted between the gate and the snapshot gets the read gate\'s own refusal, byte for byte', async () => {
    await save();
    const { proxy, state } = dbWithHookBeforeSnapshot(agent.id, softDelete);
    const raced = await refusal(resolvers.Query.agentRevisions({}, { agentRef: agent.id }, ctx({ db: proxy })));
    expect(state.ran).toBe(true); // the snapshot transaction opened, so the gate (and ADMIN) passed
    expect(state.liveGateReadsAtHook).toBeGreaterThanOrEqual(1); // the gate read the LIVE row before the delete landed
    // The same Agent, now deleted, refused by the read gate itself (no window needed).
    const gated = await refusal(resolvers.Query.agentRevisions({}, { agentRef: agent.id }, ctx()));
    expect(gated.name).toBe('AgentNotFoundError');
    expect(raced).toEqual(gated);
  });

  it('a missing Agent id reads as absent', async () => {
    expect(await readAgentRevisionList(db, generateId())).toEqual({ kind: 'absent' });
  });
});

describe('#5039 item 2: no system memory is its own result', () => {
  it('a live Agent with no system memory reads as no-system-memory, distinct from absent, and keeps today\'s message', async () => {
    await db.agent.update({ where: { id: agent.id }, data: { systemMemoryId: null } });
    expect(await readAgentRevisionList(db, agent.id)).toEqual({ kind: 'no-system-memory' });
    await expect(resolvers.Query.agentRevisions({}, { agentRef: agent.id }, ctx())).rejects.toThrow('Agent has no system memory');
  });

  it('a soft-deleted Agent with no system memory is absent: absent wins over no-system-memory', async () => {
    await db.agent.update({ where: { id: agent.id }, data: { systemMemoryId: null, deletedAt: new Date() } });
    expect(await readAgentRevisionList(db, agent.id)).toEqual({ kind: 'absent' });
  });
});

describe('#5039 item 4: the no-pin and TransactionClient branches', () => {
  it('an Agent with no published pin lists its rows with no published revision', async () => {
    await save(); await save();
    expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).publishedRevisionLoc).toBeNull();
    const r = await readAgentRevisionList(db, agent.id);
    expect(r.kind).toBe('list');
    if (r.kind !== 'list') return;
    expect(r.list.revisions.map((x) => [x.revisionLoc, x.published])).toEqual([['revisions:rev-2', false], ['revisions:rev-1', false]]);
  });

  it('a TransactionClient reads inside the caller\'s own transaction, not a second one', async () => {
    await save(); await save();
    const seen = await db.$transaction(async (tx) => {
      // Uncommitted in the caller's transaction: only a read on THIS transaction can see the pin.
      await tx.agent.update({ where: { id: agent.id }, data: { publishedRevisionLoc: 'revisions:rev-1' } });
      return readAgentRevisionList(tx, agent.id);
    });
    expect(seen.kind).toBe('list');
    if (seen.kind !== 'list') return;
    expect(seen.list.revisions.map((x) => [x.revisionLoc, x.published])).toEqual([['revisions:rev-2', false], ['revisions:rev-1', true]]);
  });
});
