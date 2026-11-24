/**
 * #5018 (Billing A14, hrn:node:hadronmemory.com:specs:cor:dmo:060:18): a node's recorded size. `nodes.stored_bytes` (the node's current
 * state) and `nodes.revision_bytes` (the same figure summed over its rows in `node_revisions`) are kept right by triggers in the
 * database, not by the writers. The columns are read with raw SQL: `revision_bytes` is a BigInt that the client leaves out of every
 * full-row read.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from './id.js';
import { createNodeRevision } from './nodeRevisionSnapshot.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { encryptWithSecret } from '../test/encryptMemoryWithSecret.js';

let orgId: string;
let ownerId: string;
let memoryId: string;
let seq = 0;

type Bytes = { stored: number | null; revision: bigint | null };
const bytes = async (nodeId: string): Promise<Bytes> => {
  const [row] = await db.$queryRaw<Array<{ stored: number | null; revision: bigint | null }>>`
    SELECT stored_bytes AS stored, revision_bytes AS revision FROM nodes WHERE id = ${nodeId}`;
  return row;
};
/** What the two figures must be, worked out from the rows with no trigger in the way (the backfill's own arithmetic). */
const recomputed = async (nodeId: string): Promise<{ stored: number; revision: bigint }> => {
  const [row] = await db.$queryRaw<Array<{ stored: number; revision: bigint }>>`
    SELECT (COALESCE(octet_length(n.content), 0) + COALESCE(octet_length(n.description), 0)
            + COALESCE(octet_length(n.data::text), 0) + COALESCE(octet_length(n.properties::text), 0))::int AS stored,
           COALESCE((SELECT sum(COALESCE(octet_length(r.content), 0) + COALESCE(octet_length(r.description), 0)
                              + COALESCE(octet_length(r.data::text), 0) + COALESCE(octet_length(r.properties::text), 0))
                     FROM node_revisions r WHERE r.node_id = n.id), 0)::bigint AS revision
    FROM nodes n WHERE n.id = ${nodeId}`;
  return row;
};
const mkNode = (data: Record<string, unknown> = {}, mem = memoryId) =>
  db.node.create({ data: { id: generateId(), memoryId: mem, loc: `n-${++seq}`, name: 'n', ...data } as never });
/** A revision of the node's CURRENT state, taken through the one writer every revision site uses. */
const snapshot = async (nodeId: string, tx: Pick<typeof db, 'node' | 'nodeRevision' | 'memory' | 'nodeSignature' | '$queryRaw'> = db) => {
  const n = await tx.node.findUniqueOrThrow({ where: { id: nodeId } });
  await createNodeRevision(tx, {
    nodeId, memoryId: n.memoryId, loc: n.loc, name: n.name, description: n.description, content: n.content,
    // A missing data/properties is left out, not stored as the JSON text `null` (which would count 4 bytes).
    ...(n.data === null ? {} : { data: n.data as never }), ...(n.properties === null ? {} : { properties: n.properties as never }),
    nodeType: n.nodeType, tags: [],
  } as never);
};
const adminCtx = (): Context => ({ db, userId: ownerId, roles: ['ADMIN'] });

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'nb', urn: 'nb5018' } });
  orgId = org.id;
  ownerId = (await db.user.create({ data: { id: generateId(), handle: 'nb-owner' } })).id;
  await db.orgMember.create({ data: { organizationId: orgId, userId: ownerId, role: 'OWNER' } });
  memoryId = (await db.memory.create({ data: { id: generateId(), name: 'm', urn: 'nb5018:m', class: 'knowledge', organizationId: orgId } as never })).id;
});

describe('#5018 stored_bytes is recorded for the four fields, in bytes', () => {
  it('one three-byte character of content is 3 bytes, not 1 character', async () => {
    const n = await mkNode({ content: '€' });
    expect((await bytes(n.id)).stored).toBe(3);
  });

  it('100 bytes of data (as stored text), description and properties count the same way', async () => {
    const data = await mkNode({ data: 'x'.repeat(98) });
    expect((await bytes(data.id)).stored).toBe(100);
    const description = await mkNode({ description: 'd'.repeat(7) });
    expect((await bytes(description.id)).stored).toBe(7);
    const properties = await mkNode({ properties: 'p'.repeat(8) });
    expect((await bytes(properties.id)).stored).toBe(10);
  });

  it('the four fields add; a node with none stores 0, not null', async () => {
    const n = await mkNode({ content: 'abc', description: 'de', data: 'f', properties: 'g' });
    expect((await bytes(n.id)).stored).toBe(3 + 2 + 3 + 3);
    expect((await bytes((await mkNode()).id)).stored).toBe(0);
  });

  it('a new node has revision_bytes 0, not null', async () => {
    expect((await bytes((await mkNode({ content: 'abc' })).id)).revision).toBe(0n);
  });

  it('an update of any of the four fields re-records it; a raw UPDATE of data (the chat-root counter path) does too', async () => {
    const n = await mkNode({ content: 'abc' });
    await db.node.update({ where: { id: n.id }, data: { content: 'abcdef' } });
    expect((await bytes(n.id)).stored).toBe(6);
    await db.$executeRaw`UPDATE nodes SET data = '"0123456789"'::jsonb WHERE id = ${n.id}`;
    expect((await bytes(n.id)).stored).toBe(6 + 12);
  });

  it('an update that touches none of the four fields leaves stored_bytes as it was', async () => {
    const n = await mkNode({ content: 'abc' });
    await db.$executeRaw`UPDATE nodes SET stored_bytes = 99 WHERE id = ${n.id}`;
    await db.node.update({ where: { id: n.id }, data: { tags: ['t'], loc: `moved-${++seq}`, name: 'renamed' } });
    expect((await bytes(n.id)).stored).toBe(99);
  });
});

describe('#5018 revision_bytes follows the node_revisions rows', () => {
  it('a revision adds the old state size', async () => {
    const n = await mkNode({ content: 'abc', description: 'de' });
    await snapshot(n.id);
    expect((await bytes(n.id)).revision).toBe(5n);
    await db.node.update({ where: { id: n.id }, data: { content: 'abcdefgh' } });
    await snapshot(n.id);
    expect((await bytes(n.id)).revision).toBe(5n + 10n);
    expect(await bytes(n.id)).toMatchObject(await recomputed(n.id));
  });

  it('pruning the oldest revision (maxRevCount 1) lowers it', async () => {
    await db.memory.update({ where: { id: memoryId }, data: { maxRevCount: 1 } });
    const n = await mkNode({ content: 'abc' });
    await snapshot(n.id);
    await db.node.update({ where: { id: n.id }, data: { content: 'abcdefgh' } });
    await snapshot(n.id);
    expect(await db.nodeRevision.count({ where: { nodeId: n.id } })).toBe(1);
    expect((await bytes(n.id)).revision).toBe(8n);
  });

  it('deleteNodeRevision lowers it and clearNodeHistory takes it to 0', async () => {
    const n = await mkNode({ content: 'abc' });
    await snapshot(n.id);
    await db.node.update({ where: { id: n.id }, data: { content: 'abcdefgh' } });
    await snapshot(n.id);
    const [first] = await db.nodeRevision.findMany({ where: { nodeId: n.id }, orderBy: { revNo: 'asc' } });
    await resolvers.Mutation.deleteNodeRevision(null, { nodeRevRef: first.id }, adminCtx());
    expect((await bytes(n.id)).revision).toBe(8n);
    await resolvers.Mutation.clearNodeHistory(null, { nodeRef: n.id }, adminCtx());
    expect((await bytes(n.id)).revision).toBe(0n);
  });

  it('a revision rewritten in place changes it by the difference', async () => {
    const n = await mkNode({ content: 'abc' });
    await snapshot(n.id);
    await db.$executeRaw`UPDATE node_revisions SET content = 'abcdefghij' WHERE node_id = ${n.id}`;
    expect((await bytes(n.id)).revision).toBe(10n);
  });

  it('an update of a revision column that is not measured changes nothing (a label, an approval hash clear)', async () => {
    const n = await mkNode({ content: 'abc' });
    await snapshot(n.id);
    await db.$executeRaw`UPDATE node_revisions SET rev_label = 'a label', approval_hash = NULL WHERE node_id = ${n.id}`;
    expect((await bytes(n.id)).revision).toBe(3n);
  });

  it('a node that is not measured yet stays not measured when a revision arrives', async () => {
    const n = await mkNode({ content: 'abc' });
    await db.$executeRaw`UPDATE nodes SET revision_bytes = NULL WHERE id = ${n.id}`;
    await snapshot(n.id);
    expect((await bytes(n.id)).revision).toBeNull();
  });

  it('a node that is not measured yet stays not measured when a revision is deleted or rewritten (never 0)', async () => {
    const n = await mkNode({ content: 'abc' });
    await snapshot(n.id);
    await snapshot(n.id);
    await db.$executeRaw`UPDATE nodes SET revision_bytes = NULL WHERE id = ${n.id}`;
    await db.$executeRaw`UPDATE node_revisions SET content = 'abcdef' WHERE node_id = ${n.id} AND rev_no = (SELECT min(rev_no) FROM node_revisions WHERE node_id = ${n.id})`;
    expect((await bytes(n.id)).revision).toBeNull();
    await db.$executeRaw`DELETE FROM node_revisions WHERE node_id = ${n.id}`;
    expect((await bytes(n.id)).revision).toBeNull();
  });

  it('a revision edit that touches none of the measured fields does not even update the node row', async () => {
    const n = await mkNode({ content: 'abc' });
    await snapshot(n.id);
    const xmin = async () => (await db.$queryRaw<Array<{ x: string }>>`SELECT xmin::text AS x FROM nodes WHERE id = ${n.id}`)[0]!.x;
    const before = await xmin();
    await db.$executeRaw`UPDATE node_revisions SET rev_label = 'a label' WHERE node_id = ${n.id}`;
    expect(await xmin()).toBe(before);
  });

  it('a moved node keeps its revision_bytes, which then counts for the new memory', async () => {
    const other = await db.memory.create({ data: { id: generateId(), name: 'o', urn: 'nb5018:o', class: 'knowledge', organizationId: orgId } as never });
    const n = await mkNode({ content: 'abc' });
    await snapshot(n.id);
    await db.node.update({ where: { id: n.id }, data: { memoryId: other.id, loc: `moved-${++seq}` } });
    expect((await bytes(n.id)).revision).toBe(3n);
  });
});

describe('#5018 the trigger bodies are schema-qualified (#5089)', () => {
  it('a session temp table named nodes cannot take the revision update away from the real nodes row', async () => {
    const n = await mkNode({ content: 'abc' });
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('CREATE TEMP TABLE nodes (id text, revision_bytes bigint) ON COMMIT DROP');
      await tx.$executeRawUnsafe(`INSERT INTO pg_temp.nodes VALUES ('${n.id}', 100)`);
      await snapshot(n.id, tx as never);
      const [shadow] = await tx.$queryRawUnsafe<Array<{ revision_bytes: bigint }>>('SELECT revision_bytes FROM pg_temp.nodes');
      expect(shadow!.revision_bytes).toBe(100n);
    });
    expect((await bytes(n.id)).revision).toBe(3n);
  });
});

describe('#5018 deleting rows the triggers watch', () => {
  it('hard-deleting a node with revisions, and a memory with nodes, succeeds', async () => {
    const n = await mkNode({ content: 'abc' });
    await snapshot(n.id);
    await db.node.delete({ where: { id: n.id } });
    expect(await db.nodeRevision.count({ where: { nodeId: n.id } })).toBe(0);
    const m = await db.memory.create({ data: { id: generateId(), name: 'gone', urn: 'nb5018:gone', class: 'knowledge', organizationId: orgId } as never });
    const inM = await mkNode({ content: 'abc' }, m.id);
    await snapshot(inM.id);
    await db.memory.delete({ where: { id: m.id } });
    expect(await db.node.count({ where: { memoryId: m.id } })).toBe(0);
  });
});

describe('#5018 encrypting a memory records the stored (ciphertext) sizes', () => {
  it('both figures equal what a recomputation from the rows gives', async () => {
    const dataKey = Buffer.alloc(32, 7).toString('base64');
    const priv = await db.memory.create({ data: { id: generateId(), name: 'p', urn: 'nb5018:p', class: 'private', organizationId: orgId, userId: ownerId } as never });
    const n = await mkNode({ content: 'plain content here', description: 'a description' }, priv.id);
    await snapshot(n.id);
    const before = await bytes(n.id);
    await encryptWithSecret({}, { memoryRef: priv.id, dataKey }, { db, userId: ownerId, roles: ['READER'] } as Context);
    const after = await bytes(n.id);
    expect(after.stored).toBeGreaterThan(before.stored!);
    expect(after.revision).toBeGreaterThan(before.revision!);
    expect(after).toMatchObject(await recomputed(n.id));
  });
});
