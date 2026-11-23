/**
 * #340 — `appendContent` / `prependContent` / `separator` on hadron_update_node.
 *
 * The gate (issue #340, Patrick's attach + Xabat's CHECKED) fixes the flow:
 *   - the new body is joined from the row read UNDER the address and row lock
 *     (`current`), never from the pre-lock probe, so two appends both survive;
 *   - join rule: only the non-empty parts among prepend, the existing body and
 *     append are joined, with `separator` (default "\n\n", "" allowed) between;
 *     a result equal to the current body is the existing no-change return;
 *   - the abstract hash, revision, include and embedding inputs come from that
 *     joined result exactly as if the caller had sent `content: <result>`;
 *   - refusals, each writing nothing: `content` with append/prepend, `separator`
 *     alone, an encrypted memory, `install`, a governed node (and no door named,
 *     since no door carries the new arguments), a comment node, a protected loc,
 *     no write access (the replace path's message), moved or deleted while waiting.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';
import { generateId } from '../lib/id.js';
import { computeContentHash } from '../lib/contentHash.js';
import { parseDataKey } from '../lib/crypto.js';
import { encryptNodeFieldsWithKey } from '../lib/nodeCrypto.js';
import { sessionKeyCache } from '../lib/sessionKeyCache.js';
import { revisionStateHashRefreshMarker } from '../lib/nodeRevisionSnapshot.js';
import * as embeddingEnqueue from '../services/embedding/enqueue.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn(async () => undefined),
}));
vi.mock('../lib/bus/index.js', () => ({
  getBusClient: vi.fn(async () => null),
}));

let admin: { id: string };
let org: { id: string; urn: string };
let memory: { id: string; urn: string };
const auth = (): AuthContext => ({ userId: admin.id, roles: ['ADMIN'], clientId: `user:${admin.id}` });
const mcp = () => createTestableMcpServer(auth());
const urnFor = (loc: string, m: { urn: string } = memory) => `hrn:node:${m.urn}:${loc}`;

beforeEach(async () => {
  vi.restoreAllMocks();
  await cleanDb(db);
  sessionKeyCache.clear();
  org = await db.organization.create({ data: { id: generateId(), name: 'app340-org', urn: 'app340-org' } });
  admin = await db.user.create({ data: { githubId: 34001, githubUsername: 'app340-admin', handle: 'app340-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:nodes`, name: 'nodes', class: 'knowledge' },
  });
});
afterEach(() => sessionKeyCache.clear());

const seed = (loc: string, over: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId: memory.id, loc, name: loc, content: 'BODY', ...over } });

/** What a refused write must leave untouched. */
const snapshot = async (id: string) => {
  const n = await db.node.findUniqueOrThrow({ where: { id } });
  return {
    content: n.content,
    abstract: n.abstract,
    abstractOriginHash: n.abstractOriginHash,
    revSeq: n.revSeq,
    loc: n.loc,
    revisions: await db.nodeRevision.count({ where: { nodeId: id } }),
  };
};

const bodyOf = async (id: string) => (await db.node.findUniqueOrThrow({ where: { id } })).content;

/** Run `raw` once, right before the next interactive transaction begins (the #1339 window). */
function writeJustBeforeNextTransaction(raw: () => Promise<unknown>) {
  const original = db.$transaction.bind(db);
  let fired = false;
  vi.spyOn(db, '$transaction').mockImplementation((async (arg: unknown, opts?: unknown) => {
    if (!fired && typeof arg === 'function') {
      fired = true;
      await raw();
    }
    return (original as any)(arg, opts);
  }) as never);
}

describe('#340 acceptance 3 — exact bytes of the join', () => {
  const cases: Array<[string, Record<string, unknown>, string | null, string | null]> = [
    ['append only, default separator', { appendContent: 'TAIL' }, 'BODY', 'BODY\n\nTAIL'],
    ['prepend only, default separator', { prependContent: 'HEAD' }, 'BODY', 'HEAD\n\nBODY'],
    ['both, default separator', { prependContent: 'HEAD', appendContent: 'TAIL' }, 'BODY', 'HEAD\n\nBODY\n\nTAIL'],
    ['custom separator', { prependContent: 'HEAD', appendContent: 'TAIL', separator: ' | ' }, 'BODY', 'HEAD | BODY | TAIL'],
    ['"" separator is exact concatenation', { prependContent: 'HEAD', appendContent: 'TAIL', separator: '' }, 'BODY', 'HEADBODYTAIL'],
    ['null existing body: no stray separator', { appendContent: 'TAIL' }, null, 'TAIL'],
    ['"" existing body: no stray separator', { prependContent: 'HEAD' }, '', 'HEAD'],
    ['null body, both sides', { prependContent: 'HEAD', appendContent: 'TAIL' }, null, 'HEAD\n\nTAIL'],
    ['whitespace-only existing body is NOT empty (Xavier)', { appendContent: 'TAIL' }, '  ', '  \n\nTAIL'],
    ['empty prepend contributes nothing', { prependContent: '', appendContent: 'TAIL' }, 'BODY', 'BODY\n\nTAIL'],
  ];
  for (const [label, args, prior, expected] of cases) {
    it(label, async () => {
      const node = await seed(`bytes:${generateId()}`, { content: prior });
      const text = await mcp().callToolText('hadron_update_node', { urn: urnFor(node.loc), ...args });
      expect(text).toContain('Node updated:');
      expect(await bodyOf(node.id)).toBe(expected);
    });
  }

  it('the change is one undoable revision holding the prior body, with the reason', async () => {
    const node = await seed('bytes:revision');
    await mcp().callToolText('hadron_update_node', { urn: urnFor(node.loc), appendContent: 'TAIL', reason: 'add a section' });
    const history = await db.nodeRevision.findMany({ where: { nodeId: node.id }, orderBy: { revNo: 'asc' } });
    expect(history).toHaveLength(1);
    expect(history[0]!.content).toBe('BODY');
    expect(history[0]!.revLabel).toBe('add a section');
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).revSeq).toBe(2);
  });

  it('appendContent "" (and an all-empty join) is the no-change return: no revision', async () => {
    const node = await seed('bytes:noop');
    const nullNode = await seed('bytes:noop-null', { content: null });
    const before = await snapshot(node.id);
    const beforeNull = await snapshot(nullNode.id);
    expect(await mcp().callToolText('hadron_update_node', { urn: urnFor(node.loc), appendContent: '' })).toContain('Node updated:');
    expect(await mcp().callToolText('hadron_update_node', { urn: urnFor(nullNode.loc), appendContent: '', prependContent: '' })).toContain('Node updated:');
    expect(await snapshot(node.id)).toEqual(before);
    // A null body stays null: an empty join never turns it into "".
    expect(await snapshot(nullNode.id)).toEqual(beforeNull);
  });

  it('composes with another field in the same call (append a section AND add a tag)', async () => {
    const node = await seed('bytes:compose');
    await mcp().callToolText('hadron_update_node', { urn: urnFor(node.loc), appendContent: 'TAIL', tags: ['added'] });
    const after = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(after.content).toBe('BODY\n\nTAIL');
    expect(after.tags).toEqual(['added']);
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(1);
  });

  it('an include in the appended text derives its include edge, as a replace would', async () => {
    const target = await seed('bytes:include-target', { content: 'shared' });
    const node = await seed('bytes:include');
    const text = await mcp().callToolText('hadron_update_node', { urn: urnFor(node.loc), appendContent: `{{> ${target.loc}}}` });
    expect(text).toContain('Node updated:');
    const edges = await db.edge.findMany({ where: { sourceId: node.id, governedKind: 'INCLUDE', deletedAt: null } });
    expect(edges.map((e) => e.targetId)).toEqual([target.id]);
  });

  it('re-embeds with the joined body', async () => {
    const spy = vi.spyOn(embeddingEnqueue, 'enqueueNodeEmbedding');
    const node = await seed('bytes:embed', { abstract: 'summary' });
    await mcp().callToolText('hadron_update_node', { urn: urnFor(node.loc), appendContent: 'TAIL' });
    const call = spy.mock.calls.find(([, args]) => (args as { nodeId: string }).nodeId === node.id);
    expect(call, 'no embedding was enqueued for the appended node').toBeDefined();
    expect((call![1] as { plaintext: { content: string | null; abstract: string | null } }).plaintext).toEqual({ content: 'BODY\n\nTAIL', abstract: 'summary' });
  });
});

describe('#340 acceptance 1 — the join reads the body under the lock', () => {
  it('two concurrent appends to one node both survive', async () => {
    const node = await seed('race:two');
    const [a, b] = await Promise.all([
      mcp().callToolText('hadron_update_node', { urn: urnFor(node.loc), appendContent: 'ONE' }),
      mcp().callToolText('hadron_update_node', { urn: urnFor(node.loc), appendContent: 'TWO' }),
    ]);
    expect(a).toContain('Node updated:');
    expect(b).toContain('Node updated:');
    const body = (await bodyOf(node.id))!;
    expect([`BODY\n\nONE\n\nTWO`, `BODY\n\nTWO\n\nONE`]).toContain(body);
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(2);
  });

  it('a write landing between the probe and the transaction is appended to, never overwritten', async () => {
    // Deterministic form of the lost-append race: a join built from the pre-lock probe would write "BODY\n\nTAIL"
    // and silently discard the other writer's "OTHER".
    const node = await seed('race:window');
    writeJustBeforeNextTransaction(() => db.node.update({ where: { id: node.id }, data: { content: 'OTHER' } }));
    await mcp().callToolText('hadron_update_node', { urn: urnFor(node.loc), appendContent: 'TAIL' });
    expect(await bodyOf(node.id)).toBe('OTHER\n\nTAIL');
  });
});

describe('#340 acceptance 2 — expectedRevision still binds', () => {
  it('a stale expectedRevision with append is NODE_WRITE_CONFLICT and writes nothing', async () => {
    const node = await seed('rev:stale');
    const before = await snapshot(node.id);
    const text = await mcp().callToolText('hadron_update_node', { urn: urnFor(node.loc), appendContent: 'TAIL', expectedRevision: 7 });
    expect(text).toMatch(/^\[node_write_conflict\]/);
    expect(await snapshot(node.id)).toEqual(before);
  });

  it('a current expectedRevision with append writes', async () => {
    const node = await seed('rev:current');
    const text = await mcp().callToolText('hadron_update_node', { urn: urnFor(node.loc), appendContent: 'TAIL', expectedRevision: 1 });
    expect(text).toContain('Node updated:');
    expect(await bodyOf(node.id)).toBe('BODY\n\nTAIL');
  });
});

describe('#340 acceptance 4 — abstract hash and staleness equal a replace with the same final text', () => {
  const FINAL = 'BODY\n\nTAIL';
  const twins = async (tag: string) => {
    const seedAbstract = { abstract: 'summary', abstractOriginHash: computeContentHash('BODY') };
    return [await seed(`hash:${tag}:append`, seedAbstract), await seed(`hash:${tag}:replace`, seedAbstract)] as const;
  };
  const hashOf = async (id: string) => (await db.node.findUniqueOrThrow({ where: { id } })).abstractOriginHash;
  const staleMarker = async (loc: string) =>
    /abstract-stale/.test(await mcp().callToolText('hadron_get_node', { urn: urnFor(loc), contentScope: 'all' }));

  it('abstract omitted: the stored hash is kept, so staleness arms exactly as for a replace', async () => {
    const [a, r] = await twins('omit');
    await mcp().callToolText('hadron_update_node', { urn: urnFor(a.loc), appendContent: 'TAIL' });
    await mcp().callToolText('hadron_update_node', { urn: urnFor(r.loc), content: FINAL });
    expect(await bodyOf(a.id)).toBe(FINAL);
    expect(await hashOf(a.id)).toBe(await hashOf(r.id));
    expect(await staleMarker(a.loc)).toBe(true);
    expect(await staleMarker(a.loc)).toBe(await staleMarker(r.loc));
  });

  it('abstract supplied: fingerprinted against the FINAL joined body', async () => {
    const [a, r] = await twins('supplied');
    await mcp().callToolText('hadron_update_node', { urn: urnFor(a.loc), appendContent: 'TAIL', abstract: 'new summary' });
    await mcp().callToolText('hadron_update_node', { urn: urnFor(r.loc), content: FINAL, abstract: 'new summary' });
    expect(await hashOf(a.id)).toBe(computeContentHash(FINAL));
    expect(await hashOf(a.id)).toBe(await hashOf(r.id));
    expect(await staleMarker(a.loc)).toBe(false);
  });

  it('abstractStillAccurate: fingerprinted against the FINAL joined body', async () => {
    const [a, r] = await twins('still');
    await mcp().callToolText('hadron_update_node', { urn: urnFor(a.loc), appendContent: 'TAIL', abstractStillAccurate: true });
    await mcp().callToolText('hadron_update_node', { urn: urnFor(r.loc), content: FINAL, abstractStillAccurate: true });
    expect(await hashOf(a.id)).toBe(computeContentHash(FINAL));
    expect(await hashOf(a.id)).toBe(await hashOf(r.id));
    expect(await staleMarker(a.loc)).toBe(false);
  });

  it('abstract supplied: the hash binds to the body joined under the lock, not the probe', async () => {
    const node = await seed('hash:window', { abstract: 'summary', abstractOriginHash: computeContentHash('BODY') });
    writeJustBeforeNextTransaction(() => db.node.update({ where: { id: node.id }, data: { content: 'OTHER' } }));
    await mcp().callToolText('hadron_update_node', { urn: urnFor(node.loc), appendContent: 'TAIL', abstract: 'new summary' });
    expect(await bodyOf(node.id)).toBe('OTHER\n\nTAIL');
    expect(await hashOf(node.id)).toBe(computeContentHash('OTHER\n\nTAIL'));
  });
});

describe('#340 acceptance 5 — refusals write nothing', () => {
  it('content combined with appendContent or prependContent', async () => {
    const node = await seed('refuse:content');
    const before = await snapshot(node.id);
    for (const extra of [{ appendContent: 'TAIL' }, { prependContent: 'HEAD' }]) {
      const text = await mcp().callToolText('hadron_update_node', { urn: urnFor(node.loc), content: 'NEW', ...extra });
      expect(text).toMatch(/`content` cannot be combined with `appendContent` or `prependContent`/);
    }
    // content:null (clear) is a full replace too.
    const cleared = await mcp().callToolText('hadron_update_node', { urn: urnFor(node.loc), content: null, appendContent: 'TAIL' });
    expect(cleared).toMatch(/`content` cannot be combined/);
    expect(await snapshot(node.id)).toEqual(before);
  });

  it('separator without appendContent or prependContent', async () => {
    const node = await seed('refuse:separator');
    const before = await snapshot(node.id);
    const text = await mcp().callToolText('hadron_update_node', { urn: urnFor(node.loc), separator: '---', name: 'renamed' });
    expect(text).toMatch(/`separator` applies only with `appendContent` or `prependContent`/);
    expect(await snapshot(node.id)).toEqual(before);
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).name).toBe(node.name);
  });

  it('a NUL in appendContent, prependContent or separator: [bad_user_input], like one in content (#4096)', async () => {
    const node = await seed('refuse:nul');
    const before = await snapshot(node.id);
    for (const args of [{ appendContent: 'a\u0000b' }, { prependContent: 'a\u0000b' }, { appendContent: 'x', separator: '\u0000' }]) {
      const text = await mcp().callToolText('hadron_update_node', { urn: urnFor(node.loc), ...args });
      expect(text).toMatch(/^\[bad_user_input\]/);
    }
    expect(await snapshot(node.id)).toEqual(before);
  });

  it('install: refused before forwarding, like edges/isRunnable', async () => {
    const text = await mcp().callToolText('hadron_update_node', {
      urn: 'prompts:lane',
      install: { app: generateId(), agent: generateId() },
      appendContent: 'TAIL',
    });
    expect(text).toMatch(/`install` does not support .*`appendContent`/);
  });

  it('encrypted memory: refused, ciphertext byte-identical (unlocked and locked)', async () => {
    const owner = (await db.user.create({ data: { handle: `app340-owner-${generateId()}`, roles: ['READER'] } })).id;
    const enc = await db.memory.create({
      data: {
        name: 'app340-enc', urn: `app340-${generateId()}:private`, class: 'private',
        userId: owner, ownerUserId: owner, vectorIndexEnabled: false, isEncrypted: true,
      },
    });
    const key = parseDataKey(Buffer.alloc(32, 41).toString('base64'));
    const node = await db.node.create({
      data: {
        id: generateId(), memoryId: enc.id, loc: 'secret', name: 'secret',
        ...encryptNodeFieldsWithKey({ content: 'PLAIN BODY' }, key),
        revisionContentHash: revisionStateHashRefreshMarker(),
      } as never,
    });
    const raw = async () => {
      const n = await db.node.findUniqueOrThrow({ where: { id: node.id } });
      return { content: n.content, revSeq: n.revSeq, revisions: await db.nodeRevision.count({ where: { nodeId: node.id } }) };
    };
    const before = await raw();
    const client = createTestableMcpServer({ userId: owner, roles: ['READER'], clientId: `user:${owner}` });
    sessionKeyCache.set('app340', enc.id, key);
    for (const args of [{ appendContent: 'TAIL' }, { prependContent: 'HEAD' }]) {
      const text = await client.callToolText('hadron_update_node', { urn: urnFor('secret', enc), ...args });
      expect(text).toMatch(/\[append_unsupported_encrypted\]/);
    }
    sessionKeyCache.clear();
    const locked = await client.callToolText('hadron_update_node', { urn: urnFor('secret', enc), appendContent: 'TAIL' });
    expect(locked).not.toContain('Node updated:');
    expect(await raw()).toEqual(before);
  });

  it('memory encrypted while the append waits: refused under the lock, ciphertext byte-identical, no revision (Rodolfo §10 P2-1)', async () => {
    const node = await seed('refuse:encrypted-while-waiting');
    const key = parseDataKey(Buffer.alloc(32, 43).toString('base64'));
    const cipher = (encryptNodeFieldsWithKey({ content: 'PLAIN BODY' }, key) as { content: string }).content;
    writeJustBeforeNextTransaction(async () => {
      await db.memory.update({ where: { id: memory.id }, data: { isEncrypted: true } });
      await db.node.update({ where: { id: node.id }, data: { content: cipher } });
    });
    const text = await mcp().callToolText('hadron_update_node', { urn: urnFor(node.loc), appendContent: 'TAIL' });
    expect(text).not.toContain('Node updated:');
    expect(text).toMatch(/\[node_write_conflict\] Memory encryption changed while this write waited/);
    expect(await bodyOf(node.id)).toBe(cipher);
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(0);
  });

  it('governed node: [role_governed], and no door is named (no door carries the new arguments)', async () => {
    const task = await seed('refuse:task', { isRunnable: true });
    const review = await seed('refuse:review', { role: 'review' });
    for (const [node, door] of [[task, 'hadron_update_task'], [review, 'hadron_update_review']] as const) {
      const before = await snapshot(node.id);
      const text = await mcp().callToolText('hadron_update_node', { urn: urnFor(node.loc), appendContent: 'TAIL' });
      expect(text).toMatch(/^\[role_governed\]/);
      expect(text).not.toContain(door);
      expect(await snapshot(node.id)).toEqual(before);
    }
  });

  it('comment node: refused as a replace is', async () => {
    // A real comment, made through the comment path (a raw comment row is refused by COMMENT_INVARIANT).
    const target = await seed('refuse:commented');
    await mcp().callToolText('hadron_create_comment', { targetRef: target.id, body: 'a remark' });
    const node = await db.node.findFirstOrThrow({ where: { memoryId: memory.id, nodeType: 'comment', deletedAt: null } });
    const before = await snapshot(node.id);
    const text = await mcp().callToolText('hadron_update_node', { urn: urnFor(node.loc), appendContent: 'TAIL' });
    const replace = await mcp().callToolText('hadron_update_node', { urn: urnFor(node.loc), content: 'BODY\n\nTAIL' });
    expect(text).toMatch(/^\[role_governed\]/);
    expect(text).toBe(replace);
    expect(await snapshot(node.id)).toEqual(before);
  });

  it('protected loc (a Channel message): refused as a replace is', async () => {
    const ctx = { db, roles: ['ADMIN'], userId: admin.id } as Context;
    const channel = await resolvers.Mutation.createChannel(null, { input: { memoryRef: memory.urn, loc: 'chats:room', name: 'room' } }, ctx);
    await resolvers.Mutation.createChannelMessage(null, { channelRef: channel.id, body: 'hello' }, ctx);
    const msg = await db.node.findFirstOrThrow({ where: { memoryId: memory.id, nodeType: { in: ['chat-message', 'record'] }, seq: { not: null } } });
    const before = await snapshot(msg.id);
    const text = await mcp().callToolText('hadron_update_node', { urn: urnFor(msg.loc), appendContent: 'TAIL' });
    const replace = await mcp().callToolText('hadron_update_node', { urn: urnFor(msg.loc), content: 'hello\n\nTAIL' });
    expect(text).toMatch(/^\[loc_protected\]/);
    expect(text).toBe(replace);
    expect(await snapshot(msg.id)).toEqual(before);
  });

  it('no write access: the same message as a replace', async () => {
    const node = await seed('refuse:denied');
    const before = await snapshot(node.id);
    const stranger = await db.user.create({ data: { handle: `app340-stranger-${generateId()}`, roles: ['READER'] } });
    const client = createTestableMcpServer({ userId: stranger.id, roles: ['READER'], clientId: `user:${stranger.id}` });
    const text = await client.callToolText('hadron_update_node', { urn: urnFor(node.loc), appendContent: 'TAIL' });
    const replace = await client.callToolText('hadron_update_node', { urn: urnFor(node.loc), content: 'BODY\n\nTAIL' });
    expect(text).not.toContain('Node updated:');
    expect(text).toBe(replace);
    expect(await snapshot(node.id)).toEqual(before);
  });

  it('moved while waiting: [write_conflict], nothing appended at either address', async () => {
    const node = await seed('refuse:moved');
    writeJustBeforeNextTransaction(() => db.node.update({ where: { id: node.id }, data: { loc: 'refuse:moved-away' } }));
    const text = await mcp().callToolText('hadron_update_node', { urn: urnFor(node.loc), appendContent: 'TAIL' });
    expect(text).toMatch(/\[write_conflict\]/);
    const after = await db.node.findUniqueOrThrow({ where: { id: node.id } });
    expect(after.content).toBe('BODY');
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(0);
  });

  it('deleted while waiting: [write_conflict], nothing appended', async () => {
    const node = await seed('refuse:deleted');
    writeJustBeforeNextTransaction(() => db.node.update({ where: { id: node.id }, data: { deletedAt: new Date() } }));
    const text = await mcp().callToolText('hadron_update_node', { urn: urnFor(node.loc), appendContent: 'TAIL' });
    expect(text).toMatch(/\[write_conflict\]/);
    expect(await bodyOf(node.id)).toBe('BODY');
    expect(await db.nodeRevision.count({ where: { nodeId: node.id } })).toBe(0);
  });
});

describe('#340 — the registered schema', () => {
  it('takes appendContent, prependContent and separator as strings', () => {
    const client = mcp();
    for (const p of ['appendContent', 'prependContent', 'separator']) {
      expect(client.toolParamSchema('hadron_update_node', p).parse('x')).toBe('x');
      expect(() => client.toolParamSchema('hadron_update_node', p).parse(null)).toThrow();
    }
  });
});
