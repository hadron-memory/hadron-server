/**
 * #5003 (hrn:node:hadronmemory.com:specs:cor:dmo:050:17) — `appMemoryScope`'s `AppScopedMemory` leaf carries the memory's
 * `visibility`, WHERE THE RECORD GATE (`canReadMemoryRecord`, the one `Query.memory` applies) admits the caller, null
 * otherwise, exactly as `description` (#4890). The leaf stays a leaf; a refused row is still listed.
 *
 * `Memory.visibility` is nullable (035: set only for knowledge and group), so a null on the row means EITHER withheld OR
 * not applicable, and the field must not claim to say which. Only `group` is forced non-null (chk_memory_group_visibility).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildSchema, isEnumType, getNamedType, type GraphQLObjectType } from 'graphql';
import { createServerOnCleanDb } from '../../../test/startServerFixture.js';
import { mintUserApiKey } from '../../../middleware/auth.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const Q = resolvers.Query as any;

type Row = { memoryId: string; name: string; class: string; visibility: string | null; description: string | null };

let n: number;
let org: { id: string; urn: string };
let appId: string;
const user: Record<string, string> = {};
const mem: Record<string, string> = {};
let alphaId: string;

const ctx = (who: string): Context => ({ db, userId: user[who], roles: ['READER'] });

async function memory(key: string, data: { class?: string; visibility?: string | null; appId?: string; sharedMemoryOfAgentId?: string; isEncrypted?: boolean } = {}) {
  mem[key] = (await db.memory.create({
    data: {
      class: (data.class ?? 'knowledge') as any,
      visibility: (data.visibility ?? null) as any,
      organizationId: org.id,
      name: key,
      urn: `${org.urn}:${key.toLowerCase()}`,
      appId: data.appId ?? null,
      sharedMemoryOfAgentId: data.sharedMemoryOfAgentId ?? null,
      description: `d-${key}`,
      isEncrypted: data.isEncrypted ?? false,
    },
  })).id;
  await db.node.create({ data: { memoryId: mem[key], loc: `notes:${key.toLowerCase()}`, name: key, content: key } });
  return mem[key]!;
}

async function scopeAll(who: string): Promise<Row[]> {
  const page = await Q.appMemoryScope({}, { appRef: appId, limit: 200 }, ctx(who));
  return page.items as Row[];
}
const byKey = (rows: Row[], key: string) => rows.find((r) => r.memoryId === mem[key])!;

beforeEach(async () => {
  await cleanDb(db);
  n = Math.floor(Math.random() * 1_000_000);
  org = await db.organization.create({ data: { name: 'Scope', urn: `scope5003-${n}.example` }, select: { id: true, urn: true } });
  for (const who of ['reader', 'member', 'admin']) {
    user[who] = (await db.user.create({ data: { handle: `s5003-${who}-${n}`, roles: ['READER'] } })).id;
  }
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.reader!, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.member!, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: org.id, userId: user.admin!, role: 'ADMIN' } });
  appId = (await db.app.create({ data: { name: 'App', urn: `${org.urn}:app`, organizationId: org.id } })).id;
  await db.appMember.create({ data: { appId, userId: user.member!, role: 'member' } });

  const sys = await db.memory.create({ data: { class: 'system', organizationId: org.id, name: 'Alpha system', urn: `${org.urn}:alpha-system`, description: 'd-sys' } });
  mem.sysAlpha = sys.id;
  await db.node.create({ data: { memoryId: sys.id, loc: 'notes:alpha', name: 'Alpha', content: 'Alpha' } });
  alphaId = (await db.agent.create({ data: { organizationId: org.id, name: 'Alpha', urn: `${org.urn}:alpha`, visibility: 'ORGANIZATION', systemMemoryId: sys.id } })).id;
  await db.appAgent.create({ data: { appId, agentId: alphaId } });

  await memory('KnowPub', { visibility: 'PUBLIC' });
  await memory('KnowOrg', { visibility: 'ORGANIZATION' });
  await memory('KnowNone', { visibility: null });
  await memory('KnowEnc', { visibility: 'ORGANIZATION', isEncrypted: true });
  await memory('GroupMem', { class: 'group', visibility: 'GROUP' });
  await memory('TeamSpace', { class: 'app', appId, sharedMemoryOfAgentId: alphaId });
  for (const k of ['KnowPub', 'KnowOrg', 'KnowNone', 'KnowEnc', 'GroupMem']) {
    await db.agentMemoryItem.create({ data: { agentId: alphaId, memoryId: mem[k]!, role: 'read' } });
  }
});

describe('#5003 — the SDL contract of the leaf', () => {
  const leaf = () => {
    const schema = buildSchema(typeDefs.replace(/^#graphql/, ''));
    return schema.getType('AppScopedMemory') as GraphQLObjectType;
  };

  it('declares visibility: MemoryVisibility, nullable, and stays a leaf (scalars and enums only)', () => {
    const field = leaf().getFields().visibility;
    expect(field, 'AppScopedMemory.visibility').toBeDefined();
    expect(String(field!.type)).toBe('MemoryVisibility');
    expect(isEnumType(getNamedType(field!.type))).toBe(true);
    // Nothing nested: every field but `sources` is a scalar or an enum, as before.
    for (const [name, f] of Object.entries(leaf().getFields())) {
      if (name === 'sources') continue;
      const t = getNamedType(f.type);
      expect(['ID', 'String', 'Boolean', 'MemoryClass', 'MemoryVisibility'], `AppScopedMemory.${name}`).toContain(t.name);
    }
  });

  it('its text says null is EITHER withheld OR not applicable, and does not claim to tell which', () => {
    const text = leaf().getFields().visibility!.description ?? '';
    expect(text).toMatch(/withheld/i);
    expect(text).toMatch(/not applicable|no visibility/i);
    expect(text).toMatch(/not distinguishable|cannot tell|does not say/i);
    // The description's own framing ("no description set") must not be copied.
    expect(text).not.toMatch(/no description/i);
  });
});

describe('#5003 — visibility rides the record gate, not the row\'s audience', () => {
  it('a readable knowledge or group row returns its value; a knowledge row with none returns null', async () => {
    const rows = await scopeAll('member');
    expect(byKey(rows, 'KnowPub').visibility).toBe('PUBLIC');
    expect(byKey(rows, 'KnowOrg').visibility).toBe('ORGANIZATION');
    expect(byKey(rows, 'GroupMem').visibility).toBe('GROUP');
    // A knowledge memory may legitimately have none: null, with the row readable (description proves the gate admitted it).
    expect(byKey(rows, 'KnowNone').visibility).toBeNull();
    expect(byKey(rows, 'KnowNone').description).toBe('d-KnowNone');
  });

  it('an app, system, personal or private row the caller can read shows null', async () => {
    const rows = await scopeAll('member');
    expect(byKey(rows, 'TeamSpace').description).toBe('d-TeamSpace'); // readable
    expect(byKey(rows, 'TeamSpace').visibility).toBeNull();
  });

  it('an encrypted memory\'s row carries the visibility with no key in play (the record is never enciphered)', async () => {
    expect(byKey(await scopeAll('member'), 'KnowEnc').visibility).toBe('ORGANIZATION');
  });

  it('a row the record gate refuses is still listed, with visibility null (and description null)', async () => {
    // chk_memory_visibility_class: only knowledge and group memories can carry a visibility, so a system, app, personal or
    // private row is null in the database as well. The withholding itself is pinned where a stored value exists: the
    // soft-deleted pin below. Preconditions, so the scenario cannot silently weaken: an org READER cannot open the system
    // record (its row is still in the scope), so the App lens and the record gate genuinely differ for it.
    expect(await Q.memory({}, { ref: mem.sysAlpha! }, ctx('reader'))).toBeNull();
    const rows = await scopeAll('reader');
    const sysAlpha = byKey(rows, 'sysAlpha');
    expect(sysAlpha, 'the refused row is still listed').toBeDefined();
    expect(sysAlpha.description).toBeNull();
    expect(sysAlpha.visibility).toBeNull();
  });

  it('is exactly what Query.memory returns for the same caller, row by row, for every principal', async () => {
    for (const who of ['reader', 'member', 'admin']) {
      for (const row of await scopeAll(who)) {
        const record = await Q.memory({}, { ref: row.memoryId }, ctx(who));
        expect(row.visibility, `${who} on ${row.name}`).toBe(record ? (record.visibility ?? null) : null);
      }
    }
  });

  it('a soft-deleted row keeps the existing behaviour: withheld, like the description', async () => {
    const page = await Q.appMemoryScope({}, { appRef: appId, limit: 200 }, {
      ...ctx('member'),
      db: new Proxy(db, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop !== 'memory') return typeof value === 'function' ? value.bind(target) : value;
          return new Proxy(value as object, {
            get(m, p) {
              const v = Reflect.get(m, p, m);
              if (p !== 'findMany' || typeof v !== 'function') return typeof v === 'function' ? v.bind(m) : v;
              return async (args: { select?: { visibility?: boolean; deletedAt?: boolean } }) => {
                const rows = await (v as (a: unknown) => Promise<Array<Record<string, unknown>>>).call(m, args);
                // Only the page read selects the gate fields: stamp one row deleted between the two reads.
                if (args?.select?.deletedAt === true) {
                  return rows.map((r) => (r.id === mem.KnowPub ? { ...r, deletedAt: new Date() } : r));
                }
                return rows;
              };
            },
          });
        },
      }) as typeof db,
    });
    const gone = (page.items as Row[]).find((r) => r.memoryId === mem.KnowPub)!;
    expect(gone, 'still listed').toBeDefined();
    expect(gone.description).toBeNull();
    expect(gone.visibility).toBeNull();
  });
});

describe('#5003 — over the real GraphQL HTTP boundary', () => {
  let server: Server;
  let baseUrl: string;
  beforeAll(async () => {
    server = createHttpServer(await createServerOnCleanDb());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  const keyFor = async (who: string) =>
    (await mintUserApiKey(db, { userId: user[who]!, label: null, createdBy: user[who]!, issuedVia: 'test' })).rawKey;
  const post = async (bearer: string, query: string, variables: Record<string, unknown> = {}) => {
    const response = await fetch(`${baseUrl}/graphql`, {
      method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    return response.json() as Promise<{ data?: any; errors?: Array<{ message: string }> }>;
  };
  const SCOPE = 'query($a: ID!) { appMemoryScope(appRef: $a, limit: 200) { total items { memoryId name visibility description } } }';

  it('serves visibility on the wire as the enum, with the same withholding as description', async () => {
    const admin = await post(await keyFor('admin'), SCOPE, { a: appId });
    expect(admin.errors).toBeUndefined();
    const adminRows = admin.data.appMemoryScope.items as Row[];
    expect(byKey(adminRows, 'KnowPub').visibility).toBe('PUBLIC');
    expect(byKey(adminRows, 'GroupMem').visibility).toBe('GROUP');
    expect(byKey(adminRows, 'sysAlpha').visibility).toBeNull(); // a system memory has no visibility (chk_memory_visibility_class)
    const reader = await post(await keyFor('reader'), SCOPE, { a: appId });
    expect(reader.errors).toBeUndefined();
    const readerRows = reader.data.appMemoryScope.items as Row[];
    expect(byKey(readerRows, 'KnowPub').visibility).toBe('PUBLIC');
    expect(byKey(readerRows, 'sysAlpha').description).toBeNull();
    expect(byKey(readerRows, 'sysAlpha').visibility).toBeNull();
  });
});
