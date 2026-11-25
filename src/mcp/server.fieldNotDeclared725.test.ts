/**
 * #725 slice (cor:api:170:03): `hadron_find_objects` carries the FIELD_NOT_DECLARED refusal in the MCP bracket form every other typed
 * refusal uses, `[field_not_declared] Field "<field>" is not declared in strict collection "<type>".`, over the real MCP tool.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { createTestableMcpServer } from './server.js';
import type { AuthContext } from '../middleware/auth.js';

vi.mock('../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

let adminId: string;
let memId: string;
let memUrn: string;
const admin = (): Context => ({ db, roles: ['ADMIN'], userId: adminId } as Context);
const adminAuth = (): AuthContext => ({ userId: adminId, roles: ['ADMIN'], clientId: `user:${adminId}` });
const call = (tool: string, args: Record<string, unknown>) => createTestableMcpServer(adminAuth()).callToolText(tool, args);

const schema = {
  objectTypes: {
    rec: { strict: true, fields: { alpha_f: { type: 'text' }, beta_f: { type: 'number' } } },
    loose: { fields: { alpha_f: { type: 'text' } } },
  },
};

beforeEach(async () => {
  await cleanDb(db);
  const org = await db.organization.create({ data: { id: generateId(), name: 'fndm-org', urn: 'fndm-org' } });
  const a = await db.user.create({ data: { githubId: 7771, githubUsername: 'fndm-admin', roles: ['ADMIN'] } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: a.id, role: 'ADMIN' } });
  adminId = a.id;
  const mem = await resolvers.Mutation.createMemory({}, { orgRef: org.id, name: 'intel' }, admin());
  memId = mem.id;
  memUrn = mem.urn;
  await (resolvers.Mutation as any).updateMemory(null, { ref: memId, schema }, admin());
  for (const [type, loc, properties] of [['rec', 'one', { alpha_f: 'a1' }], ['loose', 'one', { alpha_f: 'a1', free: 'x' }]] as const) {
    await db.node.create({ data: { id: generateId(), memoryId: memId, loc: `${type}:${loc}`, name: loc, objectType: type, properties: properties as never } as never });
  }
});

describe('#725 hadron_find_objects over MCP', () => {
  it.each([
    ['a match key', { match: { nope: 'x' } }],
    ['a where leaf', { where: { path: ['nope'], eq: 'x' } }],
    ['the sort key', { sort: { nope: 'asc' } }],
  ])('%s is the bracket refusal with the fixed message', async (_n, args) => {
    const text = await call('hadron_find_objects', { memoryUrn: memUrn, type: 'rec', ...args });
    expect(text).toBe('[field_not_declared] Field "nope" is not declared in strict collection "rec".');
    expect(text).not.toMatch(/alpha_f|beta_f/);
  });

  it('control: a declared field returns rows, a non-strict collection returns rows for any field', async () => {
    const declared = JSON.parse(await call('hadron_find_objects', { memoryUrn: memUrn, type: 'rec', match: { alpha_f: 'a1' } }));
    expect(declared.total).toBe(1);
    const loose = JSON.parse(await call('hadron_find_objects', { memoryUrn: memUrn, type: 'loose', match: { free: 'x' } }));
    expect(loose.total).toBe(1);
  });

  it('control: malformed input stays an ordinary Error, not the refusal', async () => {
    const text = await call('hadron_find_objects', { memoryUrn: memUrn, type: 'rec', match: { nope: 'x' }, sort: { a: 'asc', b: 'desc' } });
    expect(text).toMatch(/^Error:/);
    expect(text).not.toMatch(/field_not_declared/);
  });
});
