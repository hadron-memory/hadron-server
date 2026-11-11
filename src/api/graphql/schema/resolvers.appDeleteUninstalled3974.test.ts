/**
 * #3974 — deleteApp admits an authorized caller on an UNINSTALLED App named by id (cor:dmo:050:21, Uninstalled → Deleted while uninstalled).
 * Red on main: the app anchor's liveness re-read in withAuthorizedTx refuses an uninstalled row, so the caller the gate admits is refused last.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));

const M = resolvers.Mutation as any;
const ctx = (userId?: string, roles: Context['roles'] = ['READER']): Context => ({ db, userId, roles });

async function code(p: Promise<unknown>): Promise<{ code: unknown; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as GraphQLError & { code?: string };
    return { code: err.extensions?.code ?? err.code, message: err.message };
  }
  throw new Error('expected a rejection');
}

let n = 0;
const mkUser = (label: string, extra: Record<string, unknown> = {}) =>
  db.user.create({ data: { githubId: 9_100_000 + ++n, githubUsername: `du-${label}-${generateId()}`, roles: ['READER'], ...extra }, select: { id: true } });

let org: { id: string; urn: string };
let otherOrg: { id: string };
let admin: { id: string }, orgOwner: { id: string }, orgMember: { id: string }, otherAdmin: { id: string }, stranger: { id: string }, platformAdmin: { id: string };
let app: { id: string; urn: string };

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'du-org', urn: `du-${generateId().toLowerCase()}.example` } });
  otherOrg = await db.organization.create({ data: { id: generateId(), name: 'du-other', urn: `do-${generateId().toLowerCase()}.example` } });
  [admin, orgOwner, orgMember, otherAdmin, stranger] = await Promise.all(['ad', 'ow', 'me', 'oa', 'st'].map((l) => mkUser(l)));
  platformAdmin = await mkUser('pa', { roles: ['ADMIN'] });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: orgOwner.id, role: 'OWNER' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: orgMember.id, role: 'CONTRIBUTOR' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: otherOrg.id, userId: otherAdmin.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Du', urn: `${org.urn}:du` }, select: { id: true, urn: true } });
  expect(await M.uninstallApp({}, { ref: app.id }, ctx(admin.id))).toBe(true);
});

const row = (id = app.id) => db.app.findUniqueOrThrow({ where: { id } });

describe('#3974 deleteApp on an uninstalled App, by id', () => {
  it('an org ADMIN deletes it: deletedAt stamped, uninstalledAt kept', async () => {
    expect(await M.deleteApp({}, { ref: app.id }, ctx(admin.id))).toBe(true);
    const r = await row();
    expect(r.deletedAt).toBeInstanceOf(Date);
    expect(r.uninstalledAt).toBeInstanceOf(Date);
  });

  it('an org OWNER and a platform admin succeed too', async () => {
    expect(await M.deleteApp({}, { ref: app.id }, ctx(orgOwner.id))).toBe(true);
    const other = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Du2', urn: `${org.urn}:du2` }, select: { id: true } });
    await M.uninstallApp({}, { ref: other.id }, ctx(admin.id));
    expect(await M.deleteApp({}, { ref: other.id }, ctx(platformAdmin.id, ['ADMIN']))).toBe(true);
    expect((await row(other.id)).deletedAt).not.toBeNull();
  });

  it('a user-owned uninstalled App is deleted by its owner only', async () => {
    const owner = await mkUser('uo');
    const mine = await db.app.create({ data: { id: generateId(), ownerUserId: owner.id, name: 'Mine', urn: `hrn:app:du-${generateId().toLowerCase()}.example:mine` }, select: { id: true } });
    expect(await M.uninstallApp({}, { ref: mine.id }, ctx(owner.id))).toBe(true);
    await code(M.deleteApp({}, { ref: mine.id }, ctx(stranger.id)));
    expect((await row(mine.id)).deletedAt).toBeNull();
    expect(await M.deleteApp({}, { ref: mine.id }, ctx(owner.id))).toBe(true);
    expect((await row(mine.id)).deletedAt).not.toBeNull();
  });

  it('the gate is unchanged: nobody else is admitted and nothing is deleted (refusal text is #3975, not pinned here)', async () => {
    for (const who of [orgMember.id, otherAdmin.id, stranger.id, undefined]) {
      await code(M.deleteApp({}, { ref: app.id }, ctx(who)));
      expect((await row()).deletedAt).toBeNull();
    }
  });

  it('an already deleted uninstalled App is still refused (no second delete)', async () => {
    await M.deleteApp({}, { ref: app.id }, ctx(admin.id));
    const first = (await row()).deletedAt;
    await code(M.deleteApp({}, { ref: app.id }, ctx(admin.id)));
    expect((await row()).deletedAt).toEqual(first);
  });

  it('the result is final: reinstall of the deleted-while-uninstalled App is refused, and it stays uninstalled', async () => {
    await M.deleteApp({}, { ref: app.id }, ctx(admin.id));
    await code(M.reinstallApp({}, { ref: app.id }, ctx(admin.id)));
    expect((await row()).uninstalledAt).not.toBeNull();
  });

  it('every other write through an uninstalled App stays refused APP_UNINSTALLED (the liveness check is not weakened)', async () => {
    const agentId = (await M.createAgent({}, { orgId: org.id, name: 'Du Agent' }, ctx(admin.id))).id;
    expect((await code(M.installAgentIntoApp({}, { appRef: app.id, agentRef: agentId }, ctx(admin.id)))).code).toBe('APP_UNINSTALLED');
  });

  it('by URN it never reaches the uninstalled App behind a reused handle: the new installed holder is the one named, and the uninstalled row is untouched when none holds it', async () => {
    // No installed holder: the URN names nothing, the uninstalled row is not reached.
    await code(M.deleteApp({}, { ref: app.urn }, ctx(admin.id)));
    expect((await row()).deletedAt).toBeNull();
    // A new installed App takes the handle: delete-by-URN deletes THAT one, never the uninstalled one.
    const holder = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Holder', urn: app.urn }, select: { id: true } });
    expect(await M.deleteApp({}, { ref: app.urn }, ctx(admin.id))).toBe(true);
    expect((await row(holder.id)).deletedAt).not.toBeNull();
    expect((await row()).deletedAt).toBeNull();
  });

  it('the gate is re-checked after the lock: an admin revoked after the outer gate is refused and nothing is deleted', async () => {
    const racer = await mkUser('race');
    await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: racer.id, role: 'ADMIN' } });
    let fired = false;
    const racing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'orgMember') {
          return new Proxy(target.orgMember, {
            get(t, p) {
              if (p === 'findFirst') {
                return async (...a: unknown[]) => {
                  const r = await (t as any).findFirst(...a);
                  if (!fired) { fired = true; await db.orgMember.updateMany({ where: { userId: racer.id }, data: { deletedAt: new Date() } }); }
                  return r;
                };
              }
              const v = Reflect.get(t, p); return typeof v === 'function' ? v.bind(t) : v;
            },
          });
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as Context['db'];
    await code(M.deleteApp({}, { ref: app.id }, { db: racing, userId: racer.id, roles: ['READER'] }));
    expect((await row()).deletedAt).toBeNull();
  });

  it('an installed App still deletes as before (control)', async () => {
    await M.reinstallApp({}, { ref: app.id }, ctx(admin.id));
    expect(await M.deleteApp({}, { ref: app.id }, ctx(admin.id))).toBe(true);
    expect((await row()).deletedAt).not.toBeNull();
  });
});
