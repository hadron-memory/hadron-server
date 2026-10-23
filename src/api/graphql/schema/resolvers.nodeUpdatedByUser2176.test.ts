/**
 * #2176 — Node.updatedByUser: the human behind the last authored edit.
 *
 * Writes go through the extended Prisma client inside a request holder, exactly where every
 * real node write lands (the central stamp). The wire is read through the Node field resolver.
 * The HTTP surfaces (GraphQL, MCP, batches, impersonation) are pinned in
 * src/mcp/server.updatedByUser2176.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { emptyActor, publishActor, publishUser, requestActorStorage, runAsSystem } from '../../../lib/requestActor.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const N = resolvers.Node as any;

let u1: { id: string; handle: string };
let u2: { id: string; handle: string };
let memory: { id: string };
let node: { id: string; memoryId: string };
let n = 0;
let w1: string;
let g1: string;

const asRequest = <T>(who: { user?: string | null; worker?: string; agent?: string }, fn: () => Promise<T>) =>
  requestActorStorage.run(emptyActor(), async () => {
    if (who.user !== undefined) publishUser(who.user);
    if (who.worker || who.agent) publishActor({ workerId: who.worker ?? null, agentId: who.agent ?? null });
    return fn();
  });

const edit = (name: string) => db.node.update({ where: { id: node.id }, data: { name } });
const stamps = async () => {
  const r = await db.node.findUniqueOrThrow({ where: { id: node.id } });
  return { user: r.updatedByUserId, worker: r.updatedByWorkerId, agent: r.updatedByAgentId };
};
const wire = (c: Context = { db, roles: ['READER'] }) =>
  db.node.findUniqueOrThrow({ where: { id: node.id } }).then((r) => N.updatedByUser(r, {}, c));

beforeEach(async () => {
  await cleanDb(db);
  n += 1;
  const mk = async (h: string) => db.user.create({ data: { id: generateId(), name: h, handle: `${h}-${n}`, roles: ['READER'] }, select: { id: true, handle: true } }) as Promise<{ id: string; handle: string }>;
  u1 = await mk('ana'); u2 = await mk('ben');
  const org = await db.organization.create({ data: { id: generateId(), name: 'O', urn: `unu-${n}.example` } });
  memory = await db.memory.create({ data: { id: generateId(), organizationId: org.id, urn: `unu-${n}.example:m`, name: 'm', class: 'knowledge', visibility: 'ORGANIZATION' } });
  node = await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'a', name: 'a' } });
  g1 = (await db.agent.create({ data: { id: generateId(), urn: `unu-${n}.example:eng`, name: 'eng', organizationId: org.id } })).id;
  const app = await db.app.create({ data: { id: generateId(), name: 'Team', urn: `unu-${n}.example:team`, organizationId: org.id } });
  await db.appAgent.create({ data: { appId: app.id, agentId: g1 } });
  w1 = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId: app.id, agentId: g1, name: 'Iris', slug: 'iris' } })).id;
});

describe('the central stamp: user, worker and agent move together', () => {
  it('a user edit records the user and no worker or agent', async () => {
    await asRequest({ user: u1.id }, () => edit('1'));
    expect(await stamps()).toEqual({ user: u1.id, worker: null, agent: null });
  });

  it('user + worker session records all three; the next user-only edit clears worker and agent but keeps the user', async () => {
    await asRequest({ user: u1.id, worker: w1, agent: g1 }, () => edit('1'));
    expect(await stamps()).toEqual({ user: u1.id, worker: w1, agent: g1 });
    await asRequest({ user: u1.id }, () => edit('2'));
    expect(await stamps()).toEqual({ user: u1.id, worker: null, agent: null });
  });

  it('a different user\'s edit replaces the user', async () => {
    await asRequest({ user: u1.id }, () => edit('1'));
    await asRequest({ user: u2.id }, () => edit('2'));
    expect((await stamps()).user).toBe(u2.id);
  });

  it.each([
    ['a system job (runAsSystem)', () => runAsSystem(() => edit('sys'))],
    ['a key-only principal (no User.id)', () => asRequest({ user: null }, () => edit('key'))],
    ['a write outside any request', () => edit('bare')],
  ])('%s clears the user, worker and agent of the previous edit', async (_l, write) => {
    await asRequest({ user: u1.id, worker: w1, agent: g1 }, () => edit('1'));
    await write();
    expect(await stamps()).toEqual({ user: null, worker: null, agent: null });
  });

  it('a system write inside a user request clears only for that write', async () => {
    await asRequest({ user: u1.id }, async () => {
      await runAsSystem(() => edit('sys'));
      expect((await stamps()).user).toBeNull();
      await edit('then-user');
      expect((await stamps()).user).toBe(u1.id);
    });
  });

  it('an operational write (touches no authored field) preserves all three', async () => {
    await asRequest({ user: u1.id, worker: w1, agent: g1 }, () => edit('1'));
    await asRequest({ user: u2.id }, () => db.node.update({ where: { id: node.id }, data: { revisionContentHash: 'abc' } }));
    expect(await stamps()).toEqual({ user: u1.id, worker: w1, agent: g1 });
  });

  it('a caller-supplied value is kept, like the worker and agent stamps', async () => {
    await asRequest({ user: u1.id }, () => db.node.update({ where: { id: node.id }, data: { name: 'x', updatedByUserId: u2.id } }));
    expect((await stamps()).user).toBe(u2.id);
  });

  it('a create records no editor (updatedBy* describes edits)', async () => {
    const made = await asRequest({ user: u1.id }, () => db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: 'b', name: 'b' } }));
    expect(made.updatedByUserId).toBeNull();
  });
});

describe('Node.updatedByUser on the wire', () => {
  it('is handle + urn only', async () => {
    await asRequest({ user: u1.id }, () => edit('1'));
    const out = await wire();
    expect(Object.keys(out).sort()).toEqual(['handle', 'urn']);
    expect(out.handle).toBe(u1.handle);
  });

  it('is null for a never-edited node, a deleted user and a system edit', async () => {
    expect(await wire()).toBeNull();
    await asRequest({ user: u1.id }, () => edit('1'));
    await db.user.update({ where: { id: u1.id }, data: { deletedAt: new Date() } });
    expect(await wire()).toBeNull();
    await runAsSystem(() => edit('3'));
    expect(await wire()).toBeNull();
  });

  it('an unknown user id (no such account) is null, not an error', async () => {
    await asRequest({ user: generateId() }, () => edit('1'));
    expect(await wire()).toBeNull();
  });

  it('a slim parent without the column re-reads the LIVE row pinned to its memory', async () => {
    await asRequest({ user: u1.id }, () => edit('1'));
    const slim = { id: node.id, memoryId: memory.id };
    expect((await N.updatedByUser(slim, {}, { db, roles: ['READER'] })).handle).toBe(u1.handle);
    // wrong memory: fails closed rather than reading an unpinned row
    expect(await N.updatedByUser({ id: node.id, memoryId: generateId() }, {}, { db, roles: ['READER'] })).toBeNull();
    expect(await N.updatedByUser({ id: node.id }, {}, { db, roles: ['READER'] })).toBeNull();
  });

  it('N nodes edited by M users cost M user lookups, not N', async () => {
    const nodes = [node];
    for (let i = 0; i < 7; i++) nodes.push(await db.node.create({ data: { id: generateId(), memoryId: memory.id, loc: `x${i}`, name: 'x' } }) as never);
    for (const [i, nd] of nodes.entries()) {
      await asRequest({ user: i % 2 ? u1.id : u2.id }, () => db.node.update({ where: { id: nd.id }, data: { name: `e${i}` } }));
    }
    const rows = await db.node.findMany({ where: { memoryId: memory.id } });
    const spy = vi.spyOn(db.user, 'findFirst');
    const ctx: Context = { db, roles: ['READER'] };
    const out = await Promise.all(rows.map((r) => N.updatedByUser(r, {}, ctx)));
    expect(out.every((o) => o !== null)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('the SDL field is the same type a revision editor uses, and nullable', () => {
    expect(typeDefs).toMatch(/updatedByUser: NodeRevisionEditor\n/);
  });
});

describe('raw-SQL Node writers: the covered and the intentionally exempt (#2176 freeze evidence)', () => {
  // Every `UPDATE nodes` in src/ bypasses the central stamp. Each listed one touches no authored field
  // (or is a delete), so leaving attribution alone is correct. A new one must be added HERE, with a reason.
  const EXEMPT: Record<string, string> = {
    'src/services/embedding/enqueue.ts': 'internal4 backfill/retry change embedding obligation metadata only, never authored fields or attribution',
    'src/services/embedding/obligation.ts': 'internal4 batch reset changes embedding obligation metadata only, never authored fields or attribution',
    'src/lib/channels.ts': 'wake-stamp strip on adopting a pre-Channel row (server repair) and the soft-delete tombstone move: no authored edit',
    'src/api/graphql/schema/resolvers.specCorpus.ts': 'mint columns only: operational, already stamps minted_by',
  };
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === 'generated' || f === 'node_modules' ? [] : walk(p);
    return /\.ts$/.test(f) && !/\.test\.ts$/.test(f) ? [p] : [];
  });

  it('no UPDATE nodes statement exists outside the exempt list', () => {
    const offenders = walk('src')
      .filter((p) => /UPDATE\s+"?nodes"?\b/i.test(readFileSync(p, 'utf8')))
      .filter((p) => !(p in EXEMPT));
    expect(offenders).toEqual([]);
  });

  it('the exempt list names files that still contain one (no stale entries)', () => {
    for (const p of Object.keys(EXEMPT)) expect(/UPDATE\s+"?nodes"?\b/i.test(readFileSync(p, 'utf8')), p).toBe(true);
  });
});
