/** #3982 — Holger model A: unreachable Apps look unknown; reachable non-managers keep FORBIDDEN.
 * Management admission precedes state/input errors and legacy ambiguity. Runtime authority is unchanged.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { typeDefs } from './typeDefs.js';
import { formatGraphQLError } from '../formatError.js';
import { runContext } from '../../../jobs/appRunDeps.js';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
const api = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError, includeStacktraceInErrorResponses: false });
afterAll(() => api.stop());
const ctx = (userId?: string, roles: Context['roles'] = ['READER']): Context => ({ db, userId, roles });

async function refusal(p: Promise<unknown>): Promise<{ code: unknown; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as GraphQLError & { code?: string };
    // formatError maps the typed ambiguity error to its wire code later; a direct resolver call carries its name.
    return { code: err.extensions?.code ?? err.code ?? err.name, message: err.message };
  }
  throw new Error('expected a rejection');
}

let n = 0;
const mkUser = (label: string) =>
  db.user.create({ data: { githubId: 9_000_000 + ++n, githubUsername: `da-${label}-${generateId()}`, roles: ['READER'] }, select: { id: true } });

let org: { id: string; urn: string };
let otherOrg: { id: string };
let admin: { id: string }, orgMember: { id: string }, otherAdmin: { id: string }, stranger: { id: string };
let app: { id: string; urn: string };

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'da-org', urn: `da-${generateId().toLowerCase()}.example` } });
  otherOrg = await db.organization.create({ data: { id: generateId(), name: 'da-other', urn: `dx-${generateId().toLowerCase()}.example` } });
  [admin, orgMember, otherAdmin, stranger] = await Promise.all(['ad', 'me', 'oa', 'st'].map(mkUser));
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: orgMember.id, role: 'CONTRIBUTOR' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: otherOrg.id, userId: otherAdmin.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Da', urn: `${org.urn}:da` }, select: { id: true, urn: true } });
});

const row = () => db.app.findUniqueOrThrow({ where: { id: app.id } });


describe('#3982 updateApp reach versus act (Holger model A)', () => {
  const update = (ref: string, c = ctx(stranger.id), input = {}) => M.updateApp({}, { ref, name: 'changed', ...input }, c);
  const unknown = (ref: string) => ({ code: 'APP_NOT_FOUND', message: `APP_NOT_FOUND: ${ref}` });
  const denied = { code: 'FORBIDDEN', message: 'Forbidden' };

  it.each(['id', 'urn'] as const)('unreachable existing and missing %s use the same unknown envelope, with only the supplied ref', async kind => {
    const ref = app[kind];
    const missing = kind === 'id' ? generateId() : `${org.urn}:missing`;
    for (const who of [stranger.id, otherAdmin.id, undefined]) {
      expect(await refusal(update(ref, ctx(who)))).toEqual(unknown(ref));
      expect(await refusal(update(missing, ctx(who)))).toEqual(unknown(missing));
    }
    expect((await row()).name).toBe('Da');
  });

  it.each(['id', 'urn'] as const)('reachable non-admin keeps FORBIDDEN by %s; admin updates', async kind => {
    expect(await refusal(update(app[kind], ctx(orgMember.id)))).toEqual(denied);
    expect((await update(app[kind], ctx(admin.id))).name).toBe('changed');
  });

  it('an App member without any org role reaches but cannot act', async () => {
    await db.appMember.create({ data: { appId: app.id, userId: stranger.id, role: 'member' } });
    expect(await refusal(update(app.id))).toEqual(denied);
  });

  it('deleted by ID: admit then APP_DELETED, reachable non-admin FORBIDDEN, unreachable unknown; URN stays unknown', async () => {
    await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    expect((await refusal(update(app.id, ctx(admin.id)))).code).toBe('APP_DELETED');
    expect(await refusal(update(app.id, ctx(orgMember.id)))).toEqual(denied);
    expect(await refusal(update(app.id))).toEqual(unknown(app.id));
    expect(await refusal(update(app.urn, ctx(admin.id)))).toEqual(unknown(app.urn));
    expect((await row()).name).toBe('Da');
  });

  it('uninstalled by ID preserves #3980 after admission; former URN reaches no row', async () => {
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    expect((await refusal(update(app.id, ctx(admin.id)))).code).toBe('APP_UNINSTALLED');
    expect(await refusal(update(app.id, ctx(orgMember.id)))).toEqual(denied);
    expect(await refusal(update(app.id))).toEqual(unknown(app.id));
    expect(await refusal(update(app.urn, ctx(admin.id)))).toEqual(unknown(app.urn));
  });

  it('legacy ambiguity requires management of EVERY claimant; partial reach is FORBIDDEN, none is unknown', async () => {
    const legacy = `${org.urn}:legacy`;
    await db.app.update({ where: { id: app.id }, data: { legacyUrn: legacy } });
    const second = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Second', urn: `${org.urn}:second`, legacyUrn: legacy } });
    expect((await refusal(update(legacy, ctx(admin.id)))).code).toBe('AmbiguousLegacyUrnError');
    expect(await refusal(update(legacy, ctx(orgMember.id)))).toEqual(denied);
    expect(await refusal(update(legacy))).toEqual(unknown(legacy));
    await db.app.create({ data: { id: generateId(), organizationId: otherOrg.id, name: 'Third', urn: 'foreign.example:third', legacyUrn: legacy } });
    expect(await refusal(update(legacy, ctx(admin.id)))).toEqual(denied);
    expect(await refusal(update(legacy, ctx(otherAdmin.id)))).toEqual(denied);
    expect((await row()).name).toBe('Da');
    expect((await db.app.findUniqueOrThrow({ where: { id: second.id } })).name).toBe('Second');
  });

  it.each([{ sessionDormancyDays: 0 }, { sessionTimeoutSeconds: 0 }, { policy: { invalid: true } }])('input %j is judged only after admission; refuses without App/config or writer side effects', async input => {
    const before = await row();
    const configBefore = await db.aiServiceConfig.findMany({ where: { appId: app.id } });
    const appWrite = vi.spyOn(db.app, 'update');
    const configWrite = vi.spyOn(db.aiServiceConfig, 'create');
    const tx = vi.spyOn(db, '$transaction');
    try {
      expect(await refusal(update(app.id, ctx(stranger.id), input))).toEqual(unknown(app.id));
      expect(await refusal(update(app.id, ctx(orgMember.id), input))).toEqual(denied);
      expect((await refusal(update(app.id, ctx(admin.id), input))).code).toBe('BAD_USER_INPUT');
      expect(appWrite).not.toHaveBeenCalled();
      expect(configWrite).not.toHaveBeenCalled();
      expect(tx).not.toHaveBeenCalled();
      expect(await row()).toEqual(before);
      expect(await db.aiServiceConfig.findMany({ where: { appId: app.id } })).toEqual(configBefore);
    } finally { vi.restoreAllMocks(); }
  });

  it('user-owned Apps: owner updates, ordinary/owner-role members only reach, platform admin has no shortcut', async () => {
    await db.app.update({ where: { id: app.id }, data: { organizationId: null, ownerUserId: admin.id } });
    await db.appMember.create({ data: { appId: app.id, userId: orgMember.id, role: 'owner' } });
    expect(await refusal(update(app.id, ctx(orgMember.id)))).toEqual(denied);
    expect(await refusal(update(app.id, ctx(stranger.id, ['ADMIN'])))).toEqual(unknown(app.id));
    expect((await update(app.id, ctx(admin.id))).name).toBe('changed');
  });

  it('platform authority on org Apps is preserved; impersonation stays in its shared org', async () => {
    expect((await update(app.id, ctx(stranger.id, ['ADMIN']))).name).toBe('changed');
    const imp = { ...ctx(admin.id), impersonation: { orgId: otherOrg.id } } as Context;
    expect(await refusal(update(app.id, imp))).toEqual(unknown(app.id));
    expect((await update(app.id, { ...ctx(admin.id), impersonation: { orgId: org.id } } as Context)).name).toBe('changed');
  });

  it('live own-App keys reach but cannot manage; foreign, revoked and selected-only keys learn nothing', async () => {
    const key = await db.appKey.create({ data: { appId: app.id, keyHash: generateId(), keyPreview: 'test' } });
    const own = { db, roles: [], appId: app.id, appKeyId: key.id } as Context;
    expect(await refusal(update(app.id, own))).toEqual(denied);
    const foreign = { ...own, appId: generateId() };
    expect(await refusal(update(app.id, foreign))).toEqual(unknown(app.id));
    expect(await refusal(update(app.id, { db, roles: [], appId: app.id } as Context))).toEqual(unknown(app.id));
    await db.appKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
    expect(await refusal(update(app.id, own))).toEqual(unknown(app.id));
  });

  it('legacy column and alias-map claimants are combined without truncation or first-claimant admission', async () => {
    const legacy = `${org.urn}:aliases`;
    await db.app.update({ where: { id: app.id }, data: { legacyUrn: legacy } });
    const second = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Second', urn: `${org.urn}:second` } });
    const third = await db.app.create({ data: { id: generateId(), organizationId: otherOrg.id, name: 'Third', urn: 'foreign.example:third' } });
    for (const a of [second, third]) await db.urnAlias.create({ data: { entityType: 'APP', entityId: a.id, urn: legacy, reason: 'RENAME' } });
    expect(await refusal(update(legacy, ctx(admin.id)))).toEqual(denied);
    await db.orgMember.create({ data: { organizationId: otherOrg.id, userId: admin.id, role: 'ADMIN' } });
    expect((await refusal(update(legacy, ctx(admin.id)))).code).toBe('AmbiguousLegacyUrnError');
  });

  it.each(['id', 'urn'] as const)('the GraphQL %s unknown response shape differs only in the caller-supplied ref', async kind => {
    const ask = async (ref: string) => {
      const result = await api.executeOperation({ query: 'mutation($ref:ID!){updateApp(ref:$ref,name:"changed"){id}}', variables: { ref } }, { contextValue: ctx(stranger.id) });
      if (result.body.kind !== 'single') throw new Error('unexpected incremental response');
      return JSON.parse(JSON.stringify(result.body.singleResult).split(ref).join('<ref>'));
    };
    const missing = kind === 'id' ? generateId() : `${org.urn}:missing`;
    const a = await ask(app[kind]);
    expect(a).toEqual(await ask(missing));
    expect(a.errors).toHaveLength(1);
    expect(a.errors[0]).toMatchObject({ message: 'APP_NOT_FOUND: <ref>', extensions: { code: 'APP_NOT_FOUND' } });
    expect(a.data).toBeNull();
  });

  it('refused valid config/rename arguments never enter the transaction or side-effect writers', async () => {
    const config = await db.aiServiceConfig.create({ data: { appId: app.id, name: 'default', provider: 'openai', model: 'synthetic' } });
    const before = await row();
    const writers = [vi.spyOn(db, '$transaction'), vi.spyOn(db.app, 'update'), vi.spyOn(db.aiServiceConfig, 'update'),
      vi.spyOn(db.aiServiceConfig, 'create'), vi.spyOn(db.aiServiceConfig, 'delete'), vi.spyOn(db.urnAlias, 'create'), vi.spyOn(db.usageEvent, 'create')];
    try {
      const args = { urn: 'renamed', aiProvider: null };
      for (const ref of [app.id, app.urn, generateId(), `${org.urn}:missing`]) {
        expect(await refusal(update(ref, ctx(stranger.id), args))).toEqual(unknown(ref));
      }
      expect(await refusal(update(app.id, ctx(orgMember.id), args))).toEqual(denied);
      for (const writer of writers) expect(writer).not.toHaveBeenCalled();
      expect(await row()).toEqual(before);
      expect(await db.aiServiceConfig.findUniqueOrThrow({ where: { id: config.id } })).toEqual(config);
      expect(await db.urnAlias.findMany({ where: { entityType: 'APP', entityId: app.id } })).toEqual([]);
    } finally { vi.restoreAllMocks(); }
  });

  it('a userless run needs its own live snapshot grant for reach, and a grant never confers update authority', async () => {
    const schedule = await db.agentSchedule.create({ data: { id: generateId(), appId: app.id, organizationId: org.id, name: 'Synthetic', cron: '* * * * *', entryNodeUrn: 'hrn:node:synthetic.example:flows:report' } });
    const run = await db.appRun.create({ data: { id: generateId(), appId: app.id, organizationId: org.id, triggerKind: 'SCHEDULE', triggerId: schedule.id, entryNodeUrn: schedule.entryNodeUrn, status: 'RUNNING' } });
    const c = runContext(db, run);
    expect(await refusal(update(app.id, c))).toEqual(unknown(app.id));
    const grant = await db.appAutomationTeamSnapshotGrant.create({ data: { appId: app.id, triggerKind: 'SCHEDULE', triggerId: schedule.id, grantedBy: admin.id } });
    expect(await refusal(update(app.id, c))).toEqual(denied);
    expect(await refusal(update(generateId(), c))).toMatchObject({ code: 'APP_NOT_FOUND' });
    await db.appAutomationTeamSnapshotGrant.update({ where: { id: grant.id }, data: { revokedAt: new Date(), revokedBy: admin.id } });
    expect(await refusal(update(app.id, c))).toEqual(unknown(app.id));
    expect((await row()).name).toBe('Da');
  });

  it('syntax errors keep their independent refusal; DB faults during lookup and reach are never hidden', async () => {
    expect((await refusal(update('relative'))).code).toBe('URN_NOT_QUALIFIED');
    const failure = new Error('injected storage failure');
    const lookup = vi.spyOn(db.app, 'findUnique').mockRejectedValueOnce(failure);
    try { await expect(update(app.id)).rejects.toBe(failure); } finally { lookup.mockRestore(); }
    const reach = vi.spyOn(db.appMember, 'findUnique').mockRejectedValueOnce(failure);
    try { await expect(update(app.id)).rejects.toBe(failure); } finally { reach.mockRestore(); }
  });
});
