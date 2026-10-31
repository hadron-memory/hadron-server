/**
 * #1885 (cor:dmo:050:14, S8): retiring an Agent that a live Agent extends is
 * refused with AGENT_IN_USE and changes nothing; once the child's base is
 * cleared (or the child is retired), the retirement goes ahead. Pinned through
 * the real deleteAgent and setAgentBase mutations, including both orders of a
 * set-base racing a retirement of the same base.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { waitForLockWaiters } from '../../../test/lockWait.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
let userId: string;
let org: { id: string };
const ctx = (): Context => ({ db, userId, roles: [] });
const makeAgent = (name: string) => M.createAgent(null, {
  orgId: org.id, name, visibility: 'PUBLIC',
}, ctx());
const setBase = (childId: string, baseId: string | null, c: Context = ctx()) =>
  M.setAgentBase(null, { ref: childId, baseRef: baseId }, c);
const deleteAgent = (id: string, c: Context = ctx()) => M.deleteAgent(null, { ref: id }, c);

beforeEach(async () => {
  await cleanDb(db);
  const user = await db.user.create({ data: { id: generateId(), handle: 'retire-base-admin', githubId: 1885801, roles: [] } });
  userId = user.id;
  org = await db.organization.create({ data: { id: generateId(), name: 'Retire Base Org', urn: 'retire-base.example' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId, role: 'ADMIN' } });
});

/** Complete persisted rows: a refusal cannot dirty even timestamps. */
async function snapshot(...agents: Array<{ id: string; systemMemoryId: string }>) {
  return Promise.all(agents.map(async a => ({
    agent: await db.agent.findUniqueOrThrow({ where: { id: a.id } }),
    memory: await db.memory.findUniqueOrThrow({ where: { id: a.systemMemoryId } }),
  })));
}

/** Pause an actual mutation after its write, with its real transaction and locks still open. */
function pauseWrite(model: 'agent', operation: 'update') {
  let release!: () => void;
  let signal!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const held = new Promise<void>(resolve => { signal = resolve; });
  const wrapped = new Proxy(db, { get(target, property) {
    if (property !== '$transaction') return Reflect.get(target, property);
    return (callback: (tx: any) => Promise<unknown>, options: any) => target.$transaction(async tx => {
      const proxied = new Proxy(tx, { get(t, p) {
        if (p !== model) return Reflect.get(t, p);
        const delegate = Reflect.get(t, p);
        return new Proxy(delegate, { get(d, method) {
          if (method !== operation) return Reflect.get(d, method);
          return async (args: any) => {
            const invoke = Reflect.get(d, method) as (args: unknown) => Promise<unknown>;
            const result = await invoke.call(d, args);
            signal();
            await gate;
            return result;
          };
        } });
      } });
      return callback(proxied);
    }, options);
  } });
  return { ctx: { ...ctx(), db: wrapped }, held, release };
}

/** Capture errors immediately so a controlled competing refusal cannot be unhandled. */
const resultOf = (promise: Promise<unknown>) => promise.then(
  value => ({ ok: true, value, error: undefined as any }),
  error => ({ ok: false, value: undefined, error }),
);

describe('S8: retiring a base a live Agent extends (cor:dmo:050:14)', () => {
  it('is refused with AGENT_IN_USE, changes nothing, and names no other Agent; clearing the base unblocks it', async () => {
    const base = await makeAgent('engineer');
    const child = await makeAgent('backend-engineer');
    await setBase(child.id, base.id);
    const before = await snapshot(base, child);

    const refused = await resultOf(deleteAgent(base.id));
    expect(refused.error).toMatchObject({ extensions: { code: 'AGENT_IN_USE' } });
    expect(refused.error.message).not.toContain(child.id);
    expect(refused.error.message).not.toContain('backend-engineer');
    expect(await snapshot(base, child)).toEqual(before);

    await setBase(child.id, null);
    expect(await deleteAgent(base.id)).toBe(true);
    const [after] = await snapshot(base);
    expect(after.agent.deletedAt).not.toBeNull();
    expect(after.memory.deletedAt).not.toBeNull();
  });

  it('a retired child does not block its base', async () => {
    const base = await makeAgent('engineer');
    const child = await makeAgent('backend-engineer');
    await setBase(child.id, base.id);

    expect(await deleteAgent(child.id)).toBe(true);
    expect(await deleteAgent(base.id)).toBe(true);
  });

  it('a chain retires from the bottom up: each live child blocks its own base', async () => {
    const a = await makeAgent('engineer');
    const b = await makeAgent('backend-engineer');
    const c = await makeAgent('go-engineer');
    await setBase(b.id, a.id);
    await setBase(c.id, b.id);

    for (const blocked of [a, b]) {
      await expect(deleteAgent(blocked.id)).rejects.toMatchObject({ extensions: { code: 'AGENT_IN_USE' } });
    }
    expect(await deleteAgent(c.id)).toBe(true);
    await expect(deleteAgent(a.id)).rejects.toMatchObject({ extensions: { code: 'AGENT_IN_USE' } });
    expect(await deleteAgent(b.id)).toBe(true);
    expect(await deleteAgent(a.id)).toBe(true);
  });

  it('a base with no live child still retires (the arm adds no false refusal)', async () => {
    const base = await makeAgent('engineer');
    const other = await makeAgent('unrelated');
    const child = await makeAgent('backend-engineer');
    await setBase(child.id, other.id);

    expect(await deleteAgent(base.id)).toBe(true);
  });
});

describe('S8 races: set-base against retiring the same base', () => {
  it('set-base wins: retirement waits for its commit, then refuses with every row intact', async () => {
    const base = await makeAgent('engineer');
    const child = await makeAgent('backend-engineer');
    const pause = pauseWrite('agent', 'update');
    const setting = resultOf(setBase(child.id, base.id, pause.ctx));
    await pause.held;
    const retiring = resultOf(deleteAgent(base.id));
    try {
      await waitForLockWaiters(db);
      pause.release();
      expect((await setting).ok).toBe(true);
      expect((await retiring).error).toMatchObject({ extensions: { code: 'AGENT_IN_USE' } });
      const [b, c] = await snapshot(base, child);
      expect(b.agent.deletedAt).toBeNull();
      expect(b.memory.deletedAt).toBeNull();
      expect(c.agent.extendsAgentId).toBe(base.id);
    } finally {
      pause.release();
      await Promise.allSettled([setting, retiring]);
    }
  });

  it('retirement wins: set-base waits, finds the base retired, and writes nothing', async () => {
    const base = await makeAgent('engineer');
    const child = await makeAgent('backend-engineer');
    const pause = pauseWrite('agent', 'update');
    const retiring = resultOf(deleteAgent(base.id, pause.ctx));
    await pause.held;
    const setting = resultOf(setBase(child.id, base.id));
    try {
      await waitForLockWaiters(db);
      pause.release();
      expect((await retiring).ok).toBe(true);
      expect((await setting).ok).toBe(false);
      const [b, c] = await snapshot(base, child);
      expect(b.agent.deletedAt).not.toBeNull();
      expect(c.agent.extendsAgentId).toBeNull();
    } finally {
      pause.release();
      await Promise.allSettled([setting, retiring]);
    }
  });
});
