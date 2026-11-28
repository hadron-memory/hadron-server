/** #5394 PR 2: the hand-run deletion of the no-App per-user chat memories, through deleteMemory's own path. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../src/integrations/db/client.js';
import { cleanDb } from '../../src/test/helpers.js';
import { generateId } from '../../src/lib/id.js';
import { main, MAX_APPLY_ROWS } from './delete-no-app-chat-memories-5394.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const TAG = 'db.delete_no_app_chat_memories_5394';
let org: { id: string };
let agentId: string;
let appId: string;
let n = 0;

/** The shape the removed no-App route of startChat wrote (#5394 PR 2 predicate). */
const holding = (over: Record<string, unknown> = {}) =>
  db.memory.create({ data: {
    id: generateId(), name: `h${++n}`, urn: `del5394:h${n}`, class: 'knowledge', visibility: 'ORGANIZATION',
    organizationId: org.id, userMemoryOfAgentId: agentId, ...over,
  } as never });
const deletedAt = async (id: string) => (await db.memory.findUniqueOrThrow({ where: { id } })).deletedAt;
const run = async (argv: string[], afterRead?: () => Promise<void>) => {
  const lines: string[] = [];
  const code = await main(argv, { env: process.env, log: (l) => lines.push(l), afterRead });
  return { code, lines };
};

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'del5394', urn: 'del5394' } });
  agentId = (await db.agent.create({ data: { name: 'del5394 agent', urn: 'del5394:agent', organizationId: org.id } })).id;
  appId = (await db.app.create({ data: { organizationId: org.id, name: 'del5394 app', urn: 'del5394:app' } })).id;
});

/** Every row near the predicate that must never be selected: one column off each. */
async function lookalikes() {
  const u = await db.user.create({ data: { githubId: 539401, githubUsername: 'del5394-u', handle: 'del5394-u', roles: ['READER'] } });
  return [
    await holding({ appId }),                                                     // app_id set: an App's holding
    await holding({ userMemoryOfAgentId: null }),                                 // no Agent: an ordinary knowledge memory
    await holding({ class: 'group', visibility: null }),                          // another class
    await holding({ deletedAt: new Date(Date.now() - 60_000) }),                  // already deleted
    await holding({ class: 'personal', userId: u.id, visibility: null, appId }),  // user_id set (personal, App-bound)
  ];
}

describe('#5394 PR 2 deletion script', () => {
  it('dry run (the default, and --dry-run) prints the matching ids and count and writes nothing', async () => {
    const a = await holding();
    const b = await holding();
    const others = await lookalikes();
    for (const argv of [[], ['--dry-run']]) {
      const { code, lines } = await run(argv);
      expect(code).toBe(0);
      expect(lines).toEqual([...[a.id, b.id].sort().map((id) => `${TAG}.match id=${id}`), `${TAG} dry_run count=2`]);
    }
    for (const m of [a, b]) expect(await deletedAt(m.id)).toBeNull();
    expect(await deletedAt(others[3].id)).not.toBeNull();
    for (const m of [others[0], others[1], others[2], others[4]]) expect(await deletedAt(m.id)).toBeNull();
  });

  it('--apply deletes exactly the matching memories as deleteMemory does (memory and its files at one instant; nodes kept); a rerun finds none', async () => {
    const a = await holding();
    const others = await lookalikes();
    const othersBefore = await db.memory.findMany({ where: { id: { in: others.map((o) => o.id) } }, orderBy: { id: 'asc' } });
    const node = await db.node.create({ data: { memoryId: a.id, loc: 'chats:c1', name: 'c1', nodeType: 'chat' } });
    const asset = await db.asset.create({ data: { id: generateId(), memoryId: a.id, filename: 'f', mimeType: 'text/plain', sizeBytes: 1, storageKey: `k/${generateId()}`, scanStatus: 'CLEAN' } as never });
    const { code, lines } = await run(['--apply']);
    expect(code).toBe(0);
    expect(lines).toEqual([`${TAG}.match id=${a.id}`, `${TAG}.deleted id=${a.id}`, `${TAG} applied deleted=1 skipped=0`]);
    const at = await deletedAt(a.id);
    expect(at).toBeInstanceOf(Date);
    expect((await db.asset.findUniqueOrThrow({ where: { id: asset.id } })).deletedAt).toEqual(at);
    // deleteMemory takes nothing else: the node stays, behind the tombstoned memory.
    expect((await db.node.findUniqueOrThrow({ where: { id: node.id } })).deletedAt).toBeNull();
    expect(await db.memory.findMany({ where: { id: { in: others.map((o) => o.id) } }, orderBy: { id: 'asc' } })).toEqual(othersBefore);
    const again = await run(['--apply']);
    expect(again).toEqual({ code: 0, lines: [`${TAG} applied deleted=0 skipped=0`] });
    expect(await deletedAt(a.id)).toEqual(at);
  });

  it(`--apply refuses outright above the cap (${MAX_APPLY_ROWS} rows): exit 3, nothing deleted`, async () => {
    const rows = [];
    for (let i = 0; i < MAX_APPLY_ROWS + 1; i++) rows.push(await holding());
    const { code, lines } = await run(['--apply']);
    expect(code).toBe(3);
    expect(lines.at(-1)).toBe(`${TAG}.over_cap count=${MAX_APPLY_ROWS + 1} cap=${MAX_APPLY_ROWS} applied=0`);
    for (const m of rows) expect(await deletedAt(m.id)).toBeNull();
  });

  it(`--apply at exactly the cap deletes all ${MAX_APPLY_ROWS}`, async () => {
    const rows = [];
    for (let i = 0; i < MAX_APPLY_ROWS; i++) rows.push(await holding());
    const { code, lines } = await run(['--apply']);
    expect(code).toBe(0);
    expect(lines.at(-1)).toBe(`${TAG} applied deleted=${MAX_APPLY_ROWS} skipped=0`);
    for (const m of rows) expect(await deletedAt(m.id)).not.toBeNull();
  });

  it("keeps deleteMemory's refusals: a memory hosting a live Channel is skipped with its code, the others are deleted, exit 4", async () => {
    const hosting = await holding();
    const plain = await holding();
    const root = await db.node.create({ data: { memoryId: hosting.id, loc: 'chats:team', name: 'team', nodeType: 'chat' } });
    await db.channel.create({ data: { memoryId: hosting.id, loc: 'chats:team', name: 'team', chatRootNodeId: root.id } });
    const { code, lines } = await run(['--apply']);
    expect(code).toBe(4);
    expect(lines).toContain(`${TAG}.skipped id=${hosting.id} code=MEMORY_HOSTS_CHANNEL`);
    expect(lines).toContain(`${TAG}.deleted id=${plain.id}`);
    expect(lines.at(-1)).toBe(`${TAG} applied deleted=1 skipped=1`);
    expect(await deletedAt(hosting.id)).toBeNull();
    expect(await deletedAt(plain.id)).not.toBeNull();
  });

  it('re-judges the predicate under the row lock: a memory that left it after the read is skipped, never deleted', async () => {
    const moved = await holding();
    const stays = await holding();
    const { code, lines } = await run(['--apply'], async () => {
      await db.memory.update({ where: { id: moved.id }, data: { appId } });
    });
    expect(code).toBe(4);
    expect(lines).toContain(`${TAG}.skipped id=${moved.id} code=OUT_OF_SCOPE`);
    expect(await deletedAt(moved.id)).toBeNull();
    expect(await deletedAt(stays.id)).not.toBeNull();
  });

  it('refuses unknown arguments and a missing DATABASE_URL (exit 2), writing nothing', async () => {
    const a = await holding();
    expect((await run(['--apply', '--force'])).code).toBe(2);
    expect((await run(['--yes'])).code).toBe(2);
    const lines: string[] = [];
    expect(await main(['--apply'], { env: {}, log: (l) => lines.push(l) })).toBe(2);
    expect(lines).toEqual([`${TAG}.database_url_missing`]);
    expect(await deletedAt(a.id)).toBeNull();
  });
});
