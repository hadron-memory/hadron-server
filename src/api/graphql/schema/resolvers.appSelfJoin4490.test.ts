/**
 * #4490: a caller-safe read of whether an App is open to self-join (Holger: "Yes, with conditions"; the four cor:api:140:02
 * conditions bind the build).
 *
 *  1. An App the caller cannot see answers exactly as today: reaching it is the existing `app(ref:)` gate, and the field is
 *     NULL for anyone who fails that same read gate whichever route reached the App.
 *  2. The answer is a state plus the role a joiner would get, never maxMembers or a member count.
 *  3. It is computed by the SAME check joinApp makes (`resolveSelfJoinRole`), so the two cannot disagree: a same-check pin
 *     runs both against every row of the table.
 *  4. It reveals nothing new to a caller who is already a member: a member's answer is MEMBER with no role, whatever the
 *     policy says, so an open and a closed App read identically to them.
 *
 * Asserted through a real ApolloServer (formatError runs), apart from the direct resolver check of the nested-reach gate.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { buildSchema, type GraphQLObjectType } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { formatGraphQLError } from '../formatError.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const server = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });
async function ask(contextValue: Context, query: string, variables: Record<string, unknown> = {}) {
  const res = await server.executeOperation({ query, variables }, { contextValue });
  if (res.body.kind !== 'single') throw new Error('unexpected incremental response');
  const { data, errors } = res.body.singleResult;
  const e = errors?.[0];
  const { stacktrace: _drop, ...extensions } = (e?.extensions ?? {}) as Record<string, unknown>;
  return { data: (data ?? null) as any, error: e ? { message: e.message, extensions } : null };
}
const Q = `query($r: ID!) { app(ref: $r) { id selfJoin { state role } } }`;
const Q_WITHOUT = `query($r: ID!) { app(ref: $r) { id } }`;
const M = resolvers.Mutation as any;

let org: { id: string; urn: string };
let agent: { id: string };
let app: { id: string; urn: string };
let orgViewer: { id: string }; // an org member who is not an App participant: the caller this read is for
let stranger: { id: string }; // sees nothing
let participant: { id: string }; // already an App member
const as = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as unknown as Context;
const setPolicy = (policy: Record<string, unknown>) => db.agent.update({ where: { id: agent.id }, data: { installationPolicy: policy as never } });
let seq = 0;
const mkUser = async () => { seq += 1; return db.user.create({ data: { githubId: 449000 + seq, githubUsername: `u4490-${seq}`, roles: ['READER'] } }); };
const read = async (userId: string) => (await ask(as(userId), Q, { r: app.id })).data?.app?.selfJoin;

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'o4490', urn: 'o4490.example' } });
  orgViewer = await mkUser(); stranger = await mkUser(); participant = await mkUser();
  await db.orgMember.create({ data: { organizationId: org.id, userId: orgViewer.id, role: 'READER' } });
  agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:agent`, name: 'agent' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:app`, name: 'app', appAgents: { create: { agentId: agent.id } } } });
  await db.appMember.create({ data: { appId: app.id, userId: participant.id, role: 'member' } });
});

const OPEN = { maxMembers: '50', memberRoles: ['owner', 'member'], selfJoinRole: 'member' };

describe('#4490 the state a viewer reads', () => {
  it('an open App answers OPEN plus the role a joiner would get', async () => {
    await setPolicy(OPEN);
    expect(await read(orgViewer.id)).toEqual({ state: 'OPEN', role: 'member' });
  });
  it.each([
    ['no selfJoinRole (the schema default)', { maxMembers: 'unlimited', memberRoles: ['owner'] }],
    ['a selfJoinRole of owner (never self-granted)', { maxMembers: 'unlimited', memberRoles: ['owner', 'member'], selfJoinRole: 'owner' }],
    ['a selfJoinRole the App does not offer', { maxMembers: 'unlimited', memberRoles: ['owner', 'member'], selfJoinRole: 'guest' }],
    ['a non-string selfJoinRole', { maxMembers: 'unlimited', memberRoles: ['owner', 'member'], selfJoinRole: 7 }],
  ])('%s answers CLOSED with no role', async (_label, policy) => {
    await setPolicy(policy);
    expect(await read(orgViewer.id)).toEqual({ state: 'CLOSED', role: null });
  });
  it('an App with no installed Agent answers CLOSED (nothing opted in)', async () => {
    await db.appAgent.deleteMany({ where: { appId: app.id } });
    expect(await read(orgViewer.id)).toEqual({ state: 'CLOSED', role: null });
  });
  it('an uninstalled App answers CLOSED even if its Agent opted in (joinApp refuses it)', async () => {
    await setPolicy(OPEN);
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    expect(await read(orgViewer.id)).toEqual({ state: 'CLOSED', role: null });
  });
});

describe('#4490 condition 2: a state and a role, never capacity', () => {
  it('the type carries exactly state and role: no maxMembers, no member count', () => {
    const t = buildSchema(typeDefs).getType('AppSelfJoin') as GraphQLObjectType;
    expect(Object.keys(t.getFields()).sort()).toEqual(['role', 'state']);
  });
  it('an open App with a tiny maxMembers reads the same as one with none: capacity is never part of the answer', async () => {
    await setPolicy({ ...OPEN, maxMembers: '1' });
    const small = await read(orgViewer.id);
    expect(small).toEqual({ state: 'OPEN', role: 'member' }); // a real answer, so the equality below is not undefined === undefined
    await setPolicy({ ...OPEN, maxMembers: 'unlimited' });
    expect(await read(orgViewer.id)).toEqual(small);
  });
});

describe('#4490 condition 3: the same check joinApp makes', () => {
  // Each row runs BOTH the read and the real joinApp on a fresh joiner. OPEN must be exactly the rows joinApp accepts, with
  // the role it grants; CLOSED exactly the rows it refuses.
  const rows: Array<[string, Record<string, unknown>, (() => Promise<unknown>) | null]> = [
    ['open', OPEN, null],
    ['schema default', { maxMembers: 'unlimited', memberRoles: ['owner'] }, null],
    ['owner as selfJoinRole', { memberRoles: ['owner', 'member'], selfJoinRole: 'owner' }, null],
    ['unoffered selfJoinRole', { memberRoles: ['owner', 'member'], selfJoinRole: 'guest' }, null],
    ['open, App at capacity (the gate admits, capacity refuses)', { maxMembers: '1', memberRoles: ['owner', 'member'], selfJoinRole: 'member' }, null],
  ];
  it.each(rows)('%s: the read and joinApp agree', async (_label, policy) => {
    await setPolicy(policy);
    const seen = await read(orgViewer.id);
    const joiner = await mkUser();
    await db.orgMember.create({ data: { organizationId: org.id, userId: joiner.id, role: 'READER' } });
    const joined = await M.joinApp(null, { appRef: app.id }, as(joiner.id)).then(() => ({ ok: true }), (e: any) => ({ ok: false, code: e.extensions?.code }));
    const row = await db.appMember.findUnique({ where: { appId_userId: { appId: app.id, userId: joiner.id } } });
    if (seen.state === 'OPEN') {
      // OPEN says the self-join GATE admits, with this role. Capacity is deliberately not part of the answer (condition 2), so an
      // OPEN App that is full is refused by joinApp for capacity ONLY, never by the gate.
      if (joined.ok) expect(row?.role).toBe(seen.role);
      else expect(joined).toMatchObject({ code: 'MaxMembersExceededError' });
    } else {
      expect(seen.state).toBe('CLOSED');
      expect(joined).toMatchObject({ ok: false, code: 'SelfJoinNotAllowedError' });
      expect(row).toBeNull();
    }
  });
  it('the decision is the exported resolveSelfJoinRole, not a second copy', async () => {
    const { resolveSelfJoinRole } = await import('../../../controller/operations/joinApp.js');
    await setPolicy(OPEN);
    expect(await resolveSelfJoinRole(db, app.id)).toBe('member');
    await setPolicy({ memberRoles: ['owner'] });
    await expect(resolveSelfJoinRole(db, app.id)).rejects.toMatchObject({ name: 'SelfJoinNotAllowedError' });
  });
});

describe('#4490 condition 4: a member learns nothing new', () => {
  it('a member who can read the App reads MEMBER with no role, and an open and a closed App read identically to them', async () => {
    await db.orgMember.create({ data: { organizationId: org.id, userId: participant.id, role: 'READER' } }); // a participant who can also read the App by app(ref:)
    await setPolicy(OPEN);
    const open = await read(participant.id);
    await setPolicy({ memberRoles: ['owner'] });
    const closed = await read(participant.id);
    expect(open).toEqual({ state: 'MEMBER', role: null });
    expect(closed).toEqual(open);
  });
  it('a member who cannot read the App by app(ref:) reaches it only through their membership and learns nothing: null', async () => {
    await setPolicy(OPEN);
    const row = await db.app.findUniqueOrThrow({ where: { id: app.id } });
    expect(await (resolvers as any).App.selfJoin(row, {}, as(participant.id))).toBeNull();
  });
});

describe('#4490 condition 1: an App the caller cannot see answers exactly as today', () => {
  it('selecting selfJoin changes nothing for a caller who cannot read the App, nor for a missing App', async () => {
    await setPolicy(OPEN);
    for (const ref of [app.id, generateId()]) {
      const without = await ask(as(stranger.id), Q_WITHOUT, { r: ref });
      const withField = await ask(as(stranger.id), Q, { r: ref });
      expect(withField).toEqual(without);
      expect(JSON.stringify(withField)).not.toMatch(/OPEN|CLOSED|MEMBER|member/);
    }
  });
  it('the field itself is NULL for a caller who fails the read gate, whichever route reached the App', async () => {
    await setPolicy(OPEN);
    const row = await db.app.findUniqueOrThrow({ where: { id: app.id } });
    const field = (resolvers as any).App.selfJoin;
    expect(await field(row, {}, as(stranger.id))).toBeNull();
    // an App key and a request with no user are not the joining user either
    expect(await field(row, {}, { db, appId: app.id, roles: [] } as unknown as Context)).toBeNull();
    // an impersonated session and a headless run are refused principals: the viewer is not themselves the joining user
    const impersonated = { ...as(orgViewer.id), impersonation: { sessionId: generateId(), actorUserId: stranger.id, orgId: org.id, expiresAt: new Date('2099-01-01') } } as unknown as Context;
    const run = { ...as(orgViewer.id), clientId: 'run:fixture', appId: app.id } as unknown as Context;
    expect(await field(row, {}, impersonated)).toBeNull();
    expect(await field(row, {}, run)).toBeNull();
    expect(await field(row, {}, as(orgViewer.id))).toEqual({ state: 'OPEN', role: 'member' }); // the positive control
  });
  it('a soft-deleted App is not found, as before', async () => {
    await setPolicy(OPEN);
    await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    const a = await ask(as(orgViewer.id), Q, { r: app.id });
    expect(a.data?.app ?? null).toBeNull();
  });
});
