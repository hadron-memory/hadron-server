/**
 * #992 (cor:agt:020:04) — per-chat seq uniqueness as a DATABASE constraint,
 * the Slice 1 red-first matrix from the issue body.
 *
 * The allocator half (max-of-counter absorption, soft-delete monotonicity,
 * the #998 summary allowlist) is pinned in chatRoot.test.ts's `#992` block —
 * these pins are the CONSTRAINT half and its legality envelope:
 *
 *  1. a duplicate (chat, seq) through the eligible writer/storage paths is
 *     refused atomically — live first message, SOFT-DELETED first message,
 *     and a concurrent race;
 *  2. equal numbers stay legal in different chats; ordinary chatbot `record`
 *     transcripts keep cor:cht:050:02's colliding-seq legality; counterless
 *     messages, `abstract` summary artifacts and foreign non-chat-message
 *     nodes are not swept in;
 *  4. the migration preflight reports existing canonical collisions and
 *     refuses safely; after a synthetic-fixture repair it installs; the
 *     shared SQL is verbatim in the migration and \ir'd by post-push.
 *
 * The constraint keys on the loc-derived chat identity
 * (memory_id, split_part(loc, ':messages:', 1)) — the SAME classification
 * every transcript reader uses — never on `message_channel_id`: the #1430
 * backfill and the adoption sweep both skip soft-deleted rows, clones carry
 * no stamp at all, and a chat that predates its Channel row has none either,
 * so a stamp-keyed constraint would be vacuous against exactly the
 * direct-write corruption class that produced this issue.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { Client } from 'pg';
import { GraphQLError } from 'graphql';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { Prisma } from '../generated/prisma/index.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { TEAM_CHAT_LOC } from '../api/graphql/schema/resolvers.teamChat.js';
import { ensureChannelRow } from '../lib/channels.js';
import { isChatSeqUniqueViolation } from '../lib/prismaErrors.js';

const M = resolvers.Mutation as any;

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const INVARIANTS_SQL = read('../../prisma/chat-seq-invariants.sql');
const INDEX_NAME = 'nodes_chat_message_seq_unique_idx';

function ctx(userId?: string): Context {
  return { db, userId, appId: undefined, roles: ['READER'] };
}

async function expectCode(p: Promise<unknown>, code: string) {
  try {
    await p;
    expect.fail(`expected rejection with extensions.code=${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    expect((e as GraphQLError).extensions?.code).toBe(code);
  }
}

/** The raw P2002 the storage layer raises for a taken (chat, seq). */
async function expectUniqueViolation(p: Promise<unknown>) {
  try {
    await p;
    expect.fail('expected a unique violation');
  } catch (e) {
    expect(e).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((e as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
  }
}

/** The app-class shared memory the first team post bootstrapped the chat in.
 * Resolved through the Channel row: the legacy fixture also has a root at
 * loc `chats:team` in ITS memory, and identity is (memory, root). */
async function teamChatMemId(): Promise<string> {
  const channel = await db.channel.findFirstOrThrow({ select: { chatRootNodeId: true } });
  const root = await db.node.findUniqueOrThrow({ where: { id: channel.chatRootNodeId }, select: { memoryId: true } });
  return root.memoryId;
}

let org: { id: string; urn: string };
let admin: { id: string };
let appMember: { id: string };
let teamAgent: { id: string; urn: string; systemMemoryId: string };
let app: { id: string; urn: string };
/** A legacy chat shape with NO Channel row: root + messages in a plain
 * knowledge memory — the unchanneled prefix the protected-loc gate cannot
 * cover, which is why the constraint (not the gate) is the backstop there. */
let legacyMem: { id: string; urn: string };

const post = (c: Context, body: string) =>
  M.createTeamChatMessage({}, { appRef: app.id, body }, c);

/** A canonical-shaped message row placed by a non-append writer (the
 * clone/import/bulk-load storage class from the original repro). */
async function seedMessage(
  memoryId: string,
  seq: number | null,
  opts: { deleted?: boolean; nodeType?: string; loc?: string } = {},
) {
  const msgNum = String(seq ?? 0).padStart(3, '0');
  const id = generateId();
  await db.node.create({
    data: {
      id,
      memoryId,
      loc: opts.loc ?? `${TEAM_CHAT_LOC}:messages:${msgNum}-${generateId().slice(-8)}`,
      name: `${msgNum}-seeded`,
      nodeType: opts.nodeType ?? 'chat-message',
      content: 'seeded',
      seq,
      ...(opts.deleted ? { deletedAt: new Date(), deletedBy: 'seed' } : {}),
    },
  });
  return id;
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'csq-org', urn: `csq-org-${suffix}.com` },
  });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 93901, githubUsername: `csq-admin-${suffix}`, roles: ['READER'] },
  });
  appMember = await db.user.create({
    data: { id: generateId(), githubId: 93903, githubUsername: `csq-member-${suffix}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  // The Team Agent through the real mutation so it owns a real system memory.
  const created = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  teamAgent = { id: created.id, urn: created.urn, systemMemoryId: created.systemMemoryId };
  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'Team App', urn: `${org.urn}:team` },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: appMember.id, role: 'member' } });

  legacyMem = await M.createMemory({}, { orgId: org.id, name: 'csq-legacy' }, ctx(admin.id));
  await db.node.create({
    data: {
      id: generateId(), memoryId: legacyMem.id, loc: TEAM_CHAT_LOC,
      name: 'team', nodeType: 'chat', createdBy: admin.id, data: { messageCount: 3 },
    },
  });
});

describe('#2622 — the seat findings (fix head)', () => {
  // Riana §10 P2, reproduced at 049674ad: a chat root whose loc CONTAINS a
  // `messages` segment folds its posts into an ANCESTOR's index identity while
  // the allocator scans the root's own `<root>:messages:` prefix — the index
  // then refuses posts the allocator cannot see colliding, forever (soft
  // delete does not clear it; the constraint counts tombstones by design).
  // The fix reserves the segment at the address boundary: no Channel may TAKE
  // or ADOPT an address containing one, so the index's first-separator
  // identity and the allocator's prefix can never disagree. The index itself
  // is unchanged — first-separator identity stays the reader's prefix view.
  it("refuses a Channel address containing a 'messages' segment (LOC_RESERVED_SEGMENT)", async () => {
    await expectCode(
      M.createChannel({}, { input: { memoryRef: legacyMem.urn, loc: 'ops:messages:alerts', name: 'alerts' } }, ctx(admin.id)),
      'LOC_RESERVED_SEGMENT',
    );
  });

  it("refuses ADOPTING an existing 'messages'-bearing root (ensureChannelRow — the backfill door)", async () => {
    const rootId = generateId();
    await db.node.create({
      data: { id: rootId, memoryId: legacyMem.id, loc: 'foo:messages:bar', name: 'adopt me', nodeType: 'chat', createdBy: admin.id },
    });
    await expectCode(
      ensureChannelRow(db, { rootId, memoryId: legacyMem.id, loc: 'foo:messages:bar', name: 'x', createdBy: admin.id }),
      'LOC_RESERVED_SEGMENT',
    );
  });

  it('clean sibling channels keep distinct seq spaces, and a planted seq does not deny posts (the merge shape, corrected)', async () => {
    const alerts = await M.createChannel({}, { input: { memoryRef: legacyMem.urn, loc: 'ops:alerts', name: 'alerts' } }, ctx(admin.id));
    await M.createChannel({}, { input: { memoryRef: legacyMem.urn, loc: 'ops:incidents', name: 'incidents' } }, ctx(admin.id));
    // Equal numbers, same memory, different chats — legal (also Gene P3-2:
    // the roots differ, so a wrongly-restrictive (memory_id, seq) key would
    // have to refuse one of these).
    await seedMessage(legacyMem.id, 1, { loc: 'ops:alerts:messages:001-a' });
    await seedMessage(legacyMem.id, 1, { loc: 'ops:incidents:messages:001-b' });
    // The allocator scans the whole `<root>:messages:` prefix, so the planted
    // seq-1 row is ABSORBED, not collided with: the next real post to
    // `ops:alerts` takes seq 2 and succeeds. This is the denial shape from
    // the reproduced P2 — on 049674ad the same probe against an
    // `ops:messages:alerts` Channel refused forever.
    const posted = await M.createChannelMessage({}, { channelRef: alerts.id, body: 'no denial' }, ctx(admin.id));
    expect(posted.seq).toBe(2);
  });

  // Gizelle LOCAL P2: the typed refusal must cover the REAL writers, not only
  // the ones the first head inventoried. moveNode rebases a whole loc subtree
  // through nodeSubtreeMove — a message landing on a colliding (chat, seq)
  // there must surface as CHAT_MESSAGE_SEQ_CONFLICT, and the failed move must
  // leave both addresses exactly as they were.
  it('types the refusal for a MOVE that rebases a message into collision (and rolls back)', async () => {
    await seedMessage(legacyMem.id, 1, { loc: 'chatA:messages:001-a' });
    const moverId = await seedMessage(legacyMem.id, 1, { loc: 'chatB:messages:001-b' });
    await expectCode(
      M.moveNode({}, { sourceRef: moverId, targetUrn: `urn:node:${legacyMem.urn}:chatA:messages:001-c` }, ctx(admin.id)),
      'CHAT_MESSAGE_SEQ_CONFLICT',
    );
    const mover = await db.node.findUniqueOrThrow({ where: { id: moverId } });
    expect(mover.loc).toBe('chatB:messages:001-b');
    expect(mover.seq).toBe(1);
    expect(await db.node.findFirst({ where: { memoryId: legacyMem.id, loc: 'chatA:messages:001-c' } })).toBeNull();
  });
});

describe('#2622 — the P2002 detector is exact (Gene P3-1)', () => {
  // The real meta shape was probed on the per-worker clone: Prisma splits the
  // expression index's key list on commas, so the column spelling of
  // nodes_chat_message_seq_unique_idx is the 5-fragment array below. The
  // detector accepts exactly that (or the index NAME); anything else a P2002
  // could carry — a plain (memory_id, seq) pair, the node-loc unique, an
  // unrelated error that merely MENTIONS the index — must not type as a chat
  // conflict.
  const p2002 = (target: unknown) =>
    new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002', clientVersion: '6.19.2', meta: { target },
    } as never);

  it('accepts the two real spellings: the index name, and the split_part target array', () => {
    expect(isChatSeqUniqueViolation(p2002('nodes_chat_message_seq_unique_idx'))).toBe(true);
    expect(isChatSeqUniqueViolation(
      p2002(['memory_id', 'split_part(loc', `':messages:'::text`, '1)', 'seq']),
    )).toBe(true);
  });

  it('refuses a generic (memory_id, seq) target and the node-loc unique', () => {
    expect(isChatSeqUniqueViolation(p2002(['memory_id', 'seq']))).toBe(false);
    expect(isChatSeqUniqueViolation(p2002(['loc', 'memory_id']))).toBe(false);
  });

  it('raw fallback requires unique-violation phrasing alongside the index name', () => {
    expect(isChatSeqUniqueViolation(
      new Error('relation "nodes_chat_message_seq_unique_idx" does not exist, skipping'),
    )).toBe(false);
    expect(isChatSeqUniqueViolation(
      new Error('duplicate key value violates unique constraint "nodes_chat_message_seq_unique_idx"'),
    )).toBe(true);
  });
});

describe('#992 — the constraint refuses duplicates the allocator cannot see', () => {
  it('refuses a live duplicate (chat, seq) written through the generic storage path', async () => {
    const first = await post(ctx(appMember.id), 'first!');
    expect(first.seq).toBe(1);
    const memId = await teamChatMemId();

    // Current main accepts this silently — the exact repro shape.
    await expectUniqueViolation(seedMessage(memId, 1));
  });

  it('reserves a SOFT-DELETED message\'s seq (cor:agt:020:04 delete/revive)', async () => {
    const first = await post(ctx(appMember.id), 'first!');
    await db.node.update({ where: { id: first.nodeId }, data: { deletedAt: new Date(), deletedBy: 'test' } });
    const memId = await teamChatMemId();

    await expectUniqueViolation(seedMessage(memId, 1));
  });

  it('lets exactly one of two concurrent duplicate inserts through', async () => {
    await post(ctx(appMember.id), 'first!');
    const memId = await teamChatMemId();

    // Two racing non-append writers at the SAME fresh seq: the loser's
    // insert is refused by the constraint, atomically.
    const results = await Promise.allSettled([
      seedMessage(memId, 2),
      seedMessage(memId, 2),
    ]);
    const rejected = results.filter(
      (r) =>
        r.status === 'rejected' &&
        r.reason instanceof Prisma.PrismaClientKnownRequestError &&
        r.reason.code === 'P2002',
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it('types the refusal at the generic node door for an unchanneled chat prefix', async () => {
    await seedMessage(legacyMem.id, 3);

    // A createNode at a colliding (root, seq): on main this SUCCEEDS; the
    // constrained tree must answer a NAMED refusal, never a raw P2002
    // leaking as INTERNAL_SERVER_ERROR.
    await expectCode(
      M.createNode({}, {
        input: {
          memoryId: legacyMem.id,
          loc: `${TEAM_CHAT_LOC}:messages:003-dupe`,
          name: '003-dupe', nodeType: 'chat-message', seq: 3, content: 'dupe',
        },
      }, ctx(admin.id)),
      'CHAT_MESSAGE_SEQ_CONFLICT',
    );
  });

  it('types the refusal for a clone that carries a colliding seq (the original repro)', async () => {
    const sourceId = await seedMessage(legacyMem.id, 3);

    await expectCode(
      M.cloneNode({}, {
        sourceRef: sourceId,
        targetUrn: `urn:node:${legacyMem.urn}:${TEAM_CHAT_LOC}:messages:003-clone`,
      }, ctx(admin.id)),
      'CHAT_MESSAGE_SEQ_CONFLICT',
    );
  });

  it('types the refusal for an update that moves a message into collision', async () => {
    const a = await seedMessage(legacyMem.id, 3);
    const b = await seedMessage(legacyMem.id, 7);

    await expectCode(
      M.updateNode({}, { input: { id: b, seq: 3 } }, ctx(admin.id)),
      'CHAT_MESSAGE_SEQ_CONFLICT',
    );
  });
});

describe('#992 — the legality envelope (what must NOT be swept in)', () => {
  it('keeps equal numbers legal in different chats', async () => {
    const first = await post(ctx(appMember.id), 'first!');
    // A second App's team chat is a different (memory, root) identity.
    const app2 = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'Team App 2', urn: `${org.urn}:team2` },
    });
    await db.appAgent.create({ data: { appId: app2.id, agentId: teamAgent.id } });
    await db.appMember.create({ data: { appId: app2.id, userId: appMember.id, role: 'member' } });
    const other = await M.createTeamChatMessage({}, { appRef: app2.id, body: 'other chat' }, ctx(appMember.id));

    expect(first.seq).toBe(1);
    expect(other.seq).toBe(1);
  });

  it('keeps colliding chatbot record transcripts legal (cor:cht:050:02)', async () => {
    // An ordinary chatbot chat: record root, record messages — the plane that
    // deliberately orders ties by time/address instead of seq uniqueness.
    await db.node.create({
      data: {
        id: generateId(), memoryId: legacyMem.id, loc: 'chat:abc',
        name: 'abc', nodeType: 'record', createdBy: admin.id, data: { messageCount: 5 },
      },
    });
    await seedMessage(legacyMem.id, 5, { nodeType: 'record', loc: 'chat:abc:messages:005-a' });
    await seedMessage(legacyMem.id, 5, { nodeType: 'record', loc: 'chat:abc:messages:005-b' });
  });

  it('keeps counterless chat-messages, summary abstracts and foreign nodes out', async () => {
    await post(ctx(appMember.id), 'first!');
    const memId = await teamChatMemId();

    // Counterless (seq NULL) — never allocated, never constrained.
    await seedMessage(memId, null, { loc: `${TEAM_CHAT_LOC}:messages:x-counterless` });
    // The #998 auto-summary shape: 'abstract' at messageCount + 1 under the
    // SAME prefix — legal, and invisible to the allocator's max scan.
    await seedMessage(memId, 2, { nodeType: 'abstract', loc: `${TEAM_CHAT_LOC}:messages:002-summary` });
    // A foreign non-chat-message node under the storage prefix.
    await seedMessage(memId, 1, { nodeType: 'info', loc: `${TEAM_CHAT_LOC}:messages:001-foreign` });

    // And the next REAL post takes seq 2 without touching the summary.
    const second = await post(ctx(appMember.id), 'second!');
    expect(second.seq).toBe(2);
  });

  it('continues the seq across a chat delete/revive cycle (counter survives)', async () => {
    await post(ctx(appMember.id), 'one');
    await post(ctx(appMember.id), 'two');

    // Tombstone the Channel (the spec 049 delete path), then revive by posting.
    const channel = await db.channel.findFirstOrThrow();
    await db.channel.update({
      where: { id: channel.id },
      data: { deletedAt: new Date(), deletedBy: 'test' },
    });

    const revived = await post(ctx(appMember.id), 'after revive');
    expect(revived.seq).toBe(3);
  });
});

describe('#992 — prisma/chat-seq-invariants.sql (the preflight + index)', () => {
  const runSql = async () => {
    // A raw pg connection in simple-query mode: the file is multi-statement,
    // and Prisma's prepared statements take exactly one. Per-worker URL, per
    // the test-database rules.
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query(INVARIANTS_SQL);
    } finally {
      await client.end();
    }
  };
  const indexExists = async () => {
    const [row] = await db.$queryRaw<Array<{ exists: boolean }>>(
      Prisma.sql`SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = ${INDEX_NAME}) AS "exists"`,
    );
    return row.exists;
  };

  it('is copied verbatim into the migration (prod does not run post-push.sql)', () => {
    const dir = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));
    const migration = readdirSync(dir)
      .filter((m) => /team_chat_seq_unique$/.test(m))
      .sort()
      .at(-1);
    expect(migration).toBeDefined();
    expect(read(`../../prisma/migrations/${migration}/migration.sql`)).toContain(INVARIANTS_SQL);
    expect(read('../../prisma/post-push.sql')).toContain('\\ir chat-seq-invariants.sql');
  });

  it('refuses a colliding set safely, reporting the collision, and installs after repair', async () => {
    // The template built the index on an empty DB; take it away so this test
    // exercises the file's own create path against real rows.
    await db.$executeRawUnsafe(`DROP INDEX IF EXISTS "${INDEX_NAME}"`);
    expect(await indexExists()).toBe(false);

    const memId = legacyMem.id;
    await seedMessage(memId, 3);
    await seedMessage(memId, 3); // the collision

    await expect(runSql()).rejects.toThrow(/chat seq uniqueness/i);
    expect(await indexExists()).toBe(false); // refused safely: nothing installed

    // The synthetic-fixture repair (the authorized owner's selected repair —
    // here, the test): remove the duplicate, then installation succeeds.
    const dupes = await db.node.findMany({
      where: { memoryId: memId, nodeType: 'chat-message', seq: 3 },
      orderBy: { createdAt: 'asc' },
    });
    await db.node.delete({ where: { id: dupes[1].id } });
    await runSql();
    expect(await indexExists()).toBe(true);
  });
});
