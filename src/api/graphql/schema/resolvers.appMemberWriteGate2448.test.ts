/**
 * #2448: the App member-write doors (`ensureAppMember`, `removeAppMember`) decide by the one
 * shared role logic (`managesApp`) and refuse the principals that are not the direct user:
 * an impersonation, a run principal, an ambiguous actor and a refused session binding.
 * Worker-session admission is NOT changed here (cor:dmo:050:12 as amended by #2483; S2b owns it,
 * #2766 records it), so a worker-session caller is pinned to behave exactly as on main.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbWorkerAttribution } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { publishAmbiguousActor, runAsActor } from '../../../lib/requestActor.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));

const M = resolvers.Mutation as any;

let seq = 0;
async function mkUser(roles: string[] = ['READER']) {
  seq += 1;
  return db.user.create({ data: { githubId: 244800 + seq, githubUsername: `u2448-${seq}`, roles: roles as never } });
}
const ctxFor = (userId: string, roles: string[] = ['READER'], extra: Record<string, unknown> = {}): Context =>
  ({ db, userId, roles, ...extra }) as unknown as Context;
const member = (appId: string, userId: string) =>
  db.appMember.findUnique({ where: { appId_userId: { appId, userId } } });

let org: { id: string; urn: string };
let orgAdmin: { id: string };
let owner: { id: string };
let target: { id: string };
let orgApp: { id: string };
let userApp: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'o2448', urn: 'o2448.example' } });
  orgAdmin = await mkUser();
  await db.orgMember.create({ data: { organizationId: org.id, userId: orgAdmin.id, role: 'ADMIN' } });
  owner = await mkUser();
  target = await mkUser();
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: org.id, urn: `${org.urn}:agent`, name: 'agent',
    installationPolicy: { maxMembers: 'unlimited', memberRoles: ['owner', 'member'] } as never } });
  orgApp = await db.app.create({ data: {
    id: generateId(), organizationId: org.id, urn: `${org.urn}:app`, name: 'app',
    appAgents: { create: { agentId: agent.id } },
  } });
  userApp = await db.app.create({ data: {
    id: generateId(), ownerUserId: owner.id, urn: `u2448-${seq}:app`, name: 'uapp',
    appAgents: { create: { agentId: agent.id } },
  } });
});

type Variant = { name: string; ctx: (userId: string, roles?: string[]) => Context; scope?: <T>(fn: () => Promise<T>) => Promise<T> };
const direct = <T,>(fn: () => Promise<T>) => fn();
const REFUSED: Variant[] = [
  { name: 'an impersonating caller', ctx: (u, r) => ctxFor(u, r, { impersonation: { orgId: org.id } }) },
  { name: 'a run principal', ctx: (u, r) => ctxFor(u, r, { clientId: `run:${generateId()}` }) },
  { name: 'a refused session binding', ctx: (u, r) => ctxFor(u, r, { sessionBindingRefused: true }) },
  {
    name: 'an ambiguous actor',
    ctx: (u, r) => ctxFor(u, r),
    scope: (fn) => runAsActor({ workerId: null, agentId: null }, async () => { publishAmbiguousActor(['s1', 's2']); return fn(); }),
  },
];

describe('#2448: refused principals, both doors, role-holders included', () => {
  for (const v of REFUSED) {
    const run = v.scope ?? direct;
    it(`ensureAppMember refuses ${v.name} (user-owner, org admin) and changes nothing`, async () => {
      await expect(run(() => M.ensureAppMember(null, { appRef: userApp.id, userRef: target.id, role: 'member' }, v.ctx(owner.id))))
        .rejects.toThrow(/Forbidden/);
      await expect(run(() => M.ensureAppMember(null, { appRef: orgApp.id, userRef: target.id, role: 'member' }, v.ctx(orgAdmin.id))))
        .rejects.toThrow(/Forbidden/);
      expect(await member(userApp.id, target.id)).toBeNull();
      expect(await member(orgApp.id, target.id)).toBeNull();
    });

    it(`removeAppMember refuses ${v.name} (managing or self) and removes nothing`, async () => {
      await db.appMember.create({ data: { appId: orgApp.id, userId: target.id, role: 'member' } });
      await expect(run(() => M.removeAppMember(null, { appRef: orgApp.id, userRef: target.id }, v.ctx(orgAdmin.id))))
        .rejects.toThrow(/Forbidden/);
      await expect(run(() => M.removeAppMember(null, { appRef: orgApp.id, userRef: target.id }, v.ctx(target.id))))
        .rejects.toThrow(/Forbidden/);
      expect(await member(orgApp.id, target.id)).not.toBeNull();
    });

    it(`${v.name} gets the same refusal for an unknown target as for a real one (before resolution)`, async () => {
      const msg = async (userRef: string) => run(() => M.ensureAppMember(null, { appRef: orgApp.id, userRef, role: 'member' }, v.ctx(orgAdmin.id)))
        .then(() => 'ADMITTED', (e: Error) => e.message);
      const real = await msg(target.id);
      expect(real).toMatch(/Forbidden/);
      expect(await msg('no-such-user-2448')).toBe(real);
      const rm = async (userRef: string) => run(() => M.removeAppMember(null, { appRef: orgApp.id, userRef }, v.ctx(orgAdmin.id)))
        .then(() => 'ADMITTED', (e: Error) => e.message);
      expect(await rm('no-such-user-2448')).toBe(await rm(target.id));
      expect(await rm(target.id)).toMatch(/Forbidden/);
    });
  }
});

describe('#2448: the role arms still succeed', () => {
  it('user-owner, org admin, platform admin (org App) and owner-role member can add and remove', async () => {
    const ownerMember = await mkUser();
    await db.appMember.create({ data: { appId: orgApp.id, userId: ownerMember.id, role: 'owner' } });
    const platformAdmin = await mkUser(['ADMIN']);
    const cases: Array<[string, Context]> = [
      [userApp.id, ctxFor(owner.id)],
      [orgApp.id, ctxFor(orgAdmin.id)],
      [orgApp.id, ctxFor(platformAdmin.id, ['ADMIN'])],
      [orgApp.id, ctxFor(ownerMember.id)],
    ];
    for (const [appId, ctx] of cases) {
      const added = await M.ensureAppMember(null, { appRef: appId, userRef: target.id, role: 'member' }, ctx);
      expect(added.role).toBe('member');
      await M.removeAppMember(null, { appRef: appId, userRef: target.id }, ctx);
      expect(await member(appId, target.id)).toBeNull();
    }
  });

  it('a platform admin is still refused on a user-owned App', async () => {
    const platformAdmin = await mkUser(['ADMIN']);
    await expect(M.ensureAppMember(null, { appRef: userApp.id, userRef: target.id, role: 'member' }, ctxFor(platformAdmin.id, ['ADMIN'])))
      .rejects.toThrow(/Forbidden/);
    expect(await member(userApp.id, target.id)).toBeNull();
  });

  it('a plain member may still remove themselves (the self-leave arm is untouched)', async () => {
    await db.appMember.create({ data: { appId: orgApp.id, userId: target.id, role: 'member' } });
    await M.removeAppMember(null, { appRef: orgApp.id, userRef: target.id }, ctxFor(target.id));
    expect(await member(orgApp.id, target.id)).toBeNull();
  });
});

describe('#2448: worker-session callers behave exactly as on main (admission is #2483 S2b)', () => {
  let workerId: string;
  beforeEach(async () => {
    workerId = generateId();
    await createDbWorkerAttribution(db, orgAdmin.id, workerId);
  });
  const asWorker = <T,>(fn: () => Promise<T>) => runAsActor({ workerId, agentId: null }, fn);

  it('a worker session whose holder manages the App is still admitted on both doors', async () => {
    const added: any = await asWorker(() => M.ensureAppMember(null, { appRef: orgApp.id, userRef: target.id, role: 'member' }, ctxFor(orgAdmin.id)));
    expect(added.role).toBe('member');
    await asWorker(() => M.removeAppMember(null, { appRef: orgApp.id, userRef: target.id }, ctxFor(orgAdmin.id)));
    expect(await member(orgApp.id, target.id)).toBeNull();
  });

  it('a worker session whose holder does not manage the App is still refused', async () => {
    await expect(asWorker(() => M.ensureAppMember(null, { appRef: orgApp.id, userRef: target.id, role: 'member' }, ctxFor(target.id))))
      .rejects.toThrow(/Forbidden/);
    expect(await member(orgApp.id, target.id)).toBeNull();
  });
});
