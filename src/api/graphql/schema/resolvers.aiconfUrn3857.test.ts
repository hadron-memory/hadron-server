/**
 * #3857 — the AI service config URN.
 *
 *   hrn:aiconf:<org>:org:<name>
 *   hrn:aiconf:<root>:app:<app-slug>:<name>
 *   hrn:aiconf:<author-root>:agent:<agent-slug>:<name>
 *   hrn:aiconf:server:<name>            (HadronServer owner, reserved root)
 *
 * Spec: cor:urn:010:01 (the aiconf clause, V60-V63 as amended by Holger R3),
 * cor:api:120:01. The contract lines under test:
 *   - `AiServiceConfig.urn` is COMPUTED from the owner's current URN + the name;
 *     null (logged) for a name that cannot be a URN atom (trailing `-` / `_`);
 *   - `resolveUrn` and `aiServiceConfig(ref:)` accept it behind the SAME gate as
 *     the id read, and on the URN path an unreadable config answers exactly as
 *     a missing one (null) on BOTH entry points (V63);
 *   - a URN naming the wrong owner kind names nothing;
 *   - an owner rename keeps the URN resolving; a config rename leaves no alias;
 *   - `platform` / `server` cannot be minted as a root.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { encryptToken } from '../../../lib/tokenCrypto.js';
import { ApolloServer } from '@apollo/server';
import { mintPrincipal, RootNameTakenError } from '../../../lib/principal/mintPrincipal.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;
const T = (resolvers as any).AiServiceConfig as { urn: (c: unknown, a: unknown, ctx: Context) => Promise<string | null> };

function ctx(userId?: string, roles: Context['roles'] = ['READER']): Context {
  return { db, userId, roles };
}

let suffix: string;
let org: { id: string; urn: string };
let otherOrg: { id: string; urn: string };
let orgAdmin: { id: string };
let otherAdmin: { id: string };
let member: { id: string };
let platformAdmin: { id: string };
let app: { id: string; urn: string };
let agent: { id: string; urn: string };
let cfg: Record<'org' | 'app' | 'agent' | 'server', { id: string }>;
const SECRET = 'sk-never-reachable-through-the-urn-arm';

const mkUser = (n: number, roles: string[] = ['READER']) =>
  db.user.create({ data: { id: generateId(), githubId: 385700 + n, githubUsername: `aiconf-${n}-${suffix}`, roles: roles as never } });

beforeEach(async () => {
  await cleanDb(db);
  suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'aiconf-org', urn: `aiconf-org-${suffix}.com` } });
  otherOrg = await db.organization.create({ data: { id: generateId(), name: 'aiconf-other', urn: `aiconf-other-${suffix}.com` } });
  orgAdmin = await mkUser(1);
  otherAdmin = await mkUser(2);
  member = await mkUser(3);
  platformAdmin = await mkUser(4, ['ADMIN']);
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: orgAdmin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: member.id, role: 'CONTRIBUTOR' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: otherOrg.id, userId: otherAdmin.id, role: 'ADMIN' } });

  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Meal Plan', urn: `${org.urn}:mealplan` } });
  const ag = await M.createAgent({}, { orgId: org.id, name: 'Juno Coach' }, ctx(orgAdmin.id));
  agent = { id: ag.id, urn: (await db.agent.findUniqueOrThrow({ where: { id: ag.id } })).urn };
  const server = await db.hadronServer.create({ data: { id: generateId(), url: 'https://aiconf.test' } });

  const mk = (owner: Record<string, string>) =>
    db.aiServiceConfig.create({
      data: { id: generateId(), name: 'default', provider: 'anthropic', model: 'm', apiKeyEncrypted: encryptToken(SECRET), apiKeyPreview: '…cret', ...owner },
    });
  cfg = {
    org: await mk({ organizationId: org.id }),
    app: await mk({ appId: app.id }),
    agent: await mk({ agentId: agent.id }),
    server: await mk({ hadronServerId: server.id }),
  };
});

/** The field resolver runs on the row the id read returned, so read it the way a client does. */
const urnOf = async (c: { id: string }, who: Context) => {
  const row = await Q.aiServiceConfig(null, { ref: c.id }, ctx(platformAdmin.id, ['ADMIN']));
  return T.urn(row, {}, who);
};

describe('#3857 — AiServiceConfig.urn is computed for all four owner kinds', () => {
  it('emits the shape per owner kind', async () => {
    const agentSlug = agent.urn.slice(agent.urn.indexOf(':') + 1);
    const agentRoot = agent.urn.slice(0, agent.urn.indexOf(':'));
    const who = ctx(platformAdmin.id, ['ADMIN']);
    expect(await urnOf(cfg.org, who)).toBe(`hrn:aiconf:${org.urn}:org:default`);
    expect(await urnOf(cfg.app, who)).toBe(`hrn:aiconf:${org.urn}:app:mealplan:default`);
    expect(await urnOf(cfg.agent, who)).toBe(`hrn:aiconf:${agentRoot}:agent:${agentSlug}:default`);
    expect(await urnOf(cfg.server, who)).toBe('hrn:aiconf:server:default');
  });

  it('is null for a name that cannot be a URN atom (V62)', async () => {
    const bad = await db.aiServiceConfig.create({
      data: { id: generateId(), name: 'fast-', provider: 'openai', model: 'm', organizationId: org.id },
    });
    expect(await urnOf(bad, ctx(platformAdmin.id, ['ADMIN']))).toBeNull();
    const bad2 = await db.aiServiceConfig.create({
      data: { id: generateId(), name: 'fast_', provider: 'openai', model: 'm', organizationId: org.id },
    });
    expect(await urnOf(bad2, ctx(platformAdmin.id, ['ADMIN']))).toBeNull();
  });
});

describe('#3857 — resolveUrn and aiServiceConfig(ref:) accept the URN behind the id gate', () => {
  const cases = ['org', 'app', 'agent'] as const;
  for (const k of cases) {
    it(`${k}-owned: an authorized caller round-trips on both entry points`, async () => {
      const who = ctx(orgAdmin.id);
      const urn = (await urnOf(cfg[k], who))!;
      expect(urn).toMatch(/^hrn:aiconf:/);
      expect(await Q.resolveUrn(null, { urn }, who)).toMatchObject({ kind: 'aiconf', id: cfg[k].id });
      expect(await Q.aiServiceConfig(null, { ref: urn }, who)).toMatchObject({ id: cfg[k].id, name: 'default' });
    });
  }

  it('server-owned: round-trips for a platform admin as hrn:aiconf:server:default', async () => {
    const who = ctx(platformAdmin.id, ['ADMIN']);
    expect(await Q.resolveUrn(null, { urn: 'hrn:aiconf:server:default' }, who)).toMatchObject({ kind: 'aiconf', id: cfg.server.id });
    expect(await Q.aiServiceConfig(null, { ref: 'hrn:aiconf:server:default' }, who)).toMatchObject({ id: cfg.server.id });
  });

  it('V63: unreadable answers exactly as missing, on BOTH entry points', async () => {
    const readable = (await urnOf(cfg.app, ctx(platformAdmin.id, ['ADMIN'])))!;
    const missing = `hrn:aiconf:${org.urn}:app:mealplan:no-such-config`;
    const callers = [ctx(otherAdmin.id), ctx(member.id), ctx(orgAdmin.id)];
    for (const who of callers.slice(0, 2)) {
      expect(await Q.resolveUrn(null, { urn: readable }, who)).toBeNull();
      expect(await Q.resolveUrn(null, { urn: missing }, who)).toBeNull();
      expect(await Q.aiServiceConfig(null, { ref: readable }, who)).toBeNull();
      expect(await Q.aiServiceConfig(null, { ref: missing }, who)).toBeNull();
    }
    // The server-owned config: an org admin may not read it, and it answers as absent.
    expect(await Q.resolveUrn(null, { urn: 'hrn:aiconf:server:default' }, callers[2])).toBeNull();
    expect(await Q.aiServiceConfig(null, { ref: 'hrn:aiconf:server:default' }, callers[2])).toBeNull();
    expect(await Q.aiServiceConfig(null, { ref: 'hrn:aiconf:server:nope' }, callers[2])).toBeNull();
  });

  it('the id path keeps its posture: a plain member is still Forbidden', async () => {
    await expect(Q.aiServiceConfig(null, { ref: cfg.app.id }, ctx(member.id))).rejects.toThrow('Forbidden');
  });

  it('a URN naming a different owner kind than the config owner names nothing', async () => {
    const who = ctx(platformAdmin.id, ['ADMIN']);
    for (const urn of [
      `hrn:aiconf:${org.urn}:org:default:extra`,
      `hrn:aiconf:${org.urn}:agent:mealplan:default`, // mealplan is an App slug
      `hrn:aiconf:${org.urn}:app:${agent.urn.slice(agent.urn.indexOf(':') + 1)}:default`, // an Agent slug
      `hrn:aiconf:${org.urn}:default`, // no owner kind
      `hrn:aiconf:server:org:default`, // a reserved root takes no kind
      `hrn:aiconf:${org.urn}:bogus:default`,
      `hrn:aiconf:${org.urn}:org:default#data`, // only node/apprun take a fragment
    ]) {
      expect(await Q.resolveUrn(null, { urn }, who)).toBeNull();
      expect(await Q.aiServiceConfig(null, { ref: urn }, who)).toBeNull();
    }
  });

  it('never returns key material through the URN arm', async () => {
    const who = ctx(orgAdmin.id);
    const urn = (await urnOf(cfg.app, who))!;
    const row = await db.aiServiceConfig.findUniqueOrThrow({ where: { id: cfg.app.id } });
    for (const out of [await Q.resolveUrn(null, { urn }, who), await Q.aiServiceConfig(null, { ref: urn }, who)]) {
      const text = JSON.stringify(out);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(row.apiKeyEncrypted!);
      expect(text).not.toContain('apiKeyEncrypted');
    }
  });
});

describe('#3857 — renames (V61)', () => {
  it('an owner rename keeps the old URN resolving; only the new spelling is emitted', async () => {
    const who = ctx(orgAdmin.id);
    const before = (await urnOf(cfg.app, who))!;
    await M.updateApp({}, { ref: app.id, urn: 'dinner-plan' }, who);
    const after = (await urnOf(cfg.app, who))!;
    expect(after).toBe(`hrn:aiconf:${org.urn}:app:dinner-plan:default`);
    expect(await Q.resolveUrn(null, { urn: before }, who)).toMatchObject({ kind: 'aiconf', id: cfg.app.id });
    expect(await Q.aiServiceConfig(null, { ref: before }, who)).toMatchObject({ id: cfg.app.id });
  });

  it('a config rename re-addresses it with NO alias', async () => {
    const who = ctx(orgAdmin.id);
    const old = (await urnOf(cfg.app, who))!;
    await M.updateAiServiceConfig({}, { id: cfg.app.id, name: 'renamed' }, who);
    expect(await urnOf(cfg.app, who)).toBe(`hrn:aiconf:${org.urn}:app:mealplan:renamed`);
    expect(await Q.resolveUrn(null, { urn: old }, who)).toBeNull();
    // …and the old URN now names whichever config of that owner holds the old name.
    const holder = await db.aiServiceConfig.create({
      data: { id: generateId(), name: 'default', provider: 'openai', model: 'm', appId: app.id },
    });
    expect(await Q.resolveUrn(null, { urn: old }, who)).toMatchObject({ kind: 'aiconf', id: holder.id });
  });
});

describe('#3857 — the reserved roots', () => {
  it.each(['platform', 'server', 'Server', 'PLATFORM'])('%s cannot be minted as an org or handle root', async (name) => {
    await expect(mintPrincipal(db, { kind: 'org', name })).rejects.toBeInstanceOf(RootNameTakenError);
    await expect(mintPrincipal(db, { kind: 'user', name })).rejects.toBeInstanceOf(RootNameTakenError);
  });
});

describe('#3857 review — `server` is the server answering, not any HadronServer row', () => {
  it('only the current (oldest live) server\'s config has the URN; another row\'s is null and never resolves', async () => {
    const admin = ctx(platformAdmin.id, ['ADMIN']);
    const second = await db.hadronServer.create({ data: { id: generateId(), url: 'https://second.test', createdAt: new Date(Date.now() + 60_000) } });
    const other = await db.aiServiceConfig.create({
      data: { id: generateId(), name: 'default', provider: 'openai', model: 'm', hadronServerId: second.id },
    });
    expect(await urnOf(cfg.server, admin)).toBe('hrn:aiconf:server:default');
    expect(await urnOf(other, admin)).toBeNull();
    for (const out of [await Q.resolveUrn(null, { urn: 'hrn:aiconf:server:default' }, admin), await Q.aiServiceConfig(null, { ref: 'hrn:aiconf:server:default' }, admin)]) {
      expect(out).toMatchObject({ id: cfg.server.id });
    }
  });

  it('follows the current server: with the first row soft-deleted the second one is current', async () => {
    const admin = ctx(platformAdmin.id, ['ADMIN']);
    const second = await db.hadronServer.create({ data: { id: generateId(), url: 'https://second.test', createdAt: new Date(Date.now() + 60_000) } });
    const other = await db.aiServiceConfig.create({
      data: { id: generateId(), name: 'default', provider: 'openai', model: 'm', hadronServerId: second.id },
    });
    await db.hadronServer.updateMany({ where: { id: { not: second.id } }, data: { deletedAt: new Date() } });
    expect(await urnOf(other, admin)).toBe('hrn:aiconf:server:default');
    expect(await Q.resolveUrn(null, { urn: 'hrn:aiconf:server:default' }, admin)).toMatchObject({ id: other.id });
    expect(await urnOf(cfg.server, admin)).toBeNull();
  });

  it('with no live server row the URN names nothing', async () => {
    await db.hadronServer.updateMany({ data: { deletedAt: new Date() } });
    const admin = ctx(platformAdmin.id, ['ADMIN']);
    expect(await Q.resolveUrn(null, { urn: 'hrn:aiconf:server:default' }, admin)).toBeNull();
    expect(await urnOf(cfg.server, admin)).toBeNull();
  });
});

describe('#3857 review — canonical names, concealment of every owner kind, arity', () => {
  it('a stored name that is not lower-case canonical has no URN, and a URN spelling it names nothing', async () => {
    const admin = ctx(platformAdmin.id, ['ADMIN']);
    const mixed = await db.aiServiceConfig.create({
      data: { id: generateId(), name: 'Mixed', provider: 'openai', model: 'm', organizationId: org.id },
    });
    expect(await urnOf(mixed, admin)).toBeNull();
    for (const n of ['Mixed', 'mixed']) {
      expect(await Q.resolveUrn(null, { urn: `hrn:aiconf:${org.urn}:org:${n}` }, admin)).toBeNull();
    }
    expect(await Q.resolveUrn(null, { urn: `hrn:aiconf:${org.urn}:org:DEFAULT` }, admin)).toBeNull();
  });

  it('V63 holds for an AGENT-owned config too (the gate throws a not-found there), and for the server-owned one', async () => {
    const agentUrn = (await urnOf(cfg.agent, ctx(platformAdmin.id, ['ADMIN'])))!;
    const serverUrn = 'hrn:aiconf:server:default';
    for (const who of [ctx(otherAdmin.id), ctx(member.id)]) {
      for (const urn of [agentUrn, serverUrn]) {
        expect(await Q.resolveUrn(null, { urn }, who)).toBeNull();
        expect(await Q.aiServiceConfig(null, { ref: urn }, who)).toBeNull();
      }
    }
    // The readable caller still gets the agent one: the null above is the gate, not a broken lookup.
    expect(await Q.resolveUrn(null, { urn: agentUrn }, ctx(orgAdmin.id))).toMatchObject({ id: cfg.agent.id });
  });

  it('an unauthenticated caller gets null from resolveUrn', async () => {
    const urn = (await urnOf(cfg.app, ctx(platformAdmin.id, ['ADMIN'])))!;
    expect(await Q.resolveUrn(null, { urn }, ctx(undefined))).toBeNull();
  });

  it('App and Agent URNs with an extra segment, and a nonexistent owner root, name nothing', async () => {
    const admin = ctx(platformAdmin.id, ['ADMIN']);
    const slug = agent.urn.slice(agent.urn.indexOf(':') + 1);
    const root = agent.urn.slice(0, agent.urn.indexOf(':'));
    for (const urn of [
      `hrn:aiconf:${org.urn}:app:mealplan:default:extra`,
      `hrn:aiconf:${root}:agent:${slug}:default:extra`,
      `hrn:aiconf:no-such-org.example:org:default`,
      `hrn:aiconf:no-such-org.example:app:mealplan:default`,
    ]) {
      expect(await Q.resolveUrn(null, { urn }, admin)).toBeNull();
      expect(await Q.aiServiceConfig(null, { ref: urn }, admin)).toBeNull();
    }
  });

  it('resolveUrn carries the owning org per owner kind (null for a server-owned config)', async () => {
    const admin = ctx(platformAdmin.id, ['ADMIN']);
    for (const k of ['org', 'app', 'agent'] as const) {
      const urn = (await urnOf(cfg[k], admin))!;
      expect(await Q.resolveUrn(null, { urn }, admin)).toMatchObject({ kind: 'aiconf', id: cfg[k].id, organizationId: org.id });
    }
    expect((await Q.resolveUrn(null, { urn: 'hrn:aiconf:server:default' }, admin)).organizationId).toBeNull();
  });
});

describe('#3857 review — through the real schema (SDL + resolvers), not resolver-direct', () => {
  it('urn, aiServiceConfig(ref: urn) and resolveUrn execute against typeDefs', async () => {
    const server = new ApolloServer<Context>({ typeDefs, resolvers });
    const admin = ctx(platformAdmin.id, ['ADMIN']);
    const run = (query: string, variables?: Record<string, unknown>) =>
      server.executeOperation({ query, variables }, { contextValue: admin });
    const urn = `hrn:aiconf:${org.urn}:app:mealplan:default`;

    const one = await run('query($u:ID!,$s:String!){ aiServiceConfig(ref:$u){ id urn name } resolveUrn(urn:$s){ kind id organizationId } }', { u: urn, s: urn });
    expect(one.body.kind).toBe('single');
    const d = (one.body as any).singleResult;
    expect(d.errors).toBeUndefined();
    expect(d.data.aiServiceConfig).toMatchObject({ id: cfg.app.id, urn, name: 'default' });
    expect(d.data.resolveUrn).toMatchObject({ kind: 'aiconf', id: cfg.app.id, organizationId: org.id });

    const list = await run('{ aiServiceConfigs { items { id urn } } }');
    const items = (list.body as any).singleResult.data.aiServiceConfigs.items as { id: string; urn: string | null }[];
    expect(items.find((i) => i.id === cfg.server.id)?.urn).toBe('hrn:aiconf:server:default');
    expect(items.filter((i) => i.urn === null)).toEqual([]);
  });
});

describe('#3857 review — each URN resolves to ITS owner\'s config, not any config of that name', () => {
  it('a second org, App and Agent each holding a `default` config keep their own addresses', async () => {
    const admin = ctx(platformAdmin.id, ['ADMIN']);
    const org2 = await db.organization.create({ data: { id: generateId(), name: 'aiconf-org2', urn: `aiconf-org2-${suffix}.com` } });
    const app2 = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Other Plan', urn: `${org.urn}:otherplan` } });
    const ag2 = await M.createAgent({}, { orgId: org.id, name: 'Other Coach' }, ctx(orgAdmin.id));
    const mk = (owner: Record<string, string>) =>
      db.aiServiceConfig.create({ data: { id: generateId(), name: 'default', provider: 'openai', model: 'm', ...owner } });
    const second = { org: await mk({ organizationId: org2.id }), app: await mk({ appId: app2.id }), agent: await mk({ agentId: ag2.id }) };
    for (const k of ['org', 'app', 'agent'] as const) {
      const first = (await urnOf(cfg[k], admin))!;
      const other = (await urnOf(second[k], admin))!;
      expect(other).not.toBe(first);
      expect(await Q.resolveUrn(null, { urn: first }, admin)).toMatchObject({ id: cfg[k].id });
      expect(await Q.resolveUrn(null, { urn: other }, admin)).toMatchObject({ id: second[k].id });
      expect(await Q.aiServiceConfig(null, { ref: other }, admin)).toMatchObject({ id: second[k].id });
    }
  });
});

describe('#3932 — the urn field batches its owner lookups per request', () => {
  /** A ctx whose db counts reads per owner model, so a pin can name the statements a page costs. */
  function countingCtx(): { c: Context; reads: Record<string, number> } {
    const reads: Record<string, number> = {};
    const wrap = (model: string, delegate: any) =>
      new Proxy(delegate, {
        get(t, p, r) {
          const v = Reflect.get(t, p, r);
          return typeof v === 'function' && String(p).startsWith('find')
            ? (...a: unknown[]) => { reads[model] = (reads[model] ?? 0) + 1; return v.apply(t, a); }
            : v;
        },
      });
    const proxied = new Proxy(db as any, {
      get(t, p, r) {
        const v = Reflect.get(t, p, r);
        return ['organization', 'app', 'agent', 'hadronServer'].includes(String(p)) ? wrap(String(p), v) : v;
      },
    });
    return { c: { db: proxied, userId: platformAdmin.id, roles: ['ADMIN'] }, reads };
  }

  it('N configs over the four owner kinds cost at most one owner read per kind, with the same URNs as one at a time', async () => {
    const mk = (name: string, owner: Record<string, string>) =>
      db.aiServiceConfig.create({ data: { id: generateId(), name, provider: 'openai', model: 'm', ...owner } });
    const extra = [];
    for (let i = 0; i < 5; i++) {
      extra.push(await mk(`x${i}`, { organizationId: org.id }), await mk(`x${i}`, { appId: app.id }), await mk(`x${i}`, { agentId: agent.id }));
    }
    const rows = await db.aiServiceConfig.findMany({});
    const asParent = (r: (typeof rows)[number]) => ({
      name: r.name,
      ownerType: r.appId ? 'APP' : r.agentId ? 'AGENT' : r.organizationId ? 'ORGANIZATION' : 'HADRON_SERVER',
      ownerId: (r.appId ?? r.agentId ?? r.organizationId ?? r.hadronServerId)!,
    });
    const alone: (string | null)[] = [];
    for (const r of rows) alone.push(await T.urn(asParent(r), {}, ctx(platformAdmin.id, ['ADMIN'])));

    const { c, reads } = countingCtx();
    const batched = await Promise.all(rows.map((r) => T.urn(asParent(r), {}, c)));
    expect(batched).toEqual(alone);
    // #3958: the fixture must cover every owner kind (a row count says nothing about which kinds are present).
    expect(new Set(rows.map((r) => asParent(r).ownerType))).toEqual(new Set(['ORGANIZATION', 'APP', 'AGENT', 'HADRON_SERVER']));
    expect(reads).toEqual({ organization: 1, app: 1, agent: 1, hadronServer: 1 });
  });

  it('logs a config with no URN once per request, not once per row', async () => {
    const bad = [];
    for (let i = 0; i < 4; i++) bad.push(await db.aiServiceConfig.create({ data: { id: generateId(), name: `bad${i}-`, provider: 'openai', model: 'm', organizationId: org.id } }));
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const one = ctx(platformAdmin.id, ['ADMIN']);
      const out = await Promise.all(bad.map((b) => T.urn({ name: b.name, ownerType: 'ORGANIZATION', ownerId: org.id }, {}, one)));
      expect(out).toEqual([null, null, null, null]);
      expect(spy.mock.calls.filter((a) => String(a[0]).includes('[aiconf-urn]')).length).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});
