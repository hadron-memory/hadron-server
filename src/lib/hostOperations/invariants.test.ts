import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #1709 — the database facts of host operations (prisma/host-operation-invariants.sql),
 * tested at the database rather than through a resolver: the closed set and its
 * typed arguments, the forward-only status, the same-App worker, and the kept
 * record of host-key use. Plus the shared writer shapes (types.ts).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { HOST_OPERATION_TYPES, isHostToken, validateHostOperation, HostOperationArgsError } from './types.js';

let app: { id: string };
let otherApp: { id: string };
let kit: { id: string };
let zed: { id: string };
let user: { id: string };

async function expectCheck(p: Promise<unknown>, re: RegExp = /chk_host_operations_shape|23514|check constraint/) {
  await expect(p).rejects.toThrow(re);
}

const op = (data: Record<string, unknown> = {}) =>
  db.hostOperation.create({
    data: {
      id: generateId(), appId: app.id, hostId: 'orca1', type: 'worktree.create', workerId: kit.id,
      args: { workerId: kit.id, repo: 'hadron-server', baseBranch: 'main', branchName: 'kit/x', label: 'kit-x' },
      issuedBy: 'user', issuedByUserId: user.id,
      ...data,
    } as any,
  });

beforeEach(async () => {
  await cleanDb(db);
  const n = Math.floor(Math.random() * 1_000_000);
  const org = await db.organization.create({ data: { name: 'Inv', urn: `hostinv-${n}.example` } });
  user = await db.user.create({ data: { githubId: 81_000_000 + n, githubUsername: `hi-${n}`, roles: ['READER'] }, select: { id: true } });
  const agent = await db.agent.create({ data: { organizationId: org.id, name: 'A', urn: `${org.urn}:a`, visibility: 'ORGANIZATION' } });
  app = await db.app.create({ data: { organizationId: org.id, name: 'T', urn: `${org.urn}:t` }, select: { id: true } });
  otherApp = await db.app.create({ data: { organizationId: org.id, name: 'O', urn: `${org.urn}:o` }, select: { id: true } });
  kit = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: app.id, agentId: agent.id, name: 'Kit', slug: 'kit' }, select: { id: true } });
  zed = await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, appId: otherApp.id, agentId: agent.id, name: 'Zed', slug: 'zed' }, select: { id: true } });
});

describe('the invariants file', () => {
  it('the migration carries a byte-identical copy, and post-push includes it after the file whose token function it uses', () => {
    const source = readFileSync(new URL('../../../prisma/host-operation-invariants.sql', import.meta.url), 'utf8');
    const migration = readFileSync(new URL('../../../prisma/migrations/20261024100100_context_reset_host_operations/migration.sql', import.meta.url), 'utf8');
    expect(migration.endsWith(`\n${source}`)).toBe(true);
    const post = readFileSync(new URL('../../../prisma/post-push.sql', import.meta.url), 'utf8');
    const at = post.indexOf('\\ir host-operation-invariants.sql');
    expect(at).toBeGreaterThan(post.indexOf('\\ir agent-task-matching-invariants.sql'));
    expect(post.indexOf('\\ir agent-task-matching-invariants.sql')).toBeGreaterThan(-1);
  });
});

describe('cor:agt:070:03 — the closed set, with exactly its typed arguments', () => {
  it('each of the six types with its own arguments is accepted', async () => {
    await expect(op()).resolves.toBeTruthy();
    // #1883: a start records the hold that authorized it (prisma/host-launch-invariants.sql).
    await expect(op({ type: 'worker.start', args: { workerId: kit.id, worktree: 'hadron-server/kit', family: 'claude', taskId: 't1' }, holdUserId: user.id })).resolves.toBeTruthy();
    await db.session.create({ data: { id: 's1', workerId: kit.id, appId: app.id, userId: user.id } });
    await expect(op({ type: 'worker.deliver', args: { workerId: kit.id, sessionId: 's1', eventId: 'e1' } })).resolves.toBeTruthy();
    await expect(op({ type: 'worker.end', args: { workerId: kit.id, sessionId: 's1' } })).resolves.toBeTruthy();
    await expect(op({ type: 'worktree.remove', args: { workerId: kit.id, worktree: 'hadron-server/kit' } })).resolves.toBeTruthy();
    // #2162 (cor:agt:050:27): the reset, with exactly its ids.
    await expect(op({ type: 'worker.reset-context', args: { workerId: kit.id, sessionId: 's1', taskId: 't1', resetId: 'r1' } })).resolves.toBeTruthy();
    await expectCheck(op({ type: 'worker.reset-context', args: { workerId: kit.id, sessionId: 's1', taskId: 't1' } }));
    await expectCheck(op({ type: 'worker.reset-context', args: { workerId: kit.id, sessionId: 's1', taskId: 't1', resetId: 'r1', command: 'kill' } }));
    expect(HOST_OPERATION_TYPES).toHaveLength(6);
  });

  it('a shell type, an extra or missing argument, a non-string, a bad token or another worker\'s id is refused', async () => {
    await expectCheck(op({ type: 'shell', args: { workerId: kit.id, command: 'id' } }));
    await expectCheck(op({ args: { workerId: kit.id, repo: 'r', baseBranch: 'main', branchName: 'b', label: 'l', command: 'id' } }));
    await expectCheck(op({ args: { workerId: kit.id, repo: 'r', baseBranch: 'main', branchName: 'b' } }));
    await expectCheck(op({ args: { workerId: kit.id, repo: 1, baseBranch: 'main', branchName: 'b', label: 'l' } }));
    for (const bad of ['-rf', '../x', 'a/../b', 'a//b', 'a/', 'x;id', '$(id)', 'a b', '']) {
      await expectCheck(op({ args: { workerId: kit.id, repo: bad, baseBranch: 'main', branchName: 'b', label: 'l' } }));
    }
    await expectCheck(op({ args: { workerId: zed.id, repo: 'r', baseBranch: 'main', branchName: 'b', label: 'l' } }));
    await expectCheck(op({ type: 'worker.start', args: { workerId: kit.id, worktree: 'w', family: 'Claude' }, holdUserId: user.id }));
    await expectCheck(op({ args: ['not', 'an', 'object'] }));
    expect(await db.hostOperation.count()).toBe(0);
  });

  it('the writer refuses the same shapes before the database sees them', () => {
    const t = (type: string, args: unknown) => {
      try { validateHostOperation(type, args); return 'ok'; } catch (e) { return (e as HostOperationArgsError).code; }
    };
    expect(t('shell', { command: 'id' })).toBe('HOST_OPERATION_TYPE_UNKNOWN');
    expect(t('worktree.create', { workerId: 'w1', repo: 'r', baseBranch: 'main', branchName: 'b', label: 'l' })).toBe('ok');
    expect(t('worktree.create', { workerId: 'w1', repo: '-r', baseBranch: 'main', branchName: 'b', label: 'l' })).toBe('BAD_HOST_OPERATION_ARGS');
    expect(t('worktree.remove', { workerId: 'w1', worktree: 'w', extra: 'x' })).toBe('BAD_HOST_OPERATION_ARGS');
    expect(t('worker.end', { workerId: 'w1' })).toBe('BAD_HOST_OPERATION_ARGS');
    for (const ok of ['main', 'kit/1709-x', 'hadron-server/kit', 'v1.2.3', 'a@b+c']) expect(isHostToken(ok)).toBe(true);
    for (const bad of ['-x', '.x', '/x', 'a/', 'a..b', 'a//b', 'a b', 'a;b', 'a$b', 'a`b', '', 'x'.repeat(257)]) expect(isHostToken(bad)).toBe(false);
  });

  it('an operation is for a worker of its own App', async () => {
    await expect(op({ appId: otherApp.id })).rejects.toThrow(/not in the operation's App|chk_host_operations_same_app/);
  });
});

describe('cor:agt:070:02 — the status runs forward only, and what was issued never changes', () => {
  it('issued → collected → succeeded, each stage stamping its time; never back, never skipped', async () => {
    const o = await op();
    // #1881: settling before collection is allowed, but never with a collected_at.
    await expectCheck(db.hostOperation.update({ where: { id: o.id }, data: { status: 'succeeded', collectedAt: new Date(), finishedAt: new Date() } }), /no collected_at/);
    await expectCheck(db.hostOperation.update({ where: { id: o.id }, data: { status: 'collected' } }));
    await db.hostOperation.update({ where: { id: o.id }, data: { status: 'collected', collectedAt: new Date() } });
    await expectCheck(db.hostOperation.update({ where: { id: o.id }, data: { status: 'failed', finishedAt: new Date() } }));
    await db.hostOperation.update({ where: { id: o.id }, data: { status: 'succeeded', finishedAt: new Date(), result: { worktree: 'w' } } });
    await expectCheck(db.hostOperation.update({ where: { id: o.id }, data: { status: 'failed', failureReason: 'x', result: undefined } }), /moves only/);
  });

  it('#1881 (070:02): an operation never collected may be settled, failed with a reason or succeeded, keeping no collected_at', async () => {
    const f = await op();
    await expectCheck(db.hostOperation.update({ where: { id: f.id }, data: { status: 'failed', finishedAt: new Date() } }));
    await db.hostOperation.update({ where: { id: f.id }, data: { status: 'failed', finishedAt: new Date(), failureReason: 'host lost' } });
    const s = await op();
    await db.hostOperation.update({ where: { id: s.id }, data: { status: 'succeeded', finishedAt: new Date() } });
    // Settled is final, as reported is.
    await expectCheck(db.hostOperation.update({ where: { id: f.id }, data: { status: 'collected', collectedAt: new Date(), finishedAt: null, failureReason: null } }), /moves only/);
  });

  it('type, arguments, host, worker and issuer are fixed; an operation is kept, not deleted', async () => {
    const o = await op();
    await expectCheck(db.hostOperation.update({ where: { id: o.id }, data: { hostId: 'orca2' } }), /never change/);
    await expectCheck(db.hostOperation.update({ where: { id: o.id }, data: { args: { workerId: kit.id, repo: 'x', baseBranch: 'main', branchName: 'b', label: 'l' } } }), /never change/);
    await expectCheck(db.hostOperation.delete({ where: { id: o.id } }), /kept as the record/);
  });

  it('an issuer names exactly the ids its kind has', async () => {
    await expectCheck(op({ issuedBy: 'platform', issuedByUserId: user.id }));
    await expectCheck(op({ issuedBy: 'user', issuedByUserId: null }));
    await expectCheck(op({ issuedBy: 'host', issuedByUserId: null }));
    await expect(op({ issuedBy: 'platform', issuedByUserId: null })).resolves.toBeTruthy();
  });
});

describe('cor:agt:070:07 — every use of a host key is kept', () => {
  it('a use is never changed or removed while its key exists', async () => {
    const k = await db.appKey.create({ data: { id: generateId(), appId: app.id, keyHash: generateId(), keyPreview: 'abcd' } });
    const u = await db.hostKeyUse.create({ data: { id: generateId(), appKeyId: k.id, appId: app.id, hostId: 'orca1', action: 'collect', count: 0 } });
    await expect(db.hostKeyUse.update({ where: { id: u.id }, data: { count: 5 } })).rejects.toThrow(/append-only/);
    await expect(db.hostKeyUse.delete({ where: { id: u.id } })).rejects.toThrow(/append-only/);
    await expect(db.hostKeyUse.create({ data: { id: generateId(), appKeyId: k.id, appId: app.id, hostId: 'orca1', action: 'shell' } })).rejects.toThrow(/chk_host_key_uses_shape/);
    await expect(db.hostKeyUse.create({ data: { id: generateId(), appKeyId: k.id, appId: app.id, hostId: 'orca1', action: 'report' } })).rejects.toThrow(/chk_host_key_uses_shape/);
    // Removed with its key (the cascade).
    await db.appKey.delete({ where: { id: k.id } });
    expect(await db.hostKeyUse.count()).toBe(0);
  });
});

describe('the shapes #1709 adds to existing tables', () => {
  it('a registered worker\'s worktrees are name tokens, at most 32', async () => {
    const r = await db.hostRegistration.create({ data: { appId: app.id, hostId: 'orca1', label: 'o', pollIntervalSeconds: 60, refreshedAt: new Date() } });
    await expect(db.hostRegistrationWorker.create({ data: { registrationId: r.id, workerId: kit.id, family: 'claude', worktrees: ['-rf'] } })).rejects.toThrow(/chk_host_registration_workers_worktrees/);
    await expect(db.hostRegistrationWorker.create({ data: { registrationId: r.id, workerId: kit.id, family: 'claude', worktrees: Array.from({ length: 33 }, (_, i) => `w${i}`) } }))
      .rejects.toThrow(/chk_host_registration_workers_worktrees/);
    await expect(db.hostRegistrationWorker.create({ data: { registrationId: r.id, workerId: kit.id, family: 'claude', worktrees: ['hadron-server/kit'] } })).resolves.toBeTruthy();
  });

  it('a host\'s availability mark names its host and is only out of tokens or host down', async () => {
    const mark = (data: Record<string, unknown>) =>
      db.workerAvailability.create({ data: { workerId: kit.id, state: 'unavailable', reason: 'host-down', setAt: new Date(), setBy: 'host', ...data } as any });
    await expect(mark({})).rejects.toThrow(/chk_worker_availability_shape/);
    await expect(mark({ setByHostId: 'orca1', reason: 'stalled' })).rejects.toThrow(/chk_worker_availability_shape/);
    await expect(mark({ setBy: 'holder', setByHostId: 'orca1', reason: 'other' })).rejects.toThrow(/chk_worker_availability_shape/);
    await expect(mark({ setByHostId: 'orca1' })).resolves.toBeTruthy();
  });
});
