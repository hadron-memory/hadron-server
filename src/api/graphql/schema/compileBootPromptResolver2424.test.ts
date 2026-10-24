/**
 * #2424 — the compile doors' resolver boundary (cor:agt:040:12). (1) Resolving the target ref is part of the
 * operation: a pool fault there is the same typed, retryable CONFLICT as inside the compile (never INTERNAL, never
 * an authority refusal), a stalled read is bounded by the one operation budget, and nothing is written. (2) Once the
 * deciding transaction commits, the answer is that committed revision, built from the transaction's own result: no
 * further fallible read can turn a committed compile into an error that invites a second revision.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { compileBootPromptMutations as doors } from './resolvers.mutation.compileBootPrompt.js';
import type { Context } from './resolvers.helpers.js';

const poolTimeout = () =>
  new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection from the connection pool.', {
    code: 'P2024', clientVersion: 'test',
  });

/** A db whose named model fails every method the way the pool does, everything else delegated. */
function poolFailingModel(model: string): Context['db'] {
  return new Proxy(db, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (prop !== model) return typeof v === 'function' ? v.bind(target) : v;
      return new Proxy(v as object, {
        get: (m, p, r) => (typeof Reflect.get(m, p, r) === 'function' ? () => Promise.reject(poolTimeout()) : Reflect.get(m, p, r)),
      });
    },
  }) as Context['db'];
}
/** A db whose named model method never settles: a stalled read. */
function stalled(model: string, method: string): Context['db'] {
  return new Proxy(db, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (prop !== model) return typeof v === 'function' ? v.bind(target) : v;
      return new Proxy(v as object, { get: (m, p, r) => (p === method ? () => new Promise(() => undefined) : Reflect.get(m, p, r)) });
    },
  }) as Context['db'];
}

let adminId: string;
let agentId: string;
let orgId: string;
beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'r-org', urn: 'r-org' } })).id;
  adminId = (await db.user.create({ data: { id: generateId(), name: 'admin' } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: adminId, role: 'ADMIN' } });
  const mem = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'sys', urn: 'r-org:sys', organizationId: orgId } });
  agentId = (await db.agent.create({ data: { id: generateId(), name: 'Agent', urn: 'r-org:agent', organizationId: orgId, systemMemoryId: mem.id } })).id;
  await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc: 'boot:source', name: 'src', content: 'hi', role: 'boot-prompt' } });
});
afterEach(() => { vi.useRealTimers(); });

const ctxWith = (database: Context['db']) => ({ db: database, userId: adminId, roles: [], clientId: `user:${adminId}` }) as Context;
const snapshot = async () => ({ nodes: await db.node.count(), revisions: await db.compiledPromptRevision.count(), edges: await db.edge.count() });
const outcome = async (p: Promise<unknown>) => {
  try { await p; return { code: 'NO_ERROR', message: '' }; } catch (e) {
    const x = e as { extensions?: { code?: string }; message: string };
    return { code: String(x.extensions?.code ?? 'RAW'), message: x.message };
  }
};

describe('#2424 (1) reference resolution is inside the operation budget', () => {
  const calls: Array<[string, (c: Context) => Promise<unknown>, string]> = [
    ['compileAgentBootPrompt', (c) => doors.compileAgentBootPrompt(null, { agentRef: 'r-org:agent' }, c), 'agent'],
    ['compileAppAgentBootPrompt', (c) => doors.compileAppAgentBootPrompt(null, { appRef: 'r-org:app', agentRef: 'r-org:agent' }, c), 'app'],
    ['compileWorkerBootPrompt', (c) => doors.compileWorkerBootPrompt(null, { workerRef: generateId() }, c), 'worker'],
  ];
  it.each(calls)('%s: a pool fault on the ref read answers the sanitized CONFLICT and writes nothing', async (_name, call, model) => {
    const before = await snapshot();
    const r = await outcome(call(ctxWith(poolFailingModel(model))));
    expect(r.code).toBe('CONFLICT');
    expect(r.message).not.toMatch(/pool|P2024|connection|internal/i);
    expect(await snapshot()).toEqual(before);
  });

  it('a stalled ref read is cut off by the one operation budget as the same CONFLICT', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const pending = outcome(doors.compileAgentBootPrompt(null, { agentRef: 'r-org:agent' }, ctxWith(stalled('agent', 'findFirst'))));
    await vi.advanceTimersByTimeAsync(30_500);
    expect((await pending).code).toBe('CONFLICT');
  });

  it('control: a ref that names nothing is still the stable NOT_PERMITTED, not a conflict', async () => {
    const r = await outcome(doors.compileAgentBootPrompt(null, { agentRef: 'r-org:no-such-agent' }, ctxWith(db)));
    expect(r.code).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
  });
});

describe('#2424 (2) a committed compile is reported as committed', () => {
  it('a failing pooled node lookup after the commit cannot turn the answer into an error', async () => {
    const pooled = new Proxy(db, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (prop !== 'node') return typeof v === 'function' ? v.bind(target) : v;
        return new Proxy(v as object, { get: (m, p, r) => (p === 'findUniqueOrThrow' ? () => Promise.reject(poolTimeout()) : Reflect.get(m, p, r)) });
      },
    }) as Context['db'];
    const out = await doors.compileAgentBootPrompt(null, { agentRef: 'r-org:agent' }, ctxWith(pooled)) as { node: { id: string; loc: string }; revNo: number; pointerSet: boolean };
    expect(out.revNo).toBe(1);
    expect(out.node.loc).toBe('boot:compiled');
    expect(out.pointerSet).toBe(true);
    expect(await db.compiledPromptRevision.count()).toBe(1); // one committed revision, answered as such
  });

  it('control: the answer carries the committed node row', async () => {
    const out = await doors.compileAgentBootPrompt(null, { agentRef: 'r-org:agent' }, ctxWith(db)) as { node: { id: string; content: string | null; revSeq: number }; revNo: number };
    const stored = await db.node.findUniqueOrThrow({ where: { id: out.node.id } });
    expect(out.node.content).toBe(stored.content);
    expect(out.node.revSeq).toBe(out.revNo);
  });
});
