/**
 * #3958 — pins on the owner resolution behind `AiServiceConfig.urn` and `resolveUrn`'s aiconf arm
 * (cor:dmo:050:10, cor:urn:010:01):
 *   F1  an owner arm with a NULL urn or a missing owner logs once per request; the answer stays exactly null;
 *   F2  `resolveUrn` for a config that already carries its organization runs no owner query, same organizationId;
 *   F5  one failing owner-kind query errors every row's urn in the tick (decided: never a quiet null).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';
import { loadAiConfigOwners } from '../../../lib/aiConfigOwner.js';

// The owner load is counted at its own seam: resolveUrn's gate (readAiServiceConfigByUrn) reads owner tables too.
vi.mock('../../../lib/aiConfigOwner.js', async (orig) => {
  const real = await orig<typeof import('../../../lib/aiConfigOwner.js')>();
  return { ...real, loadAiConfigOwners: vi.fn(real.loadAiConfigOwners) };
});

const Q = resolvers.Query as any;
const T = (resolvers as any).AiServiceConfig as { urn: (c: unknown, a: unknown, ctx: Context) => Promise<string | null> };

let org: { id: string; urn: string };
let app: { id: string; urn: string };
let agent: { id: string; urn: string };
let admin: { id: string };

beforeEach(async () => {
  vi.mocked(loadAiConfigOwners).mockClear();
  await cleanDb(db);
  const s = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({ data: { id: generateId(), name: 'o3958', urn: `o3958-${s}.com` } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'App', urn: `${org.urn}:app3958` } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, name: 'Ag', urn: `${org.urn}:ag3958` } as never });
  admin = await db.user.create({ data: { id: generateId(), githubId: 395800, githubUsername: `u3958-${s}`, roles: ['ADMIN'] as never } });
});
afterEach(() => { vi.restoreAllMocks(); });

/** A Context whose db can make an owner model's `find*` reads throw or answer a NULL urn. */
function probeCtx(opts: { throwOn?: string; nullUrnOn?: string } = {}): { c: Context } {
  const wrap = (model: string, delegate: any) => new Proxy(delegate, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r);
      if (typeof v !== 'function' || !String(p).startsWith('find')) return v;
      return async (...a: unknown[]) => {
        if (opts.throwOn === model) throw new Error(`boom ${model}`);
        const out = await v.apply(t, a);
        return opts.nullUrnOn === model && Array.isArray(out) ? out.map((row: any) => ({ ...row, urn: null })) : out;
      };
    },
  });
  const proxied = new Proxy(db as any, {
    get(t, p, r) {
      const v = Reflect.get(t, p, r);
      return ['organization', 'app', 'agent', 'hadronServer'].includes(String(p)) ? wrap(String(p), v) : v;
    },
  });
  return { c: { db: proxied, userId: admin.id, roles: ['ADMIN'] } };
}
const warns = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((a) => String(a[0]).includes('[aiconf-urn]'));

describe('#3958 F1 — an owner arm with no URN to compose from is logged once per request, and the answer stays null', () => {
  for (const [kind, ownerType, model] of [['organization', 'ORGANIZATION', 'organization'], ['app', 'APP', 'app'], ['agent', 'AGENT', 'agent']] as const) {
    it(`${kind} owner row with a NULL urn: null, one warn for several rows`, async () => {
      const id = { organization: org.id, app: app.id, agent: agent.id }[kind];
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { c } = probeCtx({ nullUrnOn: model });
      const out = await Promise.all(['a', 'b', 'c'].map((n) => T.urn({ name: n, ownerType, ownerId: id }, {}, c)));
      expect(out).toEqual([null, null, null]);
      expect(warns(spy)).toHaveLength(1);
    });
  }

  it('a missing owner row: null and one warn', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await T.urn({ name: 'x', ownerType: 'ORGANIZATION', ownerId: generateId() }, {}, probeCtx().c);
    expect(out).toBeNull();
    expect(warns(spy)).toHaveLength(1);
  });

  it('a healthy owner logs nothing and composes the URN', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await T.urn({ name: 'x', ownerType: 'ORGANIZATION', ownerId: org.id }, {}, probeCtx().c)).toBe(`hrn:aiconf:${org.urn}:org:x`);
    expect(warns(spy)).toHaveLength(0);
  });
});

describe('#3958 F2 — resolveUrn skips the owner read when the config already carries its organization', () => {
  const mk = (owner: Record<string, string>) => db.aiServiceConfig.create({ data: { id: generateId(), name: 'default', provider: 'openai', model: 'm', ...owner } });

  it('org-owned: no owner query, same organizationId', async () => {
    const cfg = await mk({ organizationId: org.id });
    const hit = await Q.resolveUrn(null, { urn: `hrn:aiconf:${org.urn}:org:default` }, probeCtx().c);
    expect(hit).toMatchObject({ kind: 'aiconf', id: cfg.id, organizationId: org.id });
    expect(loadAiConfigOwners).not.toHaveBeenCalled();
  });

  it('app-owned: the owner is still read once and supplies the organizationId', async () => {
    const cfg = await mk({ appId: app.id });
    const hit = await Q.resolveUrn(null, { urn: `hrn:aiconf:${org.urn}:app:${app.urn.split(':').pop()}:default` }, probeCtx().c);
    expect(hit).toMatchObject({ kind: 'aiconf', id: cfg.id, organizationId: org.id });
    expect(loadAiConfigOwners).toHaveBeenCalledTimes(1);
  });
});

describe('#3958 F5 — one failing owner-kind query errors every row of the tick (never a quiet null)', () => {
  it('rows of the failing kind and of the healthy kinds all reject with the query error', async () => {
    const { c } = probeCtx({ throwOn: 'organization' });
    const rows = [
      { name: 'a', ownerType: 'ORGANIZATION', ownerId: org.id },
      { name: 'b', ownerType: 'APP', ownerId: app.id },
      { name: 'c', ownerType: 'AGENT', ownerId: agent.id },
    ];
    const settled = await Promise.allSettled(rows.map((r) => T.urn(r, {}, c)));
    expect(settled.map((s) => s.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(String((settled[1] as PromiseRejectedResult).reason)).toContain('boom organization');
  });
});
