/**
 * #3977 (ruling V58, cor:agt:020:04 / cor:dmo:050:11) — a caller who cannot REACH an App gets the answer an absent App
 * gets: `APP_NOT_FOUND` "App not found.", on team chat read and post, the worker list, worker cast (and the team-role
 * reads that share the gate). A caller who CAN reach the App but lacks the role keeps FORBIDDEN.
 *
 * The MCP twins (`hadron_team_chat_read`, `hadron_list_workers`, `hadron_cast_worker`) are disabled over MCP since
 * #3082 (`offTeamTool`), so these gates are their only path; the GraphQL surface is pinned here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { runAuthContext } from '../../../lib/auth/runPrincipal.js';
import { formatGraphQLError as formatError } from '../formatError.js';
import { resolveAppRef } from '../../../lib/entityRef/appRef.js';
import { AmbiguousLegacyUrnError } from '../../../lib/entityRef/errors.js';
import { ApolloServer } from '@apollo/server';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
const M = resolvers.Mutation as any;
const Q = resolvers.Query as any;
const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });

/** The refusal as the wire shows it: the error is run through the server's own formatter. */
async function wire(p: Promise<unknown>): Promise<unknown> {
  try { await p; return 'NO_ERROR'; } catch (e) {
    const err = e instanceof GraphQLError ? e : new GraphQLError((e as Error).message, { originalError: e as Error });
    const f = formatError(err.toJSON() as any, err) as any;
    return { message: f.message, code: f.extensions?.code, extra: Object.keys(f.extensions ?? {}).filter((k) => k !== 'code' && k !== 'stacktrace').sort() };
  }
}
const NOT_FOUND = { message: 'App not found.', code: 'APP_NOT_FOUND', extra: [] };

let org: any, otherOrg: any, admin: any, member: any, reader: any, outsider: any, foreigner: any, teamAgent: any, app: any, foreignApp: any;
async function user(n: number) {
  return db.user.create({ data: { id: generateId(), githubId: 397_700 + n, githubUsername: `nf-${n}`, roles: ['READER'] }, select: { id: true } });
}
beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'nf-org', urn: 'nf-org.com' } });
  otherOrg = await db.organization.create({ data: { id: generateId(), name: 'nf-other', urn: 'nf-other.com' } });
  admin = await user(1); outsider = await user(2); member = await user(3); reader = await user(4); foreigner = await user(5);
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: otherOrg.id, userId: foreigner.id, role: 'CONTRIBUTOR' } });
  teamAgent = await M.createAgent({}, { orgId: org.id, name: 'Team Agent' }, ctx(admin.id));
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Team', urn: `${org.urn}:team` } });
  foreignApp = await db.app.create({ data: { id: generateId(), organizationId: otherOrg.id, name: 'Else', urn: `${otherOrg.urn}:else` } });
  await db.agent.update({ where: { id: teamAgent.id }, data: { personaRole: 'server-engineer' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: member.id, role: 'member' } });
  await db.appMember.create({ data: { appId: app.id, userId: reader.id, role: 'reader' } });
});

const SURFACES: Array<[string, (c: Context, ref: string) => Promise<unknown>]> = [
  ['teamChatMessages (read)', (c, ref) => Q.teamChatMessages({}, { appRef: ref }, c)],
  ['createTeamChatMessage (post)', (c, ref) => M.createTeamChatMessage({}, { appRef: ref, body: 'hi' }, c)],
  ['workers (list)', (c, ref) => Q.workers({}, { appRef: ref }, c)],
  ['teamRoles (read)', (c, ref) => Q.teamRoles({}, { appRef: ref }, c)],
  ['castWorker', (c, ref) => M.castWorker({}, { appRef: ref, agentRef: teamAgent.id, name: 'Zed' }, c)],
  ['castWorkerPreview', (c, ref) => Q.castWorkerPreview({}, { appRef: ref, agentRef: teamAgent.id, name: 'Zed' }, c)],
];
const ABSENT = 'nf-org.com:nope';

const OUTSIDERS: Array<[string, () => Context]> = [
  ['a signed-in user with no membership', () => ctx(outsider.id)],
  ["another org's CONTRIBUTOR", () => ctx(foreigner.id)],
  ["another App's key", () => ({ db, roles: [], appId: foreignApp.id } as Context)],
  ['a userless run of another App without a snapshot grant', () => ({ db, ...runAuthContext({ id: generateId(), appId: foreignApp.id, userId: null, organizationId: otherOrg.id }) } as Context)],
  ['an impersonation session outside the App\'s org', () => ctx(admin.id, { impersonation: { orgId: otherOrg.id } as any })],
];

describe('#3977 a non-participant gets the absent-App answer', () => {
  for (const [surface, call] of SURFACES) {
    for (const [who, as] of OUTSIDERS) {
      it(`${surface}, ${who}: APP_NOT_FOUND "App not found."`, async () => {
        expect(await wire(call(as(), app.urn))).toEqual(NOT_FOUND);
      });
    }
    it(`${surface}: byte-identical to a random absent App, an uninstalled App and a soft-deleted App`, async () => {
      // By URN an uninstalled or deleted App is already unresolvable; by ID it resolves, so the gate must decide.
      const absent = await wire(call(ctx(outsider.id), ABSENT));
      expect(absent).toEqual(NOT_FOUND);
      expect(await wire(call(ctx(outsider.id), generateId()))).toEqual(NOT_FOUND);
      const real = await wire(call(ctx(outsider.id), app.urn));
      await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
      const uninstalled = await wire(call(ctx(outsider.id), app.id));
      await db.app.update({ where: { id: app.id }, data: { uninstalledAt: null, deletedAt: new Date() } });
      const deleted = await wire(call(ctx(outsider.id), app.id));
      expect([real, uninstalled, deleted]).toEqual([absent, absent, absent]);
    });
  }
});

describe('#3977 a participant who lacks the role keeps FORBIDDEN', () => {
  it('castWorker / castWorkerPreview: an AppMember with role reader', async () => {
    for (const call of [SURFACES[4][1], SURFACES[5][1]]) {
      expect(await wire(call(ctx(reader.id), app.urn))).toMatchObject({ code: 'FORBIDDEN' });
    }
  });
  it('createTeamChatMessage: an impersonation session in the App\'s org (reads, never posts)', async () => {
    expect(await wire(SURFACES[1][1](ctx(admin.id, { impersonation: { orgId: org.id } as any }), app.urn))).toMatchObject({ code: 'FORBIDDEN' });
  });
  it('createTeamChatMessage: the App\'s own key (reads, never posts)', async () => {
    expect(await wire(SURFACES[1][1]({ db, roles: [], appId: app.id } as Context, app.urn))).toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('#3977 participants with the role are unchanged', () => {
  it('a member reads the chat and lists workers; an org ADMIN casts', async () => {
    await expect(SURFACES[0][1](ctx(member.id), app.urn)).resolves.toBeDefined();
    await expect(SURFACES[2][1](ctx(member.id), app.urn)).resolves.toBeDefined();
    await expect(SURFACES[2][1](ctx(reader.id), app.urn)).resolves.toBeDefined();
    const cast = await SURFACES[4][1](ctx(admin.id), app.urn) as any;
    expect(cast.name ?? cast.worker?.name).toBe('Zed');
  });
});

describe('#3977 review fixes (blind seat, ffcddde45)', () => {
  const CHAT = [SURFACES[0][1], SURFACES[1][1]];
  it('a soft-deleted App, by id, is not reachable on team chat even to a member, an org ADMIN or its own key', async () => {
    await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    const callers = [ctx(member.id), ctx(admin.id), { db, roles: [], appId: app.id } as Context];
    for (const call of CHAT) for (const c of callers) expect(await wire(call(c, app.id))).toEqual(NOT_FOUND);
  });
  it('an ambiguous legacy URN answers exactly what an absent ref answers', async () => {
    const legacy = 'nf-org.com:dupe';
    await db.app.update({ where: { id: app.id }, data: { legacyUrn: legacy } });
    await db.app.update({ where: { id: foreignApp.id }, data: { legacyUrn: legacy } });
    // Premise: the bare resolver DOES distinguish it (else this pin proves nothing).
    await expect(resolveAppRef(db, legacy)).rejects.toBeInstanceOf(AmbiguousLegacyUrnError);
    for (const [, call] of SURFACES) {
      expect(await wire(call(ctx(outsider.id), legacy))).toEqual(NOT_FOUND);
      expect(await wire(call(ctx(outsider.id), legacy))).toEqual(await wire(call(ctx(outsider.id), ABSENT)));
    }
  });
});

describe('#3977 real GraphQL execution: absent and inaccessible Apps serialize to the same response', () => {
  const server = new ApolloServer<Context>({ typeDefs, resolvers: resolvers as never, formatError: formatError as never });
  const ops: Array<[string, string]> = [
    ['teamChatMessages', 'query($r:ID!){ teamChatMessages(appRef:$r){ __typename } }'],
    ['workers', 'query($r:ID!){ workers(appRef:$r){ __typename } }'],
    ['createTeamChatMessage', 'mutation($r:ID!){ createTeamChatMessage(appRef:$r, body:"hi"){ __typename } }'],
  ];
  const exec = async (query: string, r: string, c: Context) => {
    const res = await server.executeOperation({ query, variables: { r } }, { contextValue: c });
    if (res.body.kind !== 'single') throw new Error('single expected');
    const { errors } = res.body.singleResult;
    return JSON.stringify((errors ?? []).map((e) => ({ message: e.message, path: e.path, locations: e.locations, code: e.extensions?.code, ext: Object.keys(e.extensions ?? {}).filter((k) => k !== 'stacktrace').sort() })));
  };
  for (const [name, q] of ops) {
    it(`${name}: absent, inaccessible-by-urn, inaccessible-by-id and ambiguous refs answer identically`, async () => {
      await db.app.update({ where: { id: app.id }, data: { legacyUrn: 'nf-org.com:dupe2' } });
      await db.app.update({ where: { id: foreignApp.id }, data: { legacyUrn: 'nf-org.com:dupe2' } });
      const c = ctx(outsider.id);
      const absent = await exec(q, ABSENT, c);
      expect(JSON.parse(absent)[0].code).toBe('APP_NOT_FOUND');
      for (const r of [app.urn, app.id, 'nf-org.com:dupe2']) expect(await exec(q, r, c)).toBe(absent);
    });
  }
});
