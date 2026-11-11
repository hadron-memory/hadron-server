/**
 * #3917 — global search finds an AiServiceConfig by its `hrn:aiconf:` URN, and
 * the WHOLE aiconf adapter (urn, name, pk) sits behind the id read's gate.
 *
 * Contract under test (gate comment, Victor's FIT condition; cor:api:050:01-03,
 * cor:urn:010:01 V63):
 *   - an `hrn:aiconf:` query matches the config's COMPUTED URN (substring,
 *     case-insensitive, via the existing URN sniff), and the hit carries the URN;
 *   - a caller below org ADMIN gets nothing on urn, name AND pk, and the answer
 *     is the same as for a config that does not exist (no hit, same total);
 *   - the visible set is exactly what `aiServiceConfig(ref: id)` reads, for every
 *     owner shape and caller shape (differential);
 *   - the read filter applies in the candidate query, so unreadable rows neither
 *     count toward `total` nor crowd readable ones out of the cap.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { resolvers, type Context } from '../../api/graphql/schema/resolvers.js';
import { globalSearch } from './index.js';
import { createTestableMcpServer } from '../../mcp/server.js';
import type { SearchPrincipal } from './types.js';

const Q = resolvers.Query as any;
const sfx = () => `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;

let org: { id: string; urn: string };
let otherOrg: { id: string; urn: string };
const u: Record<string, { id: string }> = {};
let cfg: Record<string, { id: string; urn: string | null }>;

const mkUser = (n: number, roles: string[] = ['READER']) =>
  db.user.create({ data: { id: generateId(), githubId: 391700 + n, githubUsername: `gs3917-${n}-${sfx()}`, roles: roles as never } });
const imp = (adminOf: string, orgId: string) =>
  ({ sessionId: 's', actorUserId: u.padmin!.id, orgId, expiresAt: new Date(Date.now() + 60_000) }) as NonNullable<Context['impersonation']>;
const ctxOf = (who: string): Context =>
  who === 'padmin' ? { db, userId: u.padmin!.id, roles: ['ADMIN'] }
  : who === 'anon' ? { db, roles: [] }
  // An impersonated session sees into its ONE shared org and never a user-owned row (identity-scoped).
  : who === 'impOrgAdmin' ? { db, userId: u.orgAdmin!.id, roles: [], impersonation: imp('orgAdmin', org.id) }
  : who === 'impOtherOrg' ? { db, userId: u.orgAdmin!.id, roles: [], impersonation: imp('orgAdmin', otherOrg.id) }
  : who === 'impAppOwner' ? { db, userId: u.appOwner!.id, roles: [], impersonation: imp('appOwner', org.id) }
  : { db, userId: u[who]!.id, roles: ['READER'] };

beforeEach(async () => {
  await cleanDb(db);
  const s = sfx();
  org = await db.organization.create({ data: { id: generateId(), name: 'gs3917-org', urn: `gs3917-org-${s}.com` } });
  otherOrg = await db.organization.create({ data: { id: generateId(), name: 'gs3917-other', urn: `gs3917-other-${s}.com` } });
  u.padmin = await mkUser(1, ['ADMIN']);
  u.orgAdmin = await mkUser(2);
  u.orgOwner = await mkUser(3);
  u.contrib = await mkUser(4);
  u.reader = await mkUser(5);
  u.appOwner = await mkUser(6);
  u.agentOwner = await mkUser(7);
  u.outsider = await mkUser(8);
  u.otherAdmin = await mkUser(9);
  u.revoked = await mkUser(10);
  const member = (userId: string, organizationId: string, role: string) =>
    db.orgMember.create({ data: { id: generateId(), organizationId, userId, role: role as never } });
  await member(u.orgAdmin!.id, org.id, 'ADMIN');
  await member(u.orgOwner!.id, org.id, 'OWNER');
  await member(u.contrib!.id, org.id, 'CONTRIBUTOR');
  await member(u.reader!.id, org.id, 'READER');
  await member(u.otherAdmin!.id, otherOrg.id, 'ADMIN');
  // A REVOKED admin membership must not authorize (PR #475).
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: u.revoked!.id, role: 'ADMIN', deletedAt: new Date() } });

  const orgApp = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Meal Plan', urn: `${org.urn}:mealplan` } });
  const userApp = await db.app.create({
    data: { id: generateId(), organizationId: null, ownerUserId: u.appOwner!.id, name: 'Own App', urn: `@gs3917app${s.replace(/\D/g, '')}:ownapp` },
  });
  const orgAgent = await db.agent.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:juno`, name: 'Juno', visibility: 'ORGANIZATION' },
  });
  const retiredAgent = await db.agent.create({
    data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:gone`, name: 'Gone', visibility: 'ORGANIZATION', deletedAt: new Date() },
  });
  const userAgent = await db.agent.create({
    data: { id: generateId(), organizationId: null, ownerUserId: u.agentOwner!.id, urn: `@gs3917ag${s.replace(/\D/g, '')}:mine`, name: 'Mine', visibility: 'PERSONAL', createdBy: u.agentOwner!.id },
  });
  const retiredUserAgent = await db.agent.create({
    data: { id: generateId(), organizationId: null, ownerUserId: u.agentOwner!.id, urn: `@gs3917rt${s.replace(/\D/g, '')}:gone`, name: 'Gone', visibility: 'PERSONAL', createdBy: u.agentOwner!.id, deletedAt: new Date() },
  });
  const server = await db.hadronServer.create({ data: { id: generateId(), url: 'https://gs3917.test' } });

  const mk = async (name: string, owner: Record<string, string>) => {
    const row = await db.aiServiceConfig.create({ data: { id: generateId(), name, provider: 'anthropic', model: 'm', ...owner } });
    return { id: row.id, urn: null as string | null };
  };
  cfg = {
    org: await mk('gsdefault', { organizationId: org.id }),
    orgApp: await mk('gsdefault', { appId: orgApp.id }),
    userApp: await mk('gsdefault', { appId: userApp.id }),
    orgAgent: await mk('gsdefault', { agentId: orgAgent.id }),
    userAgent: await mk('gsdefault', { agentId: userAgent.id }),
    retiredAgent: await mk('gsdefault', { agentId: retiredAgent.id }),
    retiredUserAgent: await mk('gsdefault', { agentId: retiredUserAgent.id }),
    server: await mk('gsdefault', { hadronServerId: server.id }),
    other: await mk('gsdefault', { organizationId: otherOrg.id }),
  };
  // The URN each config carries, as the platform emits it (the AiServiceConfig.urn field).
  for (const k of Object.keys(cfg)) {
    // Fetched as a caller the gate admits (user-owned shapes are their owner's alone; the platform admin is denied them).
    const reader = k === 'userApp' ? 'appOwner' : k === 'userAgent' || k === 'retiredUserAgent' ? 'agentOwner' : 'padmin';
    const row = await Q.aiServiceConfig(null, { ref: cfg[k]!.id }, ctxOf(reader)).catch(() => null);
    cfg[k]!.urn = row ? await (resolvers as any).AiServiceConfig.urn(row, {}, ctxOf(reader)) : null;
  }
});

const search = (who: string, query: string, extra: Record<string, unknown> = {}) =>
  Q.globalSearch({}, { query, entityTypes: ['aiServiceConfig'], ...extra }, ctxOf(who)) as Promise<{
    hits: Array<{ id: string; urn: string | null; matchedField: string; name: string }>;
    total: number;
  }>;
const idsOf = (r: { hits: Array<{ id: string }> }) => new Set(r.hits.map((h) => h.id));
/** The id read: the gate this search must equal. */
const canReadById = async (who: string, id: string) => {
  try {
    return (await Q.aiServiceConfig(null, { ref: id }, ctxOf(who))) !== null;
  } catch {
    return false;
  }
};

describe('#3917 — the URN leg', () => {
  it('finds each readable config by its full hrn:aiconf URN and carries the URN on the hit', async () => {
    expect(cfg.org!.urn).toMatch(/^hrn:aiconf:/);
    const r = await search('orgAdmin', cfg.org!.urn!);
    expect(idsOf(r)).toEqual(new Set([cfg.org!.id]));
    expect(r.hits[0]).toMatchObject({ matchedField: 'urn', urn: cfg.org!.urn });
    for (const k of ['orgApp', 'orgAgent'] as const) {
      const hit = await search('orgAdmin', cfg[k]!.urn!);
      expect(idsOf(hit)).toEqual(new Set([cfg[k]!.id]));
      expect(hit.hits[0]!.urn).toBe(cfg[k]!.urn);
    }
    const server = await search('padmin', 'hrn:aiconf:server:gsdefault');
    expect(idsOf(server)).toContain(cfg.server!.id);
  });

  it('matches a partial and an upper-cased URN (substring, case-insensitive; cor:api:050:01)', async () => {
    const urn = cfg.org!.urn!;
    expect(idsOf(await search('orgAdmin', urn.toUpperCase()))).toEqual(new Set([cfg.org!.id]));
    expect(idsOf(await search('orgAdmin', urn.slice('hrn:aiconf:'.length)))).toEqual(new Set([cfg.org!.id]));
  });
});

describe('#3917 — personal-owner URNs are real and gated', () => {
  it('a user-owned App and Agent config carry a URN, found by their owner and nobody else', async () => {
    for (const [k, owner, other] of [['userApp', 'appOwner', 'agentOwner'], ['userAgent', 'agentOwner', 'appOwner']] as const) {
      expect(cfg[k]!.urn, k).toMatch(/^hrn:aiconf:/);
      expect(idsOf(await search(owner, cfg[k]!.urn!, { fields: ['urn'] }))).toEqual(new Set([cfg[k]!.id]));
      for (const who of [other, 'padmin', 'orgAdmin', 'outsider']) {
        expect((await search(who, cfg[k]!.urn!, { fields: ['urn'] })).hits, `${who} / ${k}`).toEqual([]);
      }
    }
  });
});

describe('#3917 — a caller below ADMIN finds nothing, on urn, name and pk', () => {
  for (const who of ['contrib', 'reader', 'outsider', 'anon'] as const) {
    it(`${who}: every field answers as for a config that does not exist`, async () => {
      const queries = [cfg.org!.urn!, 'gsdefault', cfg.org!.id];
      for (const q of queries) {
        const real = await search(who, q);
        const absent = await search(who, q.replace(/gsdefault|[0-9a-f]{32}/i, 'gsnothere'));
        expect(real.hits, `${who} ${q}`).toEqual([]);
        expect(real.total).toBe(absent.total);
        expect(real.total).toBe(0);
      }
      for (const fields of [['urn'], ['name'], ['pk']] as const) {
        const q = fields[0] === 'urn' ? cfg.org!.urn! : fields[0] === 'pk' ? cfg.org!.id : 'gsdefault';
        expect((await search(who, q, { fields })).hits, `${who} ${fields[0]}`).toEqual([]);
      }
    });
  }

  it('an org ADMIN and OWNER still find their own org config on all three fields', async () => {
    for (const who of ['orgAdmin', 'orgOwner']) {
      for (const [fields, q] of [[['urn'], cfg.org!.urn!], [['name'], 'gsdefault'], [['pk'], cfg.org!.id]] as const) {
        expect(idsOf(await search(who, q, { fields })), `${who} ${fields[0]}`).toContain(cfg.org!.id);
      }
    }
  });
});

describe('#3917 — search visibility equals the id read, for every owner and caller shape', () => {
  const callers = ['padmin', 'orgAdmin', 'orgOwner', 'contrib', 'reader', 'appOwner', 'agentOwner', 'outsider', 'otherAdmin', 'revoked', 'impOrgAdmin', 'impOtherOrg', 'impAppOwner', 'anon'];
  for (const who of callers) {
    it(`${who}: the name search returns exactly what the id read allows`, async () => {
      const found = idsOf(await search(who, 'gsdefault', { fields: ['name'] }));
      for (const [k, c] of Object.entries(cfg)) {
        expect(found.has(c.id), `${who} / ${k}: search ${found.has(c.id)} vs id read`).toBe(await canReadById(who, c.id));
      }
    });
    it(`${who}: the URN search returns exactly what the id read allows`, async () => {
      for (const [k, c] of Object.entries(cfg)) {
        if (!c.urn) continue;
        const found = idsOf(await search(who, c.urn, { fields: ['urn'] }));
        expect(found.has(c.id), `${who} / ${k}`).toBe(await canReadById(who, c.id));
      }
    });
  }
});

describe('#3917 — an org-confined search narrows, never widens', () => {
  it('orgId confines a platform admin to that org\'s configs (no server-owned, no user-owned)', async () => {
    // orgId is member-only (no platform bypass), so the admin joins the org first.
    await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: u.padmin!.id, role: 'READER' } });
    const r = await search('padmin', 'gsdefault', { fields: ['name'], orgId: org.id });
    expect(idsOf(r)).toEqual(new Set([cfg.org!.id, cfg.orgApp!.id, cfg.orgAgent!.id]));
    expect(r.total).toBe(3);
  });
  it('orgId drops a user-owned App\'s config even for its owner', async () => {
    await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: u.appOwner!.id, role: 'READER' } });
    expect((await search('appOwner', 'gsdefault', { fields: ['name'], orgId: org.id })).hits).toEqual([]);
    expect(idsOf(await search('appOwner', 'gsdefault', { fields: ['name'] }))).toEqual(new Set([cfg.userApp!.id]));
  });
});

describe('#3917 — the URN scan is bounded and says so', () => {
  it('past 2000 readable configs the URN leg reads the first 2000 and reports the degradation', async () => {
    const rows = Array.from({ length: 2001 }, (_, i) => ({
      id: generateId(), name: `gsbulk-${i}`, provider: 'anthropic', model: 'm', organizationId: otherOrg.id,
    }));
    await db.aiServiceConfig.createMany({ data: rows });
    const run = (viewerUserId: string) =>
      globalSearch(
        db,
        { query: 'hrn:aiconf:', entityTypes: ['aiServiceConfig'], fields: ['urn'], limit: 5 },
        { viewerUserId, isPlatformAdmin: false, accessibleMemoryIds: [], orgIds: [otherOrg.id], viewerOrgIds: [otherOrg.id] },
      );
    const big = await run(u.otherAdmin!.id);
    expect(big.degraded.some((d) => d.includes('2000'))).toBe(true);
    // Under the bound nothing is reported.
    const small = await globalSearch(
      db,
      { query: 'hrn:aiconf:', entityTypes: ['aiServiceConfig'], fields: ['urn'], limit: 5 },
      { viewerUserId: u.orgAdmin!.id, isPlatformAdmin: false, accessibleMemoryIds: [], orgIds: [org.id], viewerOrgIds: [org.id] },
    );
    expect(small.degraded).toEqual([]);
  });
});

describe('#3917 — the filter is in the candidate query', () => {
  it('unreadable matches do not crowd a readable one out of the cap, or count toward total', async () => {
    // Many unreadable configs match the same name; the one readable config must still be found.
    const rows = Array.from({ length: 150 }, (_, i) => ({
      id: generateId(), name: `gscrowd-${i}`, provider: 'anthropic', model: 'm', organizationId: otherOrg.id,
    }));
    await db.aiServiceConfig.createMany({ data: rows });
    await db.aiServiceConfig.create({ data: { id: generateId(), name: 'gscrowd-mine', provider: 'anthropic', model: 'm', organizationId: org.id } });
    const r = await search('orgAdmin', 'gscrowd', { fields: ['name'], limit: 50 });
    expect(r.hits.map((h) => h.name)).toEqual(['gscrowd-mine']);
    expect(r.total).toBe(1);
  });
});

// The surfaces narrow `orgIds` themselves (member orgs, the impersonation org), so the engine's own guards are
// pinned here with principals those surfaces would never build: the filter must hold on its own.
describe('#3917 — the engine holds without the surface\'s narrowing', () => {
  const engine = async (p: Partial<SearchPrincipal>) =>
    idsOf(
      await globalSearch(
        db,
        { query: 'gsdefault', entityTypes: ['aiServiceConfig'], fields: ['name'] },
        { viewerUserId: null, isPlatformAdmin: false, accessibleMemoryIds: [], orgIds: [], viewerOrgIds: [], ...p },
      ),
    );

  it('a revoked admin membership does not authorize, whatever orgIds says', async () => {
    expect(await engine({ viewerUserId: u.revoked!.id, orgIds: [org.id] })).toEqual(new Set());
  });
  it('orgIds narrows an admin of several orgs to the listed ones', async () => {
    await db.orgMember.create({ data: { id: generateId(), organizationId: otherOrg.id, userId: u.orgAdmin!.id, role: 'ADMIN' } });
    expect(await engine({ viewerUserId: u.orgAdmin!.id, orgIds: [otherOrg.id] })).toEqual(new Set([cfg.other!.id]));
    expect(await engine({ viewerUserId: u.orgAdmin!.id, orgIds: [org.id] })).toEqual(
      new Set([cfg.org!.id, cfg.orgApp!.id, cfg.orgAgent!.id]),
    );
  });
  it('an impersonated session sees only its one org, and the platform bypass is inert', async () => {
    await db.orgMember.create({ data: { id: generateId(), organizationId: otherOrg.id, userId: u.orgAdmin!.id, role: 'ADMIN' } });
    expect(await engine({ viewerUserId: u.orgAdmin!.id, orgIds: null, impersonationOrgId: org.id })).toEqual(
      new Set([cfg.org!.id, cfg.orgApp!.id, cfg.orgAgent!.id]),
    );
    // A platform admin flag under impersonation grants nothing beyond the one org the admin belongs to.
    expect(await engine({ viewerUserId: u.padmin!.id, isPlatformAdmin: true, orgIds: null, impersonationOrgId: org.id })).toEqual(new Set());
  });

  // Atilla's BLIND P2: orgScopeId must confine org results by itself, not only drop the user-owned arms.
  it('orgScopeId with orgIds:null confines an org admin of several orgs to the scoped one', async () => {
    await db.orgMember.create({ data: { id: generateId(), organizationId: otherOrg.id, userId: u.orgAdmin!.id, role: 'ADMIN' } });
    expect(await engine({ viewerUserId: u.orgAdmin!.id, orgIds: null, orgScopeId: org.id })).toEqual(
      new Set([cfg.org!.id, cfg.orgApp!.id, cfg.orgAgent!.id]),
    );
    expect(await engine({ viewerUserId: u.orgAdmin!.id, orgIds: null, orgScopeId: otherOrg.id })).toEqual(new Set([cfg.other!.id]));
  });
  it('orgScopeId with orgIds:null confines a platform admin to that org: no other org, no server-owned config', async () => {
    expect(await engine({ viewerUserId: u.padmin!.id, isPlatformAdmin: true, orgIds: null, orgScopeId: org.id })).toEqual(
      new Set([cfg.org!.id, cfg.orgApp!.id, cfg.orgAgent!.id]),
    );
  });
  it('orgScopeId outside the listed orgIds finds nothing', async () => {
    expect(await engine({ viewerUserId: u.padmin!.id, isPlatformAdmin: true, orgIds: [org.id], orgScopeId: otherOrg.id })).toEqual(new Set());
  });
});

// Rodolfo's §10 findings: the MCP surface must bound an impersonated session like GraphQL; a deleted org's configs
// are absent to the id read; another server's config has no URN here.
describe('#3917 — MCP hadron_search equals the id read under impersonation', () => {
  const mcp = (who: string, q: string) => {
    const c = ctxOf(who);
    const auth = { userId: c.userId, roles: c.roles, clientId: `user:${c.userId}`, impersonation: c.impersonation } as never;
    return createTestableMcpServer(auth).callToolText('hadron_search', { query: q, entityTypes: ['aiServiceConfig'], fields: ['name'] });
  };
  it('an impersonated org admin sees its one org\'s configs and never a user-owned one or another org\'s', async () => {
    const text = await mcp('impOrgAdmin', 'gsdefault');
    for (const k of ['org', 'orgApp', 'orgAgent']) expect(text, k).toContain(cfg[k]!.urn!);
    for (const k of ['userApp', 'userAgent', 'other', 'server']) expect(text, k).not.toContain(cfg[k]!.urn!);
  });
  it('an impersonated user-owned App owner finds nothing', async () => {
    const text = await mcp('impAppOwner', 'gsdefault');
    for (const k of Object.keys(cfg)) expect(text, k).not.toContain(cfg[k]!.urn!);
  });
  it('the un-impersonated owner still finds their own App\'s config', async () => {
    expect(await mcp('appOwner', 'gsdefault')).toContain(cfg.userApp!.urn!);
  });
});

describe('#3917 — a deleted organization and another server', () => {
  it('a platform admin does not find a soft-deleted org\'s configs (the id read refuses them)', async () => {
    await db.organization.update({ where: { id: otherOrg.id }, data: { deletedAt: new Date() } });
    expect(await canReadById('padmin', cfg.other!.id)).toBe(false);
    expect(idsOf(await search('padmin', 'gsdefault', { fields: ['name'] })).has(cfg.other!.id)).toBe(false);
    expect(idsOf(await search('padmin', 'gsdefault', { fields: ['name'] })).has(cfg.org!.id)).toBe(true);
  });
  it('a config of a server that is not the one answering has no URN, so the URN leg never finds it', async () => {
    await db.hadronServer.create({ data: { id: generateId(), url: 'https://other-server.test', createdAt: new Date(Date.now() + 60_000) } });
    const other = await db.hadronServer.findFirstOrThrow({ where: { url: 'https://other-server.test' } });
    await db.aiServiceConfig.create({ data: { id: generateId(), name: 'gsforeign', provider: 'anthropic', model: 'm', hadronServerId: other.id } });
    expect((await search('padmin', 'hrn:aiconf:server:gsforeign', { fields: ['urn'] })).hits).toEqual([]);
    expect(idsOf(await search('padmin', 'hrn:aiconf:server:gsdefault', { fields: ['urn'] }))).toContain(cfg.server!.id);
  });
});
