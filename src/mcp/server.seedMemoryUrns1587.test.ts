/** #1587: run the real fixture writer, then reuse its personal-memory addresses through registered MCP handlers.
 * cor:urn:010:01 has exactly one memory slug atom. No grammar, aliases or existing data are changed here.
 * Gate QA must separately run the re-seeded fixture over the mounted server; this is the in-process MCP handler harness.
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
import { mintMemoryUrnV2 } from '../lib/mintMemoryUrnV2.js';
import type { AuthContext } from '../middleware/auth.js';

const exec = promisify(execFile);
let mike: { id: string; roles: string[] };
let personal: Array<{ id: string; urn: string; appId: string | null; userId: string | null }>;

beforeAll(async () => {
  await cleanDb(db);
  // Inherited DATABASE_URL is Vitest's run-owned worker clone, never the development database.
  // Seed stdout contains fixture App keys: capture it privately, never print it into test output.
  await exec(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../../prisma/seed.ts', import.meta.url))], {
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
  }).catch(() => { throw new Error('The real seed failed before the #1587 assertions'); });
  mike = await db.user.findUniqueOrThrow({ where: { handle: 'mike' } });
  personal = await db.memory.findMany({ where: { class: 'personal', userId: mike.id }, select: { id: true, urn: true, appId: true, userId: true } });
}, 30_000);

function legacy(memoryUrn: string, loc: string) {
  const colon = memoryUrn.indexOf(':');
  return `${memoryUrn.slice(0, colon)}::${memoryUrn.slice(colon + 1)}::${loc}`;
}
async function fixture(root: string) {
  const app = await db.app.findFirstOrThrow({ where: { urn: `${root}:juno` } });
  const memory = personal.find(m => m.appId === app.id)!;
  expect(memory).toBeDefined();
  expect(memory.userId).toBe(mike.id);
  const client = createTestableMcpServer({ userId: mike.id, roles: mike.roles as NonNullable<AuthContext['roles']>, clientId: `user:${mike.id}` });
  expect(await client.callToolText('hadron_set_active_app', { app: `hrn:app:${app.urn}` })).not.toMatch(/not found|not authenticated/i);
  return { memory, client };
}
function savedUrn(text: string) {
  expect(text).toContain('Node saved:');
  const urn = /Node saved: (hrn:node:\S+)/.exec(text)?.[1];
  expect(urn).toBeTruthy();
  return urn!;
}

describe('#1587 seeded memory addresses', () => {
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
      const loc = 'plans:canonical';
      const urn = emitNodeUrnV2(memory.urn, loc);
      expect(savedUrn(await client.callToolText('hadron_create_node', { urn, name: 'Canonical fixture', content: 'seed canonical payload' }))).toBe(urn);
      expect(splitNodeUrn(urn)).toMatchObject({ memoryUrn: memory.urn, loc });
      expect(await client.callToolText('hadron_get_node', { urn })).toContain('seed canonical payload');
      expect(await client.callToolText('hadron_get_node', { urn: legacy(memory.urn, loc) })).toContain('seed canonical payload');
      expect(await db.node.count({ where: { memoryId: memory.id, loc } })).toBe(1);
    });

    it('reads exactly the canonical reference emitted from a legacy-input create', async () => {
      const { memory, client } = await fixture(root);
      const loc = 'plans:emitted';
      const urn = savedUrn(await client.callToolText('hadron_create_node', { urn: legacy(memory.urn, loc), name: 'Emitted fixture', content: 'copied reference payload' }));
      expect(await client.callToolText('hadron_get_node', { urn })).toContain('copied reference payload');
    });

    it('uses exactly that emitted reference as an edge target in the same intended memory', async () => {
      const { memory, client } = await fixture(root);
      const source = legacy(memory.urn, 'plans:source');
      savedUrn(await client.callToolText('hadron_create_node', { urn: source, name: 'Source' }));
      const target = savedUrn(await client.callToolText('hadron_create_node', { urn: legacy(memory.urn, 'plans:target'), name: 'Target' }));
      expect(await client.callToolText('hadron_create_edge', { sourceUrn: source, targetUrn: target, name: 'uses' })).toContain('Edge saved:');
      const nodes = await db.node.findMany({ where: { memoryId: memory.id, loc: { in: ['plans:source', 'plans:target'] } }, select: { id: true, loc: true } });
      expect(await db.edge.findMany({ where: { sourceId: nodes.find(n => n.loc === 'plans:source')!.id, deletedAt: null }, select: { targetId: true, name: true } })).toEqual([{ targetId: nodes.find(n => n.loc === 'plans:target')!.id, name: 'uses' }]);
    });

    it('retains accepted legacy create/read as an independent input control', async () => {
      const { memory, client } = await fixture(root);
      const urn = legacy(memory.urn, 'plans:legacy');
      savedUrn(await client.callToolText('hadron_create_node', { urn, name: 'Legacy fixture', content: 'legacy payload' }));
      expect(await client.callToolText('hadron_get_node', { urn })).toContain('legacy payload');
    });
  });

  it.each(['mentor-co', 'client-co'])('the production minter keeps %s personal slugs single-atom, including a collision alias', async root => {
    let calls = 0;
    const fake = { memory: { count: async () => ++calls === 1 ? 1 : 0 } } as never;
    const urn = await mintMemoryUrnV2(fake, { root, desiredSlug: 'juno-mike-personal', authorRoot: 'platform-co:juno' });
    expect(urn.split(':')).toHaveLength(2);
    expect(urn.split(':')[1]).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/);
    expect(urn).not.toBe(`${root}:juno-mike-personal`);
    expect(calls).toBe(2);
  });
});
