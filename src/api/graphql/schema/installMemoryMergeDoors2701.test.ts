/**
 * #2701 — the two generic MERGE doors, `updateNodeData` and `updateNodeProperties`, on an App's install memory
 * (#2044). Their pre-gate ran on the pooled client, where an install memory's write answer is "no" unless the door
 * says it rechecks in its own fenced transaction; the manager of a live App was refused. The audience itself is
 * unchanged: only a manager of a live, attached App merges.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppWithKey, createDbAppAgent, createDbAppMember } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers } from './resolvers.js';
import type { Context } from './resolvers.helpers.js';
import { lockAuthorityAnchors } from '../../../lib/auth/authorityAnchors.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
let orgId: string;

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'md-org', urn: 'md-org' } })).id;
});

const ctxOf = (userId: string) => ({ db, userId, roles: [], clientId: `user:${userId}` }) as unknown as Context;

async function fixture() {
  const user = async (name: string) => db.user.create({ data: { id: generateId(), name } });
  const agent = await db.agent.create({ data: { id: generateId(), name: 'Team Agent', urn: `${orgId}:team-agent`, organizationId: orgId } });
  const { app } = await createDbAppWithKey(db, 'md-app', orgId);
  await createDbAppAgent(db, app.id, agent.id);
  const admin = await user('admin'); await db.orgMember.create({ data: { organizationId: orgId, userId: admin.id, role: 'ADMIN' } });
  const member = await user('member'); await createDbAppMember(db, app.id, member.id, 'member');
  const stranger = await user('stranger');
  const node = await M.createNode({}, { input: { install: { appRef: app.id, agentRef: agent.id }, loc: 'prompts:lane', name: 'Lane', content: 'x', data: { a: 1 }, properties: { p: 1 } } }, ctxOf(admin.id));
  const row = () => db.node.findUniqueOrThrow({ where: { id: node.id } });
  return { agent, app, admin, member, stranger, node, row };
}

const DOORS: Array<[string, (f: Awaited<ReturnType<typeof fixture>>, userId: string) => Promise<unknown>, (r: any) => unknown]> = [
  ['updateNodeData', (f, u) => M.updateNodeData({}, { nodeRef: f.node.id, data: { b: 2 } }, ctxOf(u)), (r) => r.data],
  ['updateNodeProperties', (f, u) => M.updateNodeProperties({}, { nodeRef: f.node.id, properties: { q: 2 } }, ctxOf(u)), (r) => r.properties],
];

describe.each(DOORS)('#2701 %s on an install memory', (_name, call, field) => {
  it('merges for the manager of a live App', async () => {
    const f = await fixture();
    await call(f, f.admin.id);
    expect(field(await f.row())).toMatchObject(_name === 'updateNodeData' ? { a: 1, b: 2 } : { p: 1, q: 2 });
  });

  it('refuses a participant who is not a manager, and changes nothing', async () => {
    const f = await fixture();
    await expect(call(f, f.member.id)).rejects.toThrow(/Forbidden/);
    expect(field(await f.row())).toMatchObject(_name === 'updateNodeData' ? { a: 1 } : { p: 1 });
    expect(field(await f.row())).not.toHaveProperty(_name === 'updateNodeData' ? 'b' : 'q');
  });

  it('answers an outsider as a missing node, byte-identical to a node that does not exist', async () => {
    const f = await fixture();
    const denied = await call(f, f.stranger.id).catch(error => error);
    expect(denied).toMatchObject({ extensions: { code: 'NODE_NOT_FOUND' } });
    expect(field(await f.row())).not.toHaveProperty(_name === 'updateNodeData' ? 'b' : 'q');
    // Keep the exact same reference: only whether it exists changes between
    // the refused call and the real missing-node control.
    await db.node.delete({ where: { id: f.node.id } });
    const missing = await call(f, f.stranger.id).catch(error => error);
    expect(missing).toMatchObject({ extensions: { code: 'NODE_NOT_FOUND' } });
    expect(denied.message).toBe(missing.message);
  });

  it('refuses the manager of a DETACHED install memory (Agent erased)', async () => {
    const f = await fixture();
    await db.memory.updateMany({ where: { appId: f.app.id, installOfAgentId: f.agent.id }, data: { installOfAgentId: null } });
    await expect(call(f, f.admin.id)).rejects.toThrow();
    expect(field(await f.row())).not.toHaveProperty(_name === 'updateNodeData' ? 'b' : 'q');
  });

  it('refuses the manager once the App is DELETED', async () => {
    const f = await fixture();
    await M.deleteApp({}, { ref: f.app.id }, ctxOf(f.admin.id));
    await expect(call(f, f.admin.id)).rejects.toThrow();
    expect(field(await f.row())).not.toHaveProperty(_name === 'updateNodeData' ? 'b' : 'q');
  });
});

describe('#2769 updateNodeProperties decides platform authority after the App-anchor wait', () => {
  it.each([true, false])('revoked=%s: observes the wait, then judges live authority without a partial merge', async revoke => {
    const f = await fixture();
    // The platform role is the ONLY manager grant. App membership preserves
    // content read reach after revocation, so the deciding WRITE gate must
    // refuse, rather than an unrelated content-read precheck masking it.
    await db.orgMember.delete({ where: { organizationId_userId: { organizationId: orgId, userId: f.admin.id } } });
    await createDbAppMember(db, f.app.id, f.admin.id, 'member');
    await db.user.update({ where: { id: f.admin.id }, data: { roles: ['ADMIN'] } });
    const caller: Context = { ...ctxOf(f.admin.id), roles: ['ADMIN'] };
    const before = {
      node: await f.row(),
      revisions: await db.nodeRevision.findMany({ where: { nodeId: f.node.id }, orderBy: { id: 'asc' } }),
    };

    let release!: () => void;
    const commit = new Promise<void>(resolve => { release = resolve; });
    let held!: () => void;
    let failed!: (error: unknown) => void;
    const isHeld = new Promise<void>((resolve, reject) => { held = resolve; failed = reject; });
    const holder = db.$transaction(async tx => {
      await lockAuthorityAnchors(tx, [{ kind: 'app', id: f.app.id }], 'exclusive');
      held();
      await commit;
      if (revoke) await tx.user.update({ where: { id: f.admin.id }, data: { roles: [] } });
    }, { timeout: 20_000 });
    // Attach rejection handlers immediately; always release and drain both
    // connections even when a barrier/assertion fails.
    const holderOutcome = holder.then(() => null, error => { failed(error); return error; });
    await isHeld;
    const write = M.updateNodeProperties({}, { nodeRef: f.node.id, properties: { q: 2 } }, caller)
      .then((node: unknown) => ({ ok: true as const, node }), (error: unknown) => ({ ok: false as const, error }));
    let outcome: Awaited<typeof write>;
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1);
      const [wait] = await db.$queryRaw<Array<{ waiting: number }>>`
        SELECT count(*)::int AS waiting FROM pg_locks
        WHERE locktype = 'advisory' AND NOT granted
          AND classid = hashtext('authorization:app')::oid
          AND objid = hashtext(${f.app.id})::oid
          AND pid IN (SELECT pid FROM pg_stat_activity WHERE datname = current_database())`;
      expect(wait.waiting).toBe(1);
      expect(await f.row()).toEqual(before.node);
    } finally {
      release();
      const holderError = await holderOutcome;
      outcome = await write;
      if (holderError) throw holderError;
    }

    if (revoke) {
      expect(outcome).toMatchObject({ ok: false, error: { message: expect.stringMatching(/^Forbidden/), extensions: { code: 'FORBIDDEN' } } });
      expect(await f.row()).toEqual(before.node);
      expect(await db.nodeRevision.findMany({ where: { nodeId: f.node.id }, orderBy: { id: 'asc' } })).toEqual(before.revisions);
    } else {
      expect(outcome.ok).toBe(true);
      expect((await f.row()).properties).toEqual({ p: 1, q: 2 });
    }
  });
});
