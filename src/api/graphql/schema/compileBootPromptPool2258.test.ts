/**
 * #2258 pool-exhaustion residual (QA delta 2 P3, task 01a16b44ba41): a Prisma pool-acquire timeout is a
 * client-side P2024 ("Timed out fetching a new connection from the connection pool"), not the budget faults
 * `isBudgetFault` classifies (P2028 / 55P03). Deterministic stand-in for pool saturation: the db handle fails
 * the read the way the pool does, with no stress and no timing. Each case asserts the sanitized answer and that
 * nothing was written.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAppAgent, createDbAppWithKey } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { compileBootPrompt } from './compileBootPrompt.js';
import type { Context } from './resolvers.helpers.js';

const poolTimeout = () =>
  new Prisma.PrismaClientKnownRequestError('Timed out fetching a new connection from the connection pool.', {
    code: 'P2024', clientVersion: 'test',
  });

let orgId: string;
beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'pool-org', urn: 'pool-org' } })).id;
});

async function fixture() {
  const admin = await db.user.create({ data: { id: generateId(), name: 'admin' } });
  await db.orgMember.create({ data: { organizationId: orgId, userId: admin.id, role: 'ADMIN' } });
  const mem = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'sys', urn: 'pool-org:sys', organizationId: orgId } });
  const agent = await db.agent.create({ data: { id: generateId(), name: 'Agent', urn: 'pool-org:agent', organizationId: orgId, systemMemoryId: mem.id } });
  const { app } = await createDbAppWithKey(db, 'pool-app', orgId);
  await createDbAppAgent(db, app.id, agent.id);
  await db.node.create({ data: { id: generateId(), memoryId: mem.id, loc: 'boot:source', name: 'src', content: 'hi', role: 'boot-prompt' } });
  return { admin, agent };
}
const snapshot = async () => ({
  nodes: await db.node.count(), revisions: await db.compiledPromptRevision.count(), edges: await db.edge.count(),
  pointers: (await db.agent.findMany({ select: { bootPromptNodeId: true } })).map((a) => a.bootPromptNodeId),
});
const outcome = async (p: Promise<unknown>) => {
  try { await p; return { code: 'NO_ERROR', message: '' }; } catch (e) {
    const x = e as { extensions?: { code?: string }; message: string };
    return { code: String(x.extensions?.code ?? 'RAW'), message: x.message };
  }
};

/** A db whose named model method fails with the pool's own timeout, everything else delegated. */
function poolFailing(model: 'agent' | 'orgMember', method: string): Context['db'] {
  return new Proxy(db, {
    get(target, prop, recv) {
      const v = Reflect.get(target, prop, recv);
      if (prop !== model) return typeof v === 'function' ? v.bind(target) : v;
      return new Proxy(v as object, {
        get: (m, p, r) => (p === method ? () => Promise.reject(poolTimeout()) : Reflect.get(m, p, r)),
      });
    },
  }) as Context['db'];
}

describe('#2258 pool-exhaustion residual (analysis; red = the proposal)', () => {
  it('P1: the owner read (before any gate) hitting a pool timeout answers the sanitized CONFLICT, not a raw error', async () => {
    const f = await fixture();
    const before = await snapshot();
    const ctx = { db: poolFailing('agent', 'findUnique'), userId: f.admin.id, roles: [], clientId: `user:${f.admin.id}` } as Context;
    const r = await outcome(compileBootPrompt(ctx, { kind: 'AGENT', agentId: f.agent.id }, { budgetMs: 2000 }));
    expect(r.code).toBe('CONFLICT');
    expect(r.message).not.toMatch(/pool|P2024|connection/i);
    expect(await snapshot()).toEqual(before);
  });

  it('P2: the pre-fence gate read hitting a pool timeout answers CONFLICT (a pool fault must not read as a refusal or as INTERNAL)', async () => {
    const f = await fixture();
    const before = await snapshot();
    const ctx = { db: poolFailing('orgMember', 'findFirst'), userId: f.admin.id, roles: [], clientId: `user:${f.admin.id}` } as Context;
    const r = await outcome(compileBootPrompt(ctx, { kind: 'AGENT', agentId: f.agent.id }, { budgetMs: 2000 }));
    expect(`${r.code}:${r.message}`).toMatch(/^CONFLICT/);
    expect(await snapshot()).toEqual(before);
  });

  it('P3 (control): an unrelated raw error is still not swallowed into CONFLICT', async () => {
    const f = await fixture();
    const ctx = {
      db: new Proxy(db, { get: (t, p, r) => (p === 'agent' ? { findUnique: () => Promise.reject(new Error('boom')) } : Reflect.get(t, p, r)) }) as Context['db'],
      userId: f.admin.id, roles: [], clientId: `user:${f.admin.id}`,
    } as Context;
    const r = await outcome(compileBootPrompt(ctx, { kind: 'AGENT', agentId: f.agent.id }, { budgetMs: 2000 }));
    expect(r.code).not.toBe('CONFLICT');
    expect(r.code).not.toBe('NO_ERROR');
  });
});
