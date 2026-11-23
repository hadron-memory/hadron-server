/**
 * #4914 (follow-up of #433): the two storage facts FR_026_DISCLOSURE states, pinned on what the embed writers store.
 *   - an index that includes content passages stores each chunk's verbatim text, unencrypted, in
 *     node_embeddings.chunk_text (the abstract row beside it stores none);
 *   - an abstract-only index stores no text at all.
 *
 * The write goes through createNode on an encrypted, acknowledged memory with its key cached, and the plaintext prompt
 * the write hands to the embedding dispatcher does the embedding. drainEmbeddingQueue cannot drive these pins: its
 * selector excludes encrypted memories (R132), because a keyless sweep holds no plaintext.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../helpers.js';
import { generateId } from '../../lib/id.js';
import { chunkNode } from '../../lib/chunking.js';
import { generateDataKey, isCiphertext, parseDataKey } from '../../lib/crypto.js';
import { resetEmbeddingClientForTests, setEmbeddingClientForTests } from '../../lib/embedding/index.js';
import { sessionKeyCache } from '../../lib/sessionKeyCache.js';
import { embeddingDispatcher } from '../../jobs/embedNodes.js';
import { resolvers, type Context as GqlContext } from '../../api/graphql/schema/resolvers.js';

const DIM = 768;
const CHUNK = { chunkTokens: 16, chunkOverlap: 4 };
const ABSTRACT = 'Abstract sentinel 4914.';
// Several passages, with non-ASCII text, quotes, inner line breaks and edge whitespace: "verbatim" means none is altered.
const CONTENT = `  Für 4914: “first” passage, it's here.\n\n${'Zażółć gęślą jaźń; second passage 🙂 runs on. '.repeat(4)}\n\tlast passage\\ends with spaces.  \n`;

// Each provider call answers with its own vector, so a re-embed that wrote shows in the stored row.
let calls = 0;
const embed = vi.fn(async (texts: string[]) => {
  calls += 1;
  return texts.map(() => [1, calls, ...new Array<number>(DIM - 2).fill(0)]);
});
let ctx: GqlContext;
let orgId: string;

const idle = () => vi.waitFor(
  () => expect(embeddingDispatcher(db).state()).toMatchObject({ active: 0, selecting: false, scheduled: false, dirty: false }),
  { timeout: 10_000 },
);

beforeEach(async () => {
  await cleanDb(db);
  sessionKeyCache.clear();
  embed.mockClear();
  calls = 0;
  vi.stubEnv('EMBEDDING_API_URL', 'http://stub.invalid/api/embed');
  setEmbeddingClientForTests({ provider: 'test', model: 'stub-4914', dim: DIM, embed });
  const org = await db.organization.create({ data: { id: generateId(), name: 'embed4914', urn: 'embed4914' } });
  const admin = await db.user.create({ data: { id: generateId(), handle: 'embed4914', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  orgId = org.id;
  ctx = { db, roles: ['ADMIN'], userId: admin.id };
});

afterEach(async () => {
  await idle();
  resetEmbeddingClientForTests();
  sessionKeyCache.clear();
  vi.unstubAllEnvs();
});

/** Write one node into an encrypted memory acknowledged for `embeddingSource`; return the vector rows the embed stored. */
async function embedInto(embeddingSource: 'abstract' | 'contentChunks' | 'both') {
  const memory = await resolvers.Mutation.createMemory({}, { orgRef: orgId, name: `embed-${embeddingSource.toLowerCase()}` }, ctx);
  // Encrypted and not yet indexed, set directly: the case in which updateMemory asks for the acknowledgement. The writes
  // below read the cached key by memory id alone, so any valid data key serves.
  await db.memory.update({ where: { id: memory.id }, data: { vectorIndexEnabled: false, isEncrypted: true } });
  const updated = await resolvers.Mutation.updateMemory(
    {},
    { ref: memory.id, vectorIndexEnabled: true, embeddingSource, ...CHUNK, forceFixedSize: true, acknowledgeVectorInversionRisk: true },
    ctx,
  );
  expect(updated.vectorIndexEncryptedAckAt, 'the risk is acknowledged').not.toBeNull();
  sessionKeyCache.set('embed4914', memory.id, parseDataKey(generateDataKey().raw.toString('base64')));
  // The dispatcher (one per process) admits a fresh prompt only when no sweep is due; a refused prompt is dropped, not
  // queued. No timer makes one due here: the worker loop starts with the server (src/server.ts), which this file never builds, so only writes and their jobs nudge it.
  await idle();

  const { id: nodeId } = await resolvers.Mutation.createNode(
    {},
    { input: { memoryId: memory.id, loc: 'secret', name: 'secret', content: CONTENT, abstract: ABSTRACT } } as never,
    ctx,
  );
  await idle();

  const node = await db.node.findUniqueOrThrow({ where: { id: nodeId } });
  expect(isCiphertext(node.content), 'the node is encrypted at rest').toBe(true);
  expect(isCiphertext(node.abstract), 'its abstract too').toBe(true);
  expect(node.embeddingWorkToken, 'the embed completed').toBeNull();
  expect(node.embeddingError).toBeNull();
  return { nodeId, rows: await storedRows(nodeId) };
}

const storedRows = (nodeId: string) => db.nodeEmbedding.findMany({
  where: { nodeId },
  orderBy: [{ kind: 'asc' }, { chunkIndex: 'asc' }],
  select: { kind: true, chunkIndex: true, charStart: true, charEnd: true, chunkText: true },
});

async function abstractVector(nodeId: string): Promise<{ id: string; second: number }> {
  const [row] = await db.$queryRaw<{ id: string; v: string }[]>`
    SELECT id, embedding::text AS v FROM node_embeddings WHERE node_id = ${nodeId} AND kind = 'abstract'`;
  return { id: row!.id, second: (JSON.parse(row!.v) as number[])[1]! };
}

describe('#4914 what the embed writers store in chunk_text for an encrypted, acknowledged memory', () => {
  it.each(['contentChunks', 'both'] as const)('%s: every chunk row holds its passage verbatim, and an abstract row holds none', async (source) => {
    const { rows } = await embedInto(source);
    const expected = chunkNode(CONTENT, { ...CHUNK, forceFixedSize: true });
    expect(expected.length, 'several passages').toBeGreaterThan(2);

    const chunks = rows.filter((r) => r.kind === 'chunk');
    expect(chunks.map((r) => r.chunkText)).toEqual(expected.map((c) => c.text));
    // Against the written content itself, independent of the chunker's own `text`.
    for (const r of chunks) {
      expect([r.charStart, r.charEnd]).toEqual([expect.any(Number), expect.any(Number)]);
      expect(r.chunkText).toBe(CONTENT.slice(r.charStart!, r.charEnd!));
    }
    // and to the provider, the same passages
    expect(embed.mock.calls.flatMap(([texts]) => texts)).toEqual([...(source === 'both' ? [ABSTRACT] : []), ...expected.map((c) => c.text)]);

    const nonChunkRows = rows.filter((r) => r.kind !== 'chunk').map(({ kind, chunkText }) => ({ kind, chunkText }));
    expect(nonChunkRows).toEqual(source === 'both' ? [{ kind: 'abstract', chunkText: null }] : []);
  });

  it('abstract: the one row is the abstract vector, and no text is stored', async () => {
    const { nodeId, rows } = await embedInto('abstract');
    const onlyAbstract = [{ kind: 'abstract', chunkIndex: null, charStart: null, charEnd: null, chunkText: null }];
    expect(rows).toEqual(onlyAbstract);

    const before = await abstractVector(nodeId);
    // A re-embed takes the writer's ON CONFLICT branch, which must store none either.
    await resolvers.Mutation.updateNode({}, { input: { id: nodeId, abstract: `${ABSTRACT} Edited.` } } as never, ctx);
    await idle();
    expect((await db.node.findUniqueOrThrow({ where: { id: nodeId } })).embeddingWorkToken, 'the re-embed completed').toBeNull();
    expect(await storedRows(nodeId)).toEqual(onlyAbstract);
    const after = await abstractVector(nodeId);
    expect(after.id, 'the same row, updated in place').toBe(before.id);
    expect([before.second, after.second], 'holding the second call\'s vector').toEqual([1, 2]);
    expect(embed.mock.calls.flatMap(([texts]) => texts), 'only the abstracts were embedded').toEqual([ABSTRACT, `${ABSTRACT} Edited.`]);
  });
});
