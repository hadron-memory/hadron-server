/**
 * #3947 — hardening of the `AiServiceConfig.urn` owner loader, from #3943's BLIND review and Victor's scoped FIT
 * (issue comment 6792943327, folded into the CHECKED gate as contract). Spec: cor:urn:010:01 (the aiconf clause).
 *
 *   - Batching answers every config exactly as the single read does, with DISTINCT owners per kind (item 1).
 *   - The once-per-request warn is per request: two requests in one tick each log once (item 2).
 *   - The URN is computed, not stored: a later wave on the SAME request re-reads the owner and sees a rename; nothing
 *     carries over between waves (item 2, the FIT's spec-relevant pin).
 *   - A HADRON_SERVER owner id is always in the loader's map, with `current` saying whether it is the server answering;
 *     a config owned by another live row or by an id with no row has a null URN, and `resolveUrn` names neither (item 3).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { loadAiConfigOwners, aiConfigOwnerKey } from '../../../lib/aiConfigOwner.js';
import { resolvers, type Context } from './resolvers.js';

const Q = resolvers.Query as any;
const T = (resolvers as any).AiServiceConfig as { urn: (c: unknown, a: unknown, ctx: Context) => Promise<string | null> };

type Kind = 'ORGANIZATION' | 'APP' | 'AGENT' | 'HADRON_SERVER';
type Parent = { name: string; ownerType: Kind; ownerId: string };

let suffix: string;
let admin: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  admin = await db.user.create({ data: { id: generateId(), githubId: 394_700 + Math.floor(Math.random() * 1000), githubUsername: `aiconf3947-${suffix}`, roles: ['ADMIN'] } });
});

const adminCtx = (): Context => ({ db, userId: admin.id, roles: ['ADMIN'] });

/** A ctx whose db counts finds per owner model, so a pin can name the statements a wave costs. */
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
  return { c: { db: proxied, userId: admin.id, roles: ['ADMIN'] }, reads };
}

/** Three orgs, each with one App and one Agent: three distinct owners per kind. */
async function distinctOwners() {
  const out: Array<{ parent: Parent; urn: string }> = [];
  for (let i = 0; i < 3; i++) {
    const org = await db.organization.create({ data: { id: generateId(), name: `o${i}`, urn: `o${i}-${suffix}.com` } });
    const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: `A${i}`, urn: `${org.urn}:app${i}` } });
    const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: `G${i}`, urn: `${org.urn}:agent${i}`, visibility: 'ORGANIZATION' } });
    out.push(
      { parent: { name: `c${i}`, ownerType: 'ORGANIZATION', ownerId: org.id }, urn: `hrn:aiconf:${org.urn}:org:c${i}` },
      { parent: { name: `c${i}`, ownerType: 'APP', ownerId: app.id }, urn: `hrn:aiconf:${org.urn}:app:app${i}:c${i}` },
      { parent: { name: `c${i}`, ownerType: 'AGENT', ownerId: agent.id }, urn: `hrn:aiconf:${org.urn}:agent:agent${i}:c${i}` },
    );
  }
  return out;
}

describe('#3947 item 1 — distinct owners per kind batch to one read per kind, each with its own URN', () => {
  it('nine configs over three orgs, three Apps and three Agents: explicit URNs, alone and batched, one read per kind', async () => {
    const cases = await distinctOwners();
    const alone: Array<string | null> = [];
    for (const k of cases) alone.push(await T.urn(k.parent, {}, adminCtx()));
    expect(alone).toEqual(cases.map((k) => k.urn));

    const { c, reads } = countingCtx();
    const batched = await Promise.all(cases.map((k) => T.urn(k.parent, {}, c)));
    expect(batched).toEqual(cases.map((k) => k.urn));
    expect(reads).toEqual({ organization: 1, app: 1, agent: 1 });
  });
});

describe('#3947 item 2 — waves and requests', () => {
  it('two requests in the same tick each log their own miss once', async () => {
    const org = await db.organization.create({ data: { id: generateId(), name: 'w', urn: `w-${suffix}.com` } });
    const bad = (i: number): Parent => ({ name: `bad${i}-`, ownerType: 'ORGANIZATION', ownerId: org.id });
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const one = adminCtx();
      const two = adminCtx();
      const out = await Promise.all([T.urn(bad(1), {}, one), T.urn(bad(2), {}, two), T.urn(bad(3), {}, one), T.urn(bad(4), {}, two)]);
      expect(out).toEqual([null, null, null, null]);
      expect(spy.mock.calls.filter((a) => String(a[0]).includes('[aiconf-urn]')).length).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('a later wave on the same request re-reads the owner: an App rename between waves shows in the next URN', async () => {
    const org = await db.organization.create({ data: { id: generateId(), name: 'r', urn: `r-${suffix}.com` } });
    const app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'R', urn: `${org.urn}:before` } });
    const parent: Parent = { name: 'default', ownerType: 'APP', ownerId: app.id };
    const { c, reads } = countingCtx();
    expect(await Promise.all([T.urn(parent, {}, c), T.urn(parent, {}, c)])).toEqual([
      `hrn:aiconf:${org.urn}:app:before:default`, `hrn:aiconf:${org.urn}:app:before:default`,
    ]);
    await db.app.update({ where: { id: app.id }, data: { urn: `${org.urn}:after` } });
    expect(await T.urn(parent, {}, c)).toBe(`hrn:aiconf:${org.urn}:app:after:default`);
    expect(reads).toEqual({ app: 2 });
  });
});

describe('#3947 item 3 — a HADRON_SERVER owner id is always present; only the current server has a URN', () => {
  it('the loader answers every requested server id, current or not, row or no row', async () => {
    const current = await db.hadronServer.create({ data: { id: generateId(), url: 'https://current.test' } });
    const other = await db.hadronServer.create({ data: { id: generateId(), url: 'https://other.test', createdAt: new Date(Date.now() + 60_000) } });
    const ghost = generateId(); // no hadron_servers row
    const map = await loadAiConfigOwners(db, [current.id, other.id, ghost].map((ownerId) => ({ ownerType: 'HADRON_SERVER' as const, ownerId })));
    const at = (ownerId: string) => map.get(aiConfigOwnerKey({ ownerType: 'HADRON_SERVER', ownerId }));
    expect(at(current.id)).toEqual({ ownerType: 'HADRON_SERVER', urn: null, organizationId: null, current: true });
    expect(at(other.id)).toEqual({ ownerType: 'HADRON_SERVER', urn: null, organizationId: null, current: false });
    expect(at(ghost)).toEqual({ ownerType: 'HADRON_SERVER', urn: null, organizationId: null, current: false });
  });

  it('the current server\'s config is hrn:aiconf:server:<name>; another live row\'s and a rowless id\'s are null and never resolve', async () => {
    const current = await db.hadronServer.create({ data: { id: generateId(), url: 'https://current.test' } });
    const other = await db.hadronServer.create({ data: { id: generateId(), url: 'https://other.test', createdAt: new Date(Date.now() + 60_000) } });
    await db.aiServiceConfig.create({ data: { id: generateId(), name: 'mine', provider: 'openai', model: 'm', hadronServerId: current.id } });
    await db.aiServiceConfig.create({ data: { id: generateId(), name: 'theirs', provider: 'openai', model: 'm', hadronServerId: other.id } });
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const c = adminCtx();
      expect(await Promise.all([
        T.urn({ name: 'mine', ownerType: 'HADRON_SERVER', ownerId: current.id }, {}, c),
        T.urn({ name: 'theirs', ownerType: 'HADRON_SERVER', ownerId: other.id }, {}, c),
        T.urn({ name: 'ghost', ownerType: 'HADRON_SERVER', ownerId: generateId() }, {}, c),
      ])).toEqual(['hrn:aiconf:server:mine', null, null]);
    } finally {
      spy.mockRestore();
    }
    expect(await Q.resolveUrn(null, { urn: 'hrn:aiconf:server:mine' }, adminCtx())).toMatchObject({ kind: 'aiconf' });
    expect(await Q.resolveUrn(null, { urn: 'hrn:aiconf:server:theirs' }, adminCtx())).toBeNull();
    expect(await Q.resolveUrn(null, { urn: 'hrn:aiconf:server:ghost' }, adminCtx())).toBeNull();
  });
});
