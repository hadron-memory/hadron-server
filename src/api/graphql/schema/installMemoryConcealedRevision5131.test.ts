/**
 * #5131 (Gustav's blind delta P2 on #5147): `Node.revision` is the one KEEPS field with an explicit
 * resolver, so the drift pin cannot run it against an all-throwing database the way it runs the no-load
 * fields. This pins what it does on a concealed parent against a REAL database whose every access the
 * transaction records.
 *
 * A concealed parent exists only for a caller who fails the memory's content-read gate
 * (`concealWriteBeyondRead`). `reconciledNodeForParent` asks that same gate before any reconcile work, so for
 * that caller the field must answer the carried `revSeq` after the fast path's one fingerprint SELECT:
 * no node-table access, no `FOR UPDATE`, no history fence, and never the live row's counter. The control
 * (a reader of the same node) reaches the live row, so the pin discriminates rather than passing vacuously.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { concealedInstallNode } from './installMemory.js';
import { resolvers, type Context } from './resolvers.js';

type Access = { kind: 'model' | 'raw'; what: string };

/** A client whose $transaction hands the callback a transaction that logs every model access and raw statement. */
const recordingDb = (accesses: Access[]) => new Proxy(db, {
  get(target, prop, receiver) {
    if (prop !== '$transaction') return Reflect.get(target, prop, receiver);
    return (fn: unknown, opts?: unknown) => {
      if (typeof fn !== 'function') return (target.$transaction as (...a: unknown[]) => unknown)(fn, opts);
      return (target.$transaction as (...a: unknown[]) => unknown)((tx: typeof target) => (fn as (t: unknown) => unknown)(new Proxy(tx, {
        get(t, p, r) {
          const v = Reflect.get(t, p, r);
          if (p === '$queryRaw' || p === '$executeRaw') {
            return (strings: TemplateStringsArray | { sql?: string; strings?: string[] }, ...rest: unknown[]) => {
              const text = Array.isArray(strings) ? strings.join('?') : ((strings as { sql?: string }).sql ?? '');
              accesses.push({ kind: 'raw', what: text.replace(/\s+/g, ' ').trim() });
              return (v as (...a: unknown[]) => unknown).call(t, strings, ...rest);
            };
          }
          if (typeof p === 'string' && !p.startsWith('$') && v && typeof v === 'object') {
            return new Proxy(v as object, {
              get(m, op, mr) {
                accesses.push({ kind: 'model', what: `${p}.${String(op)}` });
                return Reflect.get(m, op, mr);
              },
            });
          }
          return v;
        },
      })), opts as never);
    };
  },
}) as typeof db;

let memoryId: string;
let nodeId: string;
let ownerId: string;
let strangerId: string;

beforeEach(async () => {
  await cleanDb(db);
  const { org } = await createDbOrgAndGraph(db, { orgName: 'rev5131', graphName: 'unused' });
  ownerId = (await db.user.create({ data: { handle: 'rev5131-owner' } })).id;
  strangerId = (await db.user.create({ data: { handle: 'rev5131-stranger' } })).id;
  const personal = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: 'rev5131:mine', name: 'mine', userId: ownerId, class: 'personal', visibility: null } as never,
  });
  memoryId = personal.id;
  nodeId = (await db.node.create({
    data: { memoryId, loc: 'prompts:lane', name: 'real title', nodeType: 'record', content: 'real content body' } as never,
  })).id;
  // Warm: run the reconcile once as the owner, so the row's fingerprint is stored (the fast path's "unchanged").
  const warmCtx = { db, userId: ownerId, roles: [] } as unknown as Context;
  await (resolvers.Node as Record<string, Function>).revision({ id: nodeId, memoryId, loc: 'prompts:lane', revSeq: 0 }, {}, warmCtx);
});

const revisionOf = (parent: unknown, ctx: Context) =>
  (resolvers.Node.revision as (p: unknown, a: unknown, c: unknown) => Promise<unknown>)(parent, {}, ctx);

describe('#5131 Node.revision on a concealed parent (the non-reader path)', () => {
  it('answers the carried revSeq with no node-row read, no row lock and no reconcile', async () => {
    const live = await db.node.findUniqueOrThrow({ where: { id: nodeId }, select: { revSeq: true } });
    const carried = live.revSeq + 40; // a counter the live row never held: the answer can only come from the parent
    const parent = concealedInstallNode({ id: nodeId, memoryId, loc: 'prompts:lane', revSeq: carried });
    const accesses: Access[] = [];
    const ctx = { db: recordingDb(accesses), userId: strangerId, roles: [] } as unknown as Context;

    expect(await revisionOf(parent, ctx)).toBe(carried);

    expect(accesses.filter((a) => a.kind === 'model' && a.what.startsWith('node.')), 'node-table model access').toEqual([]);
    expect(accesses.filter((a) => a.kind === 'model' && a.what.startsWith('nodeRevision.')), 'revision-history access').toEqual([]);
    expect(accesses.filter((a) => /FOR UPDATE/i.test(a.what)), 'a row lock').toEqual([]);
    // The one node-table touch is the fast path's fingerprint SELECT, which returns a boolean, never a column.
    const nodeSelects = accesses.filter((a) => a.kind === 'raw' && /FROM nodes/i.test(a.what));
    expect(nodeSelects).toHaveLength(1);
    expect(nodeSelects[0]!.what).toMatch(/AS unchanged/);
    // And nothing was written: the live counter stands.
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId }, select: { revSeq: true } })).revSeq).toBe(live.revSeq);
  });

  it('control: the memory owner reaches the live row through the same resolver (the pin is not vacuous)', async () => {
    const live = await db.node.findUniqueOrThrow({ where: { id: nodeId }, select: { revSeq: true } });
    const parent = { id: nodeId, memoryId, loc: 'prompts:lane', revSeq: live.revSeq };
    const accesses: Access[] = [];
    const ctx = { db: recordingDb(accesses), userId: ownerId, roles: [] } as unknown as Context;

    expect(await revisionOf(parent, ctx)).toBe(live.revSeq);
    expect(accesses.some((a) => a.kind === 'model' && a.what === 'node.findUnique'), 'a reader loads the row').toBe(true);
  });
});
