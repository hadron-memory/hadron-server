/**
 * #1946 — the Agent-ref sites #1944 left out: the Agent resolved BEFORE a gate
 * on something else, or with no gate on it at all, plus the App-reader sites
 * Holger's ruling A brought in (team chat #11863: "not installed in this App"
 * and "no such Agent" are ONE answer, with no id).
 *
 * Every pin compares a real Agent the caller can't read (`secret`, org A,
 * ORGANIZATION) with a guessed one, sent by the caller the leak applied to:
 * the two answers must be identical once the echoed ref is masked, and must
 * never carry the real Agent's id. Controls keep each legitimate path.
 * Answers are read off the GraphQL wire (`formatGraphQLError`).
 */

import { ApolloServer } from '@apollo/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAgentOrgGrant } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { formatGraphQLError } from '../formatError.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const graphql = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });

type Answer = { data: unknown; error: { message: string; extensions: Record<string, unknown> } | null };

async function ask(c: Context, query: string, variables: Record<string, unknown>): Promise<Answer> {
  const res = await graphql.executeOperation({ query, variables }, { contextValue: c });
  if (res.body.kind !== 'single') throw new Error('unexpected incremental response');
  const { data, errors } = res.body.singleResult;
  const e = errors?.[0];
  const { stacktrace: _drop, ...extensions } = (e?.extensions ?? {}) as Record<string, unknown>;
  return { data: data ? Object.values(data)[0] ?? null : null, error: e ? { message: e.message, extensions } : null };
}

let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let adminA: string;
let adminB: string;
let readerB: string;
let outsider: string;
let ana: string;
let secret: { id: string; urn: string };
let pub: { id: string; urn: string };
let agentB: { id: string; urn: string };
let appB: { id: string; urn: string };
let anaApp: { id: string };

const ctx = (userId: string): Context => ({ db, userId, roles: ['READER'] });
const urnOf = (a: { urn: string }) => `hrn:agent:${a.urn}`;
const nobody = () => `hrn:agent:${orgA.urn}:nobody`;
const masked = (a: Answer, ref: string) => JSON.parse(JSON.stringify(a).split(ref).join('<ref>').replace(/"requestId":"[^"]+"/g, '"requestId":"<id>"'));

async function user(handle: string): Promise<string> {
  return (await db.user.create({ data: { id: generateId(), name: handle, handle: `${handle}-${generateId().slice(-6)}`, roles: ['READER'] } })).id;
}

async function orgAgent(org: { id: string; urn: string }, slug: string, visibility: 'ORGANIZATION' | 'PUBLIC') {
  const mem = await db.memory.create({ data: { class: 'system', organizationId: org.id, name: `${slug} system`, urn: `${org.urn}:${slug}-system` } });
  const a = await db.agent.create({ data: { organizationId: org.id, name: slug, urn: `${org.urn}:${slug}`, visibility, systemMemoryId: mem.id } });
  return { id: a.id, urn: a.urn };
}

beforeEach(async () => {
  await cleanDb(db);
  const n = generateId().slice(-8);
  orgA = await db.organization.create({ data: { name: 'A', urn: `gate-a-${n}.example` }, select: { id: true, urn: true } });
  orgB = await db.organization.create({ data: { name: 'B', urn: `gate-b-${n}.example` }, select: { id: true, urn: true } });
  adminA = await user('admin-a');
  adminB = await user('admin-b');
  readerB = await user('reader-b');
  outsider = await user('outsider');
  ana = await user('ana');
  await db.orgMember.create({ data: { organizationId: orgA.id, userId: adminA, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: orgB.id, userId: adminB, role: 'ADMIN' } });
  secret = await orgAgent(orgA, 'secret', 'ORGANIZATION');
  pub = await orgAgent(orgA, 'public', 'PUBLIC');
  agentB = await orgAgent(orgB, 'helper', 'ORGANIZATION');
  appB = await db.app.create({ data: { organizationId: orgB.id, name: 'Team', urn: `${orgB.urn}:team`, appAgents: { create: { agentId: agentB.id } } }, select: { id: true, urn: true } });
  await db.appMember.create({ data: { appId: appB.id, userId: adminB, role: 'admin' } });
  await db.appMember.create({ data: { appId: appB.id, userId: readerB, role: 'reader' } });
  anaApp = await db.app.create({ data: { ownerUserId: ana, name: 'Mine', urn: `ana-${n}:mine` }, select: { id: true } });
});

/** One surface, as the caller the leak applied to sends it. */
type Site = { name: string; as: () => Context; req: (ref: string) => { query: string; variables: Record<string, unknown> }; absent?: (ref: string) => Partial<Answer['error']> | 'EMPTY_LIST' };

const SITES: Site[] = [
  { name: 'installAgentIntoApp, an outsider: the App gate answers first',
    as: () => ctx(outsider),
    req: (ref) => ({ query: 'mutation($a: ID!, $r: ID!) { installAgentIntoApp(appRef: $a, agentRef: $r) { appAgent { agent { id } } } }', variables: { a: appB.id, r: ref } }),
    absent: () => ({ extensions: { code: 'FORBIDDEN' } }) },
  { name: 'installAgentIntoApp, a personal App\'s owner: no ORGANIZATION_MISMATCH (or id) for an Agent they can\'t read',
    as: () => ctx(ana),
    req: (ref) => ({ query: 'mutation($a: ID!, $r: ID!) { installAgentIntoApp(appRef: $a, agentRef: $r) { appAgent { agent { id } } } }', variables: { a: anaApp.id, r: ref } }),
    absent: () => ({ extensions: { code: 'AGENT_NOT_FOUND' } }) },
  { name: 'uninstallAgentFromApp, an outsider: the App gate answers first',
    as: () => ctx(outsider),
    req: (ref) => ({ query: 'mutation($a: ID!, $r: ID!) { uninstallAgentFromApp(appRef: $a, agentRef: $r) { appId } }', variables: { a: appB.id, r: ref } }),
    absent: () => ({ extensions: { code: 'FORBIDDEN' } }) },
  { name: 'uninstallAgentFromApp, the App\'s admin: a not-installed Agent they can\'t read answers as absent',
    as: () => ctx(adminB),
    req: (ref) => ({ query: 'mutation($a: ID!, $r: ID!) { uninstallAgentFromApp(appRef: $a, agentRef: $r) { appId } }', variables: { a: appB.id, r: ref } }),
    absent: () => ({ extensions: { code: 'AGENT_NOT_FOUND' } }) },
  { name: 'resolveAiServiceConfigs, an App member: not installed answers as absent',
    as: () => ctx(readerB),
    req: (ref) => ({ query: 'query($a: ID!, $r: ID!) { resolveAiServiceConfigs(appRef: $a, agentRef: $r) { id } }', variables: { a: appB.id, r: ref } }),
    absent: () => ({ extensions: { code: 'AGENT_NOT_FOUND' } }) },
  { name: 'resolveAiServiceConfigs, an outsider: the App gate answers first',
    as: () => ctx(outsider),
    req: (ref) => ({ query: 'query($a: ID!, $r: ID!) { resolveAiServiceConfigs(appRef: $a, agentRef: $r) { id } }', variables: { a: appB.id, r: ref } }),
    absent: () => ({ extensions: { code: 'FORBIDDEN' } }) },
  { name: 'createAgentOrgGrant, another org\'s ADMIN: no AGENT_NOT_PUBLIC (or id) for an Agent they can\'t read',
    as: () => ctx(adminB),
    req: (ref) => ({ query: 'mutation($r: ID!, $o: ID!) { createAgentOrgGrant(agentRef: $r, orgRef: $o) { agentId } }', variables: { r: ref, o: orgB.id } }),
    absent: () => ({ extensions: { code: 'AGENT_NOT_FOUND' } }) },
  { name: 'createAgentOrgGrant, an outsider: the org gate answers first',
    as: () => ctx(outsider),
    req: (ref) => ({ query: 'mutation($r: ID!, $o: ID!) { createAgentOrgGrant(agentRef: $r, orgRef: $o) { agentId } }', variables: { r: ref, o: orgB.id } }),
    absent: () => ({ extensions: { code: 'FORBIDDEN' } }) },
  { name: 'revokeAgentOrgGrant, another org\'s ADMIN with no grant: no AGENT_ORG_GRANT_NOT_FOUND (or id)',
    as: () => ctx(adminB),
    req: (ref) => ({ query: 'mutation($r: ID!, $o: ID!) { revokeAgentOrgGrant(agentRef: $r, orgRef: $o) { agentId } }', variables: { r: ref, o: orgB.id } }),
    absent: () => ({ extensions: { code: 'AGENT_NOT_FOUND' } }) },
  { name: 'revokeAgentOrgGrant, an outsider',
    as: () => ctx(outsider),
    req: (ref) => ({ query: 'mutation($r: ID!, $o: ID!) { revokeAgentOrgGrant(agentRef: $r, orgRef: $o) { agentId } }', variables: { r: ref, o: orgB.id } }),
    absent: () => ({ extensions: { code: 'AGENT_NOT_FOUND' } }) },
  { name: 'myChats, an outsider: an empty list either way',
    as: () => ctx(outsider),
    req: (ref) => ({ query: 'query($r: ID!) { myChats(agentRef: $r) { id } }', variables: { r: ref } }),
    absent: () => 'EMPTY_LIST' },
  { name: 'createApp, a personal App: no ORGANIZATION_MISMATCH (or id)',
    as: () => ctx(ana),
    req: (ref) => ({ query: 'mutation($r: ID!) { createApp(agentRef: $r, name: "Probe") { id } }', variables: { r: ref } }),
    absent: () => ({ extensions: { code: 'AGENT_NOT_FOUND' } }) },
  { name: 'createApp installOptional: a non-import refuses like an absent ref, and creates nothing',
    as: () => ctx(adminB),
    req: (ref) => ({ query: 'mutation($o: ID!, $r: ID!, $opt: [ID!]) { createApp(orgRef: $o, agentRef: $r, name: "Probe", installOptional: $opt) { id } }', variables: { o: orgB.id, r: agentB.id, opt: [ref] } }),
    absent: () => ({ extensions: { code: 'AGENT_NOT_FOUND' } }) },
  { name: 'publishAgentImport, the parent\'s ADMIN: an imported Agent they can\'t read or license answers as absent',
    as: () => ctx(adminB),
    req: (ref) => ({ query: 'mutation($p: ID!, $r: ID!) { publishAgentImport(parentAgentRef: $p, importedAgentRef: $r, position: 0) { parentAgentId } }', variables: { p: agentB.id, r: ref } }),
    absent: () => ({ extensions: { code: 'AGENT_NOT_FOUND' } }) },
  { name: 'removeAgentImport, the parent\'s ADMIN: no edge to an Agent they can\'t read answers as absent',
    as: () => ctx(adminB),
    req: (ref) => ({ query: 'mutation($p: ID!, $r: ID!) { removeAgentImport(parentAgentRef: $p, importedAgentRef: $r) }', variables: { p: agentB.id, r: ref } }),
    absent: () => ({ extensions: { code: 'AGENT_NOT_FOUND' } }) },
  { name: 'effectiveAccess, a cross-subject audit: an Agent the auditor can\'t open answers as unresolvable',
    as: () => ctx(adminB),
    req: (ref) => ({ query: 'query($u: ID!, $r: ID!) { effectiveAccess(user: $u, resource: $r) { resourceUrn } }', variables: { u: readerB, r: ref } }),
    absent: () => ({ message: 'Resource not found', extensions: { code: 'NOT_FOUND' } }) },
  { name: 'setAgentAssetUploadEnabled, another org\'s ADMIN',
    as: () => ctx(adminB),
    req: (ref) => ({ query: 'mutation($r: String!) { setAgentAssetUploadEnabled(input: { agentUrn: $r, enabled: true }) { id } }', variables: { r: ref } }) },
  { name: 'beginAssetUpload (agentUrn), another org\'s user',
    as: () => ctx(adminB),
    req: (ref) => ({ query: 'mutation($r: String!) { beginAssetUpload(input: { agentUrn: $r, filename: "a.png", mimeType: "image/png", sizeBytes: 10, uploadIntent: USER }) { uploadId } }', variables: { r: ref } }) },
  { name: 'agentAssets (agentUrn), another org\'s user',
    as: () => ctx(adminB),
    req: (ref) => ({ query: 'query($r: String!) { agentAssets(agentUrn: $r) { total } }', variables: { r: ref } }) },
  { name: 'createAgentSchedule, the App\'s admin: not installed answers as absent',
    as: () => ctx(adminB),
    req: (ref) => ({ query: 'mutation($a: String!, $r: String) { createAgentSchedule(input: { appRef: $a, name: "nightly", cron: "0 3 * * *", entryNodeUrn: "hrn:node:x.example:m:start", agentRef: $r }) { id } }', variables: { a: appB.id, r: ref } }) },
  { name: 'teamRoles, an App reader: not installed answers as absent, with no id',
    as: () => ctx(readerB),
    req: (ref) => ({ query: 'query($a: ID!, $r: ID) { teamRoles(appRef: $a, teamAgentRef: $r) { total } }', variables: { a: appB.id, r: ref } }) },
  { name: 'castWorker, the App\'s staff: not installed answers as absent, with no id',
    as: () => ctx(adminB),
    req: (ref) => ({ query: 'mutation($a: ID!, $r: ID) { castWorker(appRef: $a, agentRef: $r, name: "Probe") { id } }', variables: { a: appB.id, r: ref } }) },
  { name: 'createMemoryInApp, the App\'s admin: not installed answers as absent',
    as: () => ctx(adminB),
    req: (ref) => ({ query: 'mutation($a: ID!, $r: ID!) { createMemoryInApp(appRef: $a, agentRef: $r, memoryClass: personal, name: "Probe") { id } }', variables: { a: appB.id, r: ref } }) },
  { name: 'resolveAIConfig with an App named, the App\'s admin: not installed answers as absent',
    as: () => ctx(adminB),
    req: (ref) => ({ query: 'query($a: ID!, $r: ID!) { resolveAIConfig(appRef: $a, agentRef: $r) { configId } }', variables: { a: appB.id, r: ref } }),
    absent: () => ({ extensions: { code: 'AGENT_NOT_FOUND' } }) },
];

describe('#1946 a real Agent the caller can\'t read and a guessed one answer the same, with no id', () => {
  for (const site of SITES) {
    it(site.name, async () => {
      const real = await ask(site.as(), site.req(urnOf(secret)).query, site.req(urnOf(secret)).variables);
      const guessed = await ask(site.as(), site.req(nobody()).query, site.req(nobody()).variables);
      expect(masked(real, urnOf(secret))).toEqual(masked(guessed, nobody()));
      expect(JSON.stringify(real)).not.toContain(secret.id);
      const absent = site.absent?.(nobody());
      if (absent === 'EMPTY_LIST') expect(real).toEqual({ data: [], error: null });
      else if (absent) expect(real.error).toMatchObject(absent);
      else expect(real.error).not.toBeNull();
    });
  }

  it('the refused probes wrote nothing: no App, grant, import, install, schedule, worker or memory', async () => {
    const before = await Promise.all([db.app.count(), db.agentOrgGrant.count(), db.agentImport.count(), db.appAgent.count(), db.worker.count(), db.memory.count()]);
    for (const site of SITES) await ask(site.as(), site.req(urnOf(secret)).query, site.req(urnOf(secret)).variables);
    const after = await Promise.all([db.app.count(), db.agentOrgGrant.count(), db.agentImport.count(), db.appAgent.count(), db.worker.count(), db.memory.count()]);
    expect(after).toEqual(before);
  });
});

describe('#1946 controls: the legitimate callers keep their answers', () => {
  it('install: the App\'s admin installs a PUBLIC Agent once licensed; a reader of a non-installable Agent still gets ORGANIZATION_MISMATCH', async () => {
    await createDbAgentOrgGrant(db, orgB.id, pub.id);
    expect((await ask(ctx(adminB), 'mutation($a: ID!, $r: ID!) { installAgentIntoApp(appRef: $a, agentRef: $r) { appAgent { agent { id } } } }', { a: appB.id, r: pub.id })).error).toBeNull();
    await db.orgMember.create({ data: { organizationId: orgA.id, userId: ana, role: 'READER' } });
    const a = await ask(ctx(ana), 'mutation($a: ID!, $r: ID!) { installAgentIntoApp(appRef: $a, agentRef: $r) { appAgent { agent { id } } } }', { a: anaApp.id, r: secret.id });
    expect(a.error?.extensions.code).toBe('ORGANIZATION_MISMATCH');
  });

  it('uninstall: idempotent for an Agent the admin can read, installed or not', async () => {
    expect((await ask(ctx(adminB), 'mutation($a: ID!, $r: ID!) { uninstallAgentFromApp(appRef: $a, agentRef: $r) { appId } }', { a: appB.id, r: pub.id })).error).toBeNull();
    expect((await ask(ctx(adminB), 'mutation($a: ID!, $r: ID!) { uninstallAgentFromApp(appRef: $a, agentRef: $r) { appId } }', { a: appB.id, r: agentB.id })).error).toBeNull();
    expect(await db.appAgent.count({ where: { appId: appB.id, agentId: agentB.id } })).toBe(0);
  });

  it('resolveAiServiceConfigs: an App member lists the configs of an installed Agent', async () => {
    expect((await ask(ctx(readerB), 'query($a: ID!, $r: ID!) { resolveAiServiceConfigs(appRef: $a, agentRef: $r) { id } }', { a: appB.id, r: agentB.id })).error).toBeNull();
  });

  it('org grants: a PUBLIC Agent is subscribed to; a grant holder revokes even after the Agent went private', async () => {
    expect((await ask(ctx(adminB), 'mutation($r: ID!, $o: ID!) { createAgentOrgGrant(agentRef: $r, orgRef: $o) { agentId } }', { r: pub.id, o: orgB.id })).error).toBeNull();
    await db.agent.update({ where: { id: pub.id }, data: { visibility: 'ORGANIZATION' } });
    expect((await ask(ctx(adminB), 'mutation($r: ID!, $o: ID!) { revokeAgentOrgGrant(agentRef: $r, orgRef: $o) { agentId } }', { r: pub.id, o: orgB.id })).error).toBeNull();
  });

  it('org grants: a caller who CAN read a non-PUBLIC Agent still gets AGENT_NOT_PUBLIC', async () => {
    await db.orgMember.create({ data: { organizationId: orgA.id, userId: adminB, role: 'READER' } });
    const a = await ask(ctx(adminB), 'mutation($r: ID!, $o: ID!) { createAgentOrgGrant(agentRef: $r, orgRef: $o) { agentId } }', { r: secret.id, o: orgB.id });
    expect(a.error?.extensions.code).toBe('AGENT_NOT_PUBLIC');
  });

  it('imports: a licensed import is published and removed; an unlicensed readable one still gets MissingGrantError', async () => {
    expect((await ask(ctx(adminB), 'mutation($p: ID!, $r: ID!) { publishAgentImport(parentAgentRef: $p, importedAgentRef: $r, position: 0) { parentAgentId } }', { p: agentB.id, r: pub.id })).error?.extensions.code).toBe('MissingGrantError');
    await createDbAgentOrgGrant(db, orgB.id, pub.id);
    expect((await ask(ctx(adminB), 'mutation($p: ID!, $r: ID!) { publishAgentImport(parentAgentRef: $p, importedAgentRef: $r, position: 0) { parentAgentId } }', { p: agentB.id, r: pub.id })).error).toBeNull();
    await db.agent.update({ where: { id: pub.id }, data: { visibility: 'ORGANIZATION' } });
    expect((await ask(ctx(adminB), 'mutation($p: ID!, $r: ID!) { removeAgentImport(parentAgentRef: $p, importedAgentRef: $r) }', { p: agentB.id, r: pub.id })).error).toBeNull();
    expect(await db.agentImport.count()).toBe(0);
  });

  it('createApp installOptional: a real optional import of the parent is still installed', async () => {
    const opt = await orgAgent(orgB, 'optional', 'ORGANIZATION');
    await db.agentImport.create({ data: { parentAgentId: agentB.id, importedAgentId: opt.id, position: 0, required: false, agentOrgGrantOrgId: orgB.id, agentOrgGrantAgentId: opt.id } }).catch(async () => {
      await createDbAgentOrgGrant(db, orgB.id, opt.id);
      await db.agentImport.create({ data: { parentAgentId: agentB.id, importedAgentId: opt.id, position: 0, required: false, agentOrgGrantOrgId: orgB.id, agentOrgGrantAgentId: opt.id } });
    });
    const a = await ask(ctx(adminB), 'mutation($o: ID!, $r: ID!, $opt: [ID!]) { createApp(orgRef: $o, agentRef: $r, name: "WithOpt", installOptional: $opt) { id } }', { o: orgB.id, r: agentB.id, opt: [opt.id] });
    expect(a.error).toBeNull();
    // An optional import is installed in its own App in the org (one per org and dependency Agent).
    expect(await db.appAgent.count({ where: { agentId: opt.id, app: { organizationId: orgB.id } } })).toBe(1);
  });

  it('effectiveAccess: the auditor still audits an Agent they can open', async () => {
    expect((await ask(ctx(adminB), 'query($u: ID!, $r: ID!) { effectiveAccess(user: $u, resource: $r) { resourceUrn } }', { u: readerB, r: urnOf(agentB) })).error).toBeNull();
  });

  it('App-reader sites: an installed Agent still resolves (teamRoles, createMemoryInApp)', async () => {
    expect((await ask(ctx(readerB), 'query($a: ID!, $r: ID) { teamRoles(appRef: $a, teamAgentRef: $r) { total } }', { a: appB.id, r: agentB.id })).error).toBeNull();
    expect((await ask(ctx(adminB), 'mutation($a: ID!, $r: ID!) { createMemoryInApp(appRef: $a, agentRef: $r, memoryClass: personal, name: "Mine") { id } }', { a: appB.id, r: agentB.id })).error).toBeNull();
  });
});

describe('#1946 fix head (Atilla\'s P2s on #1955)', () => {
  it('P2-1: a fault while resolving the Agent surfaces; the asset ops never run without their read gate', async () => {
    let tripped = false;
    const faulty = new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== 'agent') return typeof value === 'function' ? value.bind(target) : value;
        return new Proxy(value, {
          get(t, p) {
            const fn = Reflect.get(t, p);
            if (p !== 'findFirst') return typeof fn === 'function' ? fn.bind(t) : fn;
            return async (args: unknown) => {
              if (!tripped) { tripped = true; throw new Error('database unavailable'); }
              return fn.call(t, args);
            };
          },
        });
      },
    }) as Context['db'];
    for (const req of [
      { query: 'mutation($r: String!) { beginAssetUpload(input: { agentUrn: $r, filename: "a.png", mimeType: "image/png", sizeBytes: 10, uploadIntent: USER }) { uploadId } }', variables: { r: urnOf(secret) } },
      { query: 'query($r: String!) { agentAssets(agentUrn: $r) { total } }', variables: { r: urnOf(secret) } },
      { query: 'mutation($r: String!) { setAgentAssetUploadEnabled(input: { agentUrn: $r, enabled: true }) { id } }', variables: { r: urnOf(secret) } },
    ]) {
      tripped = false;
      const a = await ask({ db: faulty, userId: adminB, roles: ['READER'] } as Context, req.query, req.variables);
      expect(tripped).toBe(true);
      // #1789: a fault surfaces as the generic envelope; the detail is logged, not returned.
      expect(a.error?.message).toBe('Internal server error.');
      expect(a.error?.extensions).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', requestId: expect.any(String) });
    }
  });

  it('P2-2: resolveAIConfig with an App named answers a foreign personal Agent exactly as an absent one', async () => {
    const personal = await db.agent.create({ data: { ownerUserId: ana, name: 'anas', urn: `ana-p-${generateId().slice(-6)}:anas`, visibility: 'PERSONAL' } });
    const q = 'query($a: ID!, $r: ID!) { resolveAIConfig(appRef: $a, agentRef: $r) { configId } }';
    const real = await ask(ctx(adminB), q, { a: appB.id, r: personal.id });
    const absentId = generateId();
    const guessed = await ask(ctx(adminB), q, { a: appB.id, r: absentId });
    expect(masked(real, personal.id)).toEqual(masked(guessed, absentId));
    expect(real.error?.extensions.code).toBe('AGENT_NOT_FOUND');
  });
});
