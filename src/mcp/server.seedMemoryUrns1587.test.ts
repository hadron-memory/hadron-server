/** #1587: run the real fixture writer, then reuse its personal-memory addresses through registered MCP handlers.
 * cor:urn:010:01 has exactly one memory slug atom. No grammar, aliases or existing data are changed here.
 * This uses the in-process MCP handler harness, not a mounted server.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { createTestableMcpServer } from './server.js';
import { emitNodeUrnV2 } from '../lib/urnEmit.js';
import { splitNodeUrn } from '../lib/urn.js';
import { generateId } from '../lib/id.js';
import { PARALLEL_DBS, baseTestDbUrl, workerDbUrl } from '../test/dbWorkers.js';
import type { AuthContext } from '../middleware/auth.js';

const exec = promisify(execFile);
let mike: { id: string; roles: string[] };
let personal: Array<{ id: string; urn: string; appId: string | null; userId: string | null }>;

function seedDatabaseName(value: string | undefined, expected: string): string {
  if (!value || value !== expected) throw new Error('Seed fixture requires its configured Vitest database');
  let name: string;
  try { name = decodeURIComponent(new URL(value).pathname.slice(1)); }
  catch { throw new Error('Seed fixture requires a valid configured Vitest database'); }
  if (!/^hadron_test(?:_|$)/.test(name)) throw new Error('Seed fixture refuses a non-test database');
  return name;
}

function seedFailure(error: unknown): Error {
  // execFile's message, stdout AND stderr can contain fixture keys. Report only structured process status.
  const e = error as { code?: unknown; signal?: unknown };
  const code = typeof e?.code === 'number' || (typeof e?.code === 'string' && /^[A-Z_]+$/.test(e.code)) ? e.code : 'unknown';
  const signal = typeof e?.signal === 'string' && /^SIG[A-Z]+$/.test(e.signal) ? e.signal : 'none';
  return new Error(`The real seed failed before the #1587 assertions (exit=${code}, signal=${signal})`);
}

beforeAll(async () => {
  const expected = PARALLEL_DBS ? workerDbUrl(process.env.VITEST_POOL_ID ?? '1') : baseTestDbUrl();
  const name = seedDatabaseName(process.env.DATABASE_URL, expected);
  const [actual] = await db.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
  if (actual?.name !== name) throw new Error('Seed fixture client does not target its configured Vitest database');
  await cleanDb(db);
  // Inherited DATABASE_URL is Vitest's run-owned worker clone, never the development database.
  // Seed stdout contains fixture App keys: capture it privately, never print it into test output.
  await exec(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../../prisma/seed.ts', import.meta.url))], {
    env: process.env,
  }).catch(error => { throw seedFailure(error); });
  mike = await db.user.findUniqueOrThrow({ where: { handle: 'mike' } });
  personal = await db.memory.findMany({ where: { class: 'personal', userId: mike.id }, select: { id: true, urn: true, appId: true, userId: true } });
}, 30_000);

function legacy(memoryUrn: string, loc: string) {
  const colon = memoryUrn.indexOf(':');
  return `${memoryUrn.slice(0, colon)}::${memoryUrn.slice(colon + 1)}::${loc}`;
}
async function fixture(root: string) {
  const app = await db.app.findFirstOrThrow({ where: { urn: `${root}:juno` } });
  const memory = personal.find(m => m.appId === app.id);
  if (!memory) throw new Error(`Missing personal fixture for ${root}`);
  expect(memory.userId).toBe(mike.id);
  const client = createTestableMcpServer({ userId: mike.id, roles: mike.roles as NonNullable<AuthContext['roles']>, clientId: `user:${mike.id}` });
  expect(await client.callToolText('hadron_set_active_app', { app: `hrn:app:${app.urn}` })).toContain(`Active App set to: **hrn:app:${app.urn}**`);
  return { memory, client };
}
function savedUrn(text: string) {
  expect(text).toContain('Node saved:');
  const urn = /Node saved: (hrn:node:\S+)/.exec(text)?.[1];
  expect(urn).toBeTruthy();
  return urn!;
}

describe('#1587 seeded memory addresses', () => {
  it('refuses absent, development and foreign-run database targets before destructive fixture work', () => {
    const own = 'postgresql://tester@localhost/hadron_test_rprivate_1';
    expect(seedDatabaseName(own, own)).toBe('hadron_test_rprivate_1');
    expect(() => seedDatabaseName(undefined, own)).toThrow();
    expect(() => seedDatabaseName('postgresql://tester@localhost/hadron', own)).toThrow();
    expect(() => seedDatabaseName('postgresql://tester@localhost/hadron', 'postgresql://tester@localhost/hadron')).toThrow();
    expect(() => seedDatabaseName('postgresql://tester@localhost/hadron_test_rforeign_1', own)).toThrow();
  });

  it('seed failure diagnostics retain exit/signal while withholding every child output channel', () => {
    const error = seedFailure({ code: 2, signal: 'SIGTERM', message: 'private message', stdout: 'private stdout', stderr: 'private stderr' });
    expect(error.message).toContain('exit=2, signal=SIGTERM');
    expect(error.message).not.toContain('private');
    expect(error.cause).toBeUndefined();
  });

  it('every actual seeded memory has one slug atom, and the two App-personal bindings stay separate', async () => {
    const all = await db.memory.findMany({ select: { urn: true } });
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter(m => m.urn.split(':').length !== 2).map(m => m.urn)).toEqual([]);
    expect(personal).toHaveLength(2);
    expect(new Set(personal.map(m => m.appId)).size).toBe(2);
    expect(new Set(personal.map(m => m.urn)).size).toBe(2);
  });

  describe.each(['mentor-co', 'client-co'])('%s App-personal memory', root => {
    it('canonical create/read round-trips, and accepted legacy input reads that same row', async () => {
      const { memory, client } = await fixture(root);
      const loc = `plans:canonical:${generateId()}`;
      const urn = emitNodeUrnV2(memory.urn, loc);
      expect(savedUrn(await client.callToolText('hadron_create_node', { urn, name: 'Canonical fixture', content: 'seed canonical payload' }))).toBe(urn);
      expect(splitNodeUrn(urn)).toMatchObject({ memoryUrn: memory.urn, loc });
      expect(await client.callToolText('hadron_get_node', { urn })).toContain('seed canonical payload');
      expect(await client.callToolText('hadron_get_node', { urn: legacy(memory.urn, loc) })).toContain('seed canonical payload');
      expect(await db.node.count({ where: { memoryId: memory.id, loc } })).toBe(1);
    });

    it('reads exactly the canonical reference emitted from a legacy-input create', async () => {
      const { memory, client } = await fixture(root);
      const loc = `plans:emitted:${generateId()}`;
      const urn = savedUrn(await client.callToolText('hadron_create_node', { urn: legacy(memory.urn, loc), name: 'Emitted fixture', content: 'copied reference payload' }));
      expect(await client.callToolText('hadron_get_node', { urn })).toContain('copied reference payload');
    });

    it('uses exactly that emitted reference as an edge target in the same intended memory', async () => {
      const { memory, client } = await fixture(root);
      const sourceLoc = `plans:source:${generateId()}`;
      const targetLoc = `plans:target:${generateId()}`;
      const source = legacy(memory.urn, sourceLoc);
      savedUrn(await client.callToolText('hadron_create_node', { urn: source, name: 'Source' }));
      const target = savedUrn(await client.callToolText('hadron_create_node', { urn: legacy(memory.urn, targetLoc), name: 'Target' }));
      expect(await client.callToolText('hadron_create_edge', { sourceUrn: source, targetUrn: target, name: 'uses' })).toContain('Edge saved:');
      const sourceNode = await db.node.findFirstOrThrow({ where: { memoryId: memory.id, loc: sourceLoc, deletedAt: null } });
      const targetNode = await db.node.findFirstOrThrow({ where: { memoryId: memory.id, loc: targetLoc, deletedAt: null } });
      expect(await db.edge.findMany({ where: { sourceId: sourceNode.id, deletedAt: null }, select: { targetId: true, name: true } })).toEqual([{ targetId: targetNode.id, name: 'uses' }]);
    });

    it('retains accepted legacy create/read as an independent input control', async () => {
      const { memory, client } = await fixture(root);
      const urn = legacy(memory.urn, `plans:legacy:${generateId()}`);
      savedUrn(await client.callToolText('hadron_create_node', { urn, name: 'Legacy fixture', content: 'legacy payload' }));
      expect(await client.callToolText('hadron_get_node', { urn })).toContain('legacy payload');
    });
  });

});
