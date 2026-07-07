/**
 * plan-multi-node §5 + §8 step 2 — edge selection for the flow walker.
 *
 * Pins:
 *   - D-MN-4: only `next*`-named edges route; `documents`/`depends-on`
 *     (condition-less, therefore "always firing") never do.
 *   - D7 ordering: priority ASC, then numeric <index> (numeric, not
 *     lexical — next.2 before next.10), then loc lexical.
 *   - Condition semantics: null = fall-through; false skips to the next
 *     candidate; view fields resolve at message.data.*.
 *   - Unevaluable condition → EdgeConditionEvalError (run fails loud).
 *   - No firing edge → null (the flow's normal end).
 *   - Unnamed edges route via the derived-loc name segment.
 *   - Deleted edges/targets are invisible.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { deriveEdgeLoc } from '../edgeLoc.js';
import {
  selectNextEdge,
  EdgeConditionEvalError,
  isRoutingName,
  type FlowSourceNode,
} from './selectNextEdge.js';

let orgId: string;
let memoryId: string;
let source: FlowSourceNode;

async function makeNode(loc: string): Promise<string> {
  const node = await db.node.create({
    data: { id: generateId(), memoryId, loc, name: loc, tags: [] },
  });
  return node.id;
}

async function makeEdge(args: {
  targetId: string;
  name?: string | null;
  condition?: unknown;
  priority?: number;
  loc?: string;
}) {
  return db.edge.create({
    data: {
      id: generateId(),
      memoryId,
      sourceId: source.id,
      targetId: args.targetId,
      name: args.name === null ? null : (args.name ?? 'next'),
      loc:
        args.loc ??
        deriveEdgeLoc('flow:classify', args.name ?? 'next', `t-${args.targetId.slice(0, 8)}`),
      condition: (args.condition ?? undefined) as never,
      priority: args.priority ?? 0,
    },
  });
}

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({
    data: { id: generateId(), name: 'walk-org', urn: 'walk-org' },
  });
  orgId = org.id;
  const memory = await db.memory.create({
    data: {
      id: generateId(), organizationId: orgId, name: 'flowmem',
      urn: 'walk-org:flowmem', class: 'knowledge',
    },
  });
  memoryId = memory.id;
  const sourceId = await makeNode('flow:classify');
  source = {
    id: sourceId,
    memoryId,
    loc: 'flow:classify',
    urn: 'walk-org::flowmem::flow:classify',
  };
});

describe('isRoutingName (D-MN-4 grammar)', () => {
  it('accepts next / next.<index> / next.<index>.<name> / next.<name>', () => {
    for (const n of ['next', 'next.1', 'next.1.high', 'next.high']) {
      expect(isRoutingName(n)).toBe(true);
    }
  });
  it('rejects everything else — including lookalikes', () => {
    for (const n of ['documents', 'depends-on', 'nexus', 'nextish', 'pre-next', '']) {
      expect(isRoutingName(n)).toBe(false);
    }
  });
});

describe('selectNextEdge', () => {
  it('follows an unconditional next edge and composes a walkable target URN', async () => {
    const act = await makeNode('flow:act');
    await makeEdge({ targetId: act });
    const sel = await selectNextEdge(db, { sourceNode: source, view: {} });
    expect(sel).not.toBeNull();
    expect(sel!.targetUrn).toBe('walk-org::flowmem::flow:act');
  });

  it('a documents edge with no condition NEVER routes (D-MN-4)', async () => {
    const dep = await makeNode('reference:manual');
    await makeEdge({ targetId: dep, name: 'documents' });
    expect(await selectNextEdge(db, { sourceNode: source, view: {} })).toBeNull();
  });

  it('branches on a message.data.* condition against the view', async () => {
    const act = await makeNode('flow:act');
    const defer = await makeNode('flow:defer');
    await makeEdge({
      targetId: act,
      name: 'next.1.high',
      condition: { '>': [{ var: 'message.data.confidence' }, 0.8] },
    });
    await makeEdge({ targetId: defer, name: 'next.2.low' }); // fall-through

    const high = await selectNextEdge(db, { sourceNode: source, view: { confidence: 0.92 } });
    expect(high!.targetUrn).toBe('walk-org::flowmem::flow:act');

    const low = await selectNextEdge(db, { sourceNode: source, view: { confidence: 0.4 } });
    expect(low!.targetUrn).toBe('walk-org::flowmem::flow:defer');
  });

  it('orders by numeric index, not lexical (next.2 before next.10)', async () => {
    const second = await makeNode('flow:second');
    const tenth = await makeNode('flow:tenth');
    await makeEdge({ targetId: tenth, name: 'next.10' });
    await makeEdge({ targetId: second, name: 'next.2' });
    const sel = await selectNextEdge(db, { sourceNode: source, view: {} });
    expect(sel!.targetUrn).toBe('walk-org::flowmem::flow:second');
  });

  it('priority beats index (lower fires first — schema convention)', async () => {
    const a = await makeNode('flow:a');
    const b = await makeNode('flow:b');
    await makeEdge({ targetId: a, name: 'next.1', priority: 5 });
    await makeEdge({ targetId: b, name: 'next.9', priority: 1 });
    const sel = await selectNextEdge(db, { sourceNode: source, view: {} });
    expect(sel!.targetUrn).toBe('walk-org::flowmem::flow:b');
  });

  it('an indexless routing name sorts after indexed ones', async () => {
    const indexed = await makeNode('flow:indexed');
    const bare = await makeNode('flow:bare');
    await makeEdge({ targetId: bare, name: 'next' });
    await makeEdge({ targetId: indexed, name: 'next.3' });
    const sel = await selectNextEdge(db, { sourceNode: source, view: {} });
    expect(sel!.targetUrn).toBe('walk-org::flowmem::flow:indexed');
  });

  it('an unnamed edge routes via the derived-loc name segment', async () => {
    const act = await makeNode('flow:act');
    await makeEdge({
      targetId: act,
      name: null,
      loc: deriveEdgeLoc('flow:classify', 'next', 'flow:act'),
    });
    const sel = await selectNextEdge(db, { sourceNode: source, view: {} });
    expect(sel!.targetUrn).toBe('walk-org::flowmem::flow:act');
  });

  it('returns null when every condition is false (normal flow end, D7)', async () => {
    const act = await makeNode('flow:act');
    await makeEdge({
      targetId: act,
      condition: { '==': [{ var: 'message.data.go' }, true] },
    });
    expect(await selectNextEdge(db, { sourceNode: source, view: { go: false } })).toBeNull();
  });

  it('an unevaluable condition throws EdgeConditionEvalError (fail loud, D15-sub)', async () => {
    const act = await makeNode('flow:act');
    await makeEdge({
      targetId: act,
      condition: { frobnicate: [{ var: 'message.data.x' }, 1] }, // unknown operator
    });
    await expect(selectNextEdge(db, { sourceNode: source, view: {} })).rejects.toBeInstanceOf(
      EdgeConditionEvalError,
    );
  });

  it('soft-deleted edges and dead targets are invisible to routing', async () => {
    const act = await makeNode('flow:act');
    const gone = await makeNode('flow:gone');
    const e = await makeEdge({ targetId: gone, name: 'next.1' });
    await db.edge.update({ where: { id: e.id }, data: { deletedAt: new Date() } });
    const e2 = await makeEdge({ targetId: act, name: 'next.2' });
    void e2;
    const deadTarget = await makeNode('flow:dead');
    await makeEdge({ targetId: deadTarget, name: 'next.0' }); // would win by index…
    await db.node.update({ where: { id: deadTarget }, data: { deletedAt: new Date() } });
    const sel = await selectNextEdge(db, { sourceNode: source, view: {} });
    expect(sel!.targetUrn).toBe('walk-org::flowmem::flow:act');
  });

  it('cross-memory edges compose the target URN from the TARGET memory', async () => {
    const other = await db.memory.create({
      data: {
        id: generateId(), organizationId: orgId, name: 'othermem',
        urn: 'walk-org:othermem', class: 'knowledge',
      },
    });
    const target = await db.node.create({
      data: { id: generateId(), memoryId: other.id, loc: 'flow:elsewhere', name: 'x', tags: [] },
    });
    await makeEdge({ targetId: target.id });
    const sel = await selectNextEdge(db, { sourceNode: source, view: {} });
    expect(sel!.targetUrn).toBe('walk-org::othermem::flow:elsewhere');
  });
});
