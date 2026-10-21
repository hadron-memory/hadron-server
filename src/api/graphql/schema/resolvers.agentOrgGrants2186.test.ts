import { ApolloServer } from '@apollo/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { requestActorStorage } from '../../../lib/requestActor.js';
import { cleanDb, createDbOrgAndGraph } from '../../../test/helpers.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });

// #2186: Organization.agentOrgGrants is for the org's OWNER/ADMIN. An ordinary
// user token carries no organizationId, so the role gate must decide.
describe('#2186 Organization.agentOrgGrants for org OWNER/ADMIN user tokens', () => {
  let orgId: string;
  let otherOrgId: string;
  let githubSeq = 9218600;

  const mkUser = (roles: ('READER' | 'ADMIN')[] = ['READER']) =>
    db.user.create({ data: { githubId: githubSeq++, githubUsername: `u2186-${githubSeq}`, roles } });
  const member = async (role: 'OWNER' | 'ADMIN' | 'CONTRIBUTOR' | 'READER', deletedAt: Date | null = null) => {
    const u = await mkUser();
    await db.orgMember.create({ data: { organizationId: orgId, userId: u.id, role, deletedAt } });
    return u;
  };
  const read = async (ctx: Partial<Context>) => {
    const res = await server.executeOperation(
      { query: 'query($o: ID!){ organization(ref:$o){ agentOrgGrants { agentId isActive } } }', variables: { o: orgId } },
      { contextValue: { db, ...ctx } as Context },
    );
    expect(res.body.kind).toBe('single');
    if (res.body.kind !== 'single') throw new Error('unreachable');
    return res.body.singleResult;
  };
  // The field resolver directly: organization(ref:) has its own gate that
  // already refuses non-members, so the field's gate is exercised in isolation.
  const grants = async (ctx: Partial<Context>) =>
    (await resolvers.Organization.agentOrgGrants({ id: orgId }, {}, { db, ...ctx } as Context)) as unknown as {
      agentId: string;
      isActive: boolean;
    }[];

  let activeId: string;
  let revokedId: string;

  beforeEach(async () => {
    await cleanDb(db);
    const vendor = await createDbOrgAndGraph(db, { orgName: 'vendor-2186', graphName: 'v' });
    const customer = await createDbOrgAndGraph(db, { orgName: 'customer-2186', graphName: 'c' });
    const other = await createDbOrgAndGraph(db, { orgName: 'other-2186', graphName: 'o' });
    orgId = customer.org.id;
    otherOrgId = other.org.id;
    const mkAgent = (name: string) =>
      db.agent.create({
        data: { organizationId: vendor.org.id, urn: `vendor-2186:${name}`, name, visibility: 'PUBLIC' },
      });
    const a = await mkAgent('active');
    const b = await mkAgent('revoked');
    activeId = a.id;
    revokedId = b.id;
    await db.agentOrgGrant.create({
      data: { orgId, agentId: a.id, activatedAt: new Date(), createdAt: new Date('2026-01-01') },
    });
    await db.agentOrgGrant.create({
      data: { orgId, agentId: b.id, activatedAt: new Date(), revokedAt: new Date(), createdAt: new Date('2026-01-02') },
    });
  });

  it.each(['OWNER', 'ADMIN'] as const)('an ordinary user token for an org %s sees active and revoked grants in order', async (role) => {
    const u = await member(role);
    const r = await read({ userId: u.id, roles: ['READER'] });
    expect(r.errors).toBeUndefined();
    const out = (r.data as { organization: { agentOrgGrants: { agentId: string; isActive: boolean }[] } }).organization
      .agentOrgGrants;
    expect(out.map((g) => [g.agentId, g.isActive])).toEqual([
      [activeId, true],
      [revokedId, false],
    ]);
  });

  it.each(['CONTRIBUTOR', 'READER'] as const)('an org %s sees none', async (role) => {
    const u = await member(role);
    expect(await grants({ userId: u.id, roles: ['READER'] })).toEqual([]);
  });

  it('a revoked ADMIN membership sees none', async () => {
    const u = await member('ADMIN', new Date());
    expect(await grants({ userId: u.id, roles: ['READER'] })).toEqual([]);
  });

  it('another org\'s admin sees none', async () => {
    const u = await mkUser();
    await db.orgMember.create({ data: { organizationId: otherOrgId, userId: u.id, role: 'ADMIN' } });
    expect(await grants({ userId: u.id, roles: ['READER'] })).toEqual([]);
  });

  it('a user with no membership, and an anonymous caller, see none', async () => {
    const u = await mkUser();
    expect(await grants({ userId: u.id, roles: ['READER'] })).toEqual([]);
    expect(await grants({ roles: [] })).toEqual([]);
  });

  it('platform admin control still sees the grants', async () => {
    const u = await mkUser(['ADMIN']);
    expect((await grants({ userId: u.id, roles: ['ADMIN'] })).length).toBe(2);
  });

  it('an org-scoped client pinned to ANOTHER org sees none even for an admin user', async () => {
    const u = await member('ADMIN');
    expect(await grants({ userId: u.id, organizationId: otherOrgId, roles: ['READER'] })).toEqual([]);
  });

  it('an org-scoped client pinned to this org still works for an admin user', async () => {
    const u = await member('ADMIN');
    expect((await grants({ userId: u.id, organizationId: orgId, roles: ['READER'] })).length).toBe(2);
  });

  it('a key/run context with this organizationId but no user sees none', async () => {
    expect(await grants({ organizationId: orgId, roles: [] })).toEqual([]);
  });

  it('impersonation: an admin of this org via a session for the SAME org sees them; for another org sees none', async () => {
    const u = await member('ADMIN');
    const same = { userId: u.id, roles: [], impersonation: { orgId } } as unknown as Partial<Context>;
    expect((await grants(same)).length).toBe(2);
    const other = { userId: u.id, roles: [], impersonation: { orgId: otherOrgId } } as unknown as Partial<Context>;
    expect(await grants(other)).toEqual([]);
  });

  it('a worker-bound session under an org OWNER/ADMIN token sees none (the Worker is not the admin); ambiguous bindings too', async () => {
    const u = await member('OWNER');
    const ctx: Partial<Context> = { userId: u.id, roles: ['READER'] };
    expect((await grants(ctx)).length).toBe(2);
    expect(await requestActorStorage.run({ workerId: 'w1', agentId: null }, () => grants(ctx))).toEqual([]);
    expect(
      await requestActorStorage.run({ workerId: null, agentId: null, ambiguousSessionIds: ['s1', 's2'] }, () =>
        grants(ctx),
      ),
    ).toEqual([]);
  });

  it('a headless run (org-matching organizationId, on behalf of an admin, even with a platform role) sees none; a direct person keeps access', async () => {
    const u = await member('OWNER');
    const admin = await mkUser(['ADMIN']);
    const run = (userId: string, roles: Context['roles']): Partial<Context> => ({
      userId,
      organizationId: orgId,
      clientId: 'run:00000000-run',
      roles,
    });
    expect(await grants(run(u.id, ['READER']))).toEqual([]);
    expect(await grants(run(admin.id, ['ADMIN']))).toEqual([]);
    expect((await grants({ userId: u.id, organizationId: orgId, clientId: `user:${u.id}`, roles: ['READER'] })).length).toBe(2);
  });

  it('an unexpected DB failure is not swallowed into an empty list', async () => {
    const u = await member('ADMIN');
    const spy = vi.spyOn(db.orgMember, 'findFirst').mockRejectedValue(new Error('boom'));
    try {
      await expect(grants({ userId: u.id, roles: ['READER'] })).rejects.toThrow('boom');
    } finally {
      spy.mockRestore();
    }
  });
});
