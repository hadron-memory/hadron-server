/**
 * #5200 — `updateMemory` is a write ENTRY that takes caller text, and it had no storable-text guard: a NUL (U+0000) or an
 * unpaired surrogate in `name`, `description`, `data` and the rest reached Postgres (22021 / 22P05) and came back as an
 * untyped INTERNAL_SERVER_ERROR, where `createMemory` refuses the same input typed (cor:api:260:01, the #4096/#4106
 * convention). The refusal is BAD_USER_INPUT naming the field and never echoing the value, judged AFTER the authorization
 * gates (a caller who may not manage the memory keeps today's answer, whatever the text holds) and BEFORE the
 * transaction, so the row stays unchanged. Not in scope: createMemory, node writes, any MCP tool (there is no
 * update_memory tool), any client.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../lib/bus/index.js', () => ({ getBusClient: vi.fn(async () => null) }));
vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const SECRET = 'SECRETVALUE';
const nul = `${SECRET}\0tail`;
const lone = `${SECRET}\ud800tail`;

let admin: any;
let outsider: any;
let org: any;
let memory: any;
const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] as any, clientId: `user:${userId}` });
const update = (patch: Record<string, unknown>, userId = admin.id) => M.updateMemory({}, { ref: memory.id, ...patch }, ctx(userId));
const row = () => db.memory.findUniqueOrThrow({ where: { id: memory.id } });

beforeEach(async () => {
  await cleanDb(db);
  const sfx = generateId().slice(-6).toLowerCase();
  admin = await db.user.create({ data: { id: generateId(), handle: `adm5200-${sfx}`, githubUsername: `adm5200-${sfx}`, roles: ['READER'] } });
  outsider = await db.user.create({ data: { id: generateId(), handle: `out5200-${sfx}`, githubUsername: `out5200-${sfx}`, roles: ['READER'] } });
  org = await db.organization.create({ data: { id: generateId(), name: 'Org 5200', urn: `upd5200-${sfx}.test` } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  memory = await db.memory.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:mem`, name: 'before', class: 'knowledge', visibility: 'ORGANIZATION', description: 'old description' },
  });
});

const refused = (p: Promise<unknown>, field: string) =>
  p.then(
    () => { throw new Error('expected a refusal'); },
    (e: any) => {
      expect(e.extensions?.code, String(e.message)).toBe('BAD_USER_INPUT');
      expect(e.message).toContain(field);
      expect(e.message).not.toContain(SECRET);
      expect(JSON.stringify(e.extensions ?? {})).not.toContain(SECRET);
    },
  );

describe('updateMemory refuses unstorable caller text typed, writing nothing (#5200)', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['name', { name: nul }], ['name', { name: lone }],
    ['shortDescription', { shortDescription: nul }],
    ['description', { description: nul }], ['description', { description: lone }],
    ['tags', { tags: ['ok', nul] }],
    ['data', { data: { k: nul } }], ['data', { data: { [nul]: 1 } }], ['data', { data: { deep: { list: [lone] } } }],
    ['schema', { schema: { description: nul } }],
    ['license', { license: nul }],
    ['category0', { category0: nul }], ['category1', { category1: nul }], ['category2', { category2: nul }],
    ['iconUrl', { iconUrl: nul }], ['heroUrl', { heroUrl: nul }], ['homeUrl', { homeUrl: nul }],
    ['source', { source: nul }],
    ['readBranch', { readBranch: nul }], ['writeBranch', { writeBranch: nul }],
    ['urn', { urn: nul }],
  ];
  for (const [field, patch] of cases) {
    it(`${field}: ${JSON.stringify(patch).slice(0, 40).replace(/[\0\ud800]/g, '?')}`, async () => {
      const before = await row();
      await refused(update(patch), field);
      expect(await row()).toEqual(before);
    });
  }

  it('the first unstorable field is named even when other fields are clean', async () => {
    await refused(update({ name: 'clean name', description: nul }), 'description');
    expect((await row()).name).toBe('before');
  });

  it('a clean update, a multi-byte name and a valid non-BMP pair still succeed', async () => {
    const out = await update({ name: 'Grüße 😀', description: 'new description', tags: ['a', 'b'], data: { k: 'v' } });
    expect(out.name).toBe('Grüße 😀');
    expect((await row()).description).toBe('new description');
  });
});

describe('the refusal sits after the authorization gates (#5200, constraint 2)', () => {
  it('a caller who may not manage the memory keeps today\'s answer, whatever the text holds', async () => {
    const clean = await update({ name: 'renamed' }, outsider.id).then(() => 'ok', (e: any) => `${e.extensions?.code}: ${e.message}`);
    const dirty = await update({ name: nul, description: nul, data: { k: nul } }, outsider.id).then(() => 'ok', (e: any) => `${e.extensions?.code}: ${e.message}`);
    expect(clean).not.toBe('ok');
    expect(dirty).toBe(clean);
    expect(dirty).not.toMatch(/BAD_USER_INPUT/);
    expect((await row()).name).toBe('before');
  });
});

describe('urn rename (#5200, constraint 5)', () => {
  it('a slug with no ASCII letter or digit is a typed refusal, not an untyped error', async () => {
    await update({ urn: '---' }).then(
      () => { throw new Error('expected a refusal'); },
      (e: any) => { expect(e.extensions?.code, String(e.message)).toBe('BAD_USER_INPUT'); },
    );
    expect((await row()).urn).toBe(`${org.urn}:mem`);
  });
});
