/** Combined-tree evidence (S9-3 e1c01a05 + #2258 c65e694a): the real compile coordinator vs an account transaction, both orders. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppWithKey } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { waitForLockWaitersOfType } from '../../../test/lockWait.js';
import { accountFenceClient, isSerializationConflict, withAccountFenceTransaction, withIncludeHistoryTransaction } from '../../../lib/includes/includeHistoryFence.js';
import { compileBootPrompt } from './compileBootPrompt.js';
import type { Context } from './resolvers.helpers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const epoch = async () => Number((await db.$queryRaw<Array<{ n: bigint }>>`SELECT n FROM include_history_epoch WHERE id = 1`)[0].n);
const orgCount = (urn: string) => db.organization.count({ where: { urn } });
const acctOp = (urn: string) => () => withAccountFenceTransaction(db, async (f) => {
  await accountFenceClient(f).organization.create({ data: { id: generateId(), name: urn, urn } });
});
let compile: () => Promise<unknown>;
let compiled: () => Promise<boolean>;

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'cb-org', urn: 'cb-org' } });
  const admin = await db.user.create({ data: { id: generateId(), name: 'admin' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  const mem = await db.memory.create({ data: { id: generateId(), class: 'system', name: 's', urn: 'cb-org:s', organizationId: org.id } });
  const agent = await db.agent.create({ data: { id: generateId(), name: 'A', urn: 'cb-org:a', organizationId: org.id, systemMemoryId: mem.id } });
  const { app } = await createDbAppWithKey(db, 'cb-app', org.id);
  await createDbAppAgent(db, app.id, agent.id);
  await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc: 'boot:source', name: 'src', content: 'hi', role: 'boot-prompt' } });
  const ctx = { db, userId: admin.id, roles: [], clientId: `user:${admin.id}` } as Context;
  compile = () => compileBootPrompt(ctx, { kind: 'AGENT', agentId: agent.id });
  compiled = async () => (await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).bootPromptNodeId != null;
});

async function hold() {
  let release!: () => void; const held = new Promise<void>((r) => { release = r; });
  let entered!: () => void; const inside = new Promise<void>((r) => { entered = r; });
  const done = withIncludeHistoryTransaction(db, async () => { entered(); await held; throw new Error('rb'); });
  done.catch(() => {}); await inside;
  return { release, done: done.then(() => undefined, () => undefined) };
}

describe('combined tree: compile (compile read/write holder) vs account fence', () => {
  it('compile ahead of the account: the account fails 40001 with no work; compile committed', async () => {
    const before = await epoch();
    const x = await hold();
    const pred = compile(); pred.catch(() => {});
    await waitForLockWaitersOfType(db, 'advisory', 1, 5_000);
    const acct = acctOp('c-stale')(); acct.catch(() => {});
    await waitForLockWaitersOfType(db, 'advisory', 2, 5_000);
    x.release(); await x.done; await pred;
    expect(isSerializationConflict(await acct.then(() => null, (e) => e))).toBe(true);
    expect(await orgCount('c-stale')).toBe(0);
    expect(await compiled()).toBe(true);
    expect(await epoch()).toBe(before + 1);
  });
  it('reverse: the account holds the fence, compile waits, then completes', async () => {
    const before = await epoch();
    let release!: () => void; const held = new Promise<void>((r) => { release = r; });
    let entered!: () => void; const inside = new Promise<void>((r) => { entered = r; });
    const acct = withAccountFenceTransaction(db, async (f) => {
      await accountFenceClient(f).organization.create({ data: { id: generateId(), name: 'c-rev', urn: 'c-rev' } });
      entered(); await held;
    });
    await inside;
    const c = compile(); c.catch(() => {});
    await waitForLockWaitersOfType(db, 'advisory', 1, 5_000);
    release(); await acct; await c;
    expect(await orgCount('c-rev')).toBe(1);
    expect(await compiled()).toBe(true);
    expect(await epoch()).toBe(before + 2);
  });
});
