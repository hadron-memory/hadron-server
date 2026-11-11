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
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { encryptToken } from '../../../lib/tokenCrypto.js';
import { mintPrincipal } from '../../../lib/principal/mintPrincipal.js';
import { resolvers, type Context } from './resolvers.js';

const Q = resolvers.Query as any;
const M = resolvers.Mutation as any;
const T = (resolvers as any).AiServiceConfig as { urn: (c: unknown, a: unknown, ctx: Context) => Promise<string | null> };

function ctx(userId?: string, roles: string[] = ['READER']): Context {
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

const urnOf = (c: { id: string }, who: Context) =>
  db.aiServiceConfig.findUniqueOrThrow({ where: { id: c.id } }).then((row) => T.urn(row, {}, who));

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
    await expect(mintPrincipal(db, { kind: 'org', name })).rejects.toThrow();
    await expect(mintPrincipal(db, { kind: 'user', name })).rejects.toThrow();
  });
});
