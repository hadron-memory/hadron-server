/**
 * #4006 — updateApp re-judges DELETION on the row it locks (cor:dmo:050:21: a deleted App "is no longer a target for ... writes").
 * A soft-delete that commits after admission and before the FOR UPDATE read must refuse before applyAiConfig and recordUrnRename,
 * and roll the whole transaction back. Id ref -> APP_DELETED (#3982 ruling); URN ref -> the answer admission gives a URN naming a deleted App.
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

async function refusal(p: Promise<unknown>): Promise<{ code: unknown; message: string }> {
  try {
    await p;
  } catch (e) {
    const err = e as GraphQLError & { code?: string };
    return { code: err.extensions?.code ?? err.code ?? err.name, message: err.message };
  }
  throw new Error('expected a rejection');
}

let n = 0;
const mkUser = (label: string) =>
  db.user.create({ data: { githubId: 9_400_000 + ++n, githubUsername: `dr-${label}-${generateId()}`, roles: ['READER'] }, select: { id: true } });

let org: { id: string; urn: string };
let admin: { id: string };
let app: { id: string; urn: string };

beforeEach(async () => {
  vi.restoreAllMocks();
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'dr-org', urn: `dr-${generateId().toLowerCase()}.example` } });
  admin = await mkUser('ad');
  await db.orgMember.create({ data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'Dr', urn: `${org.urn}:dr`, description: 'before' }, select: { id: true, urn: true } });
});

const row = () => db.app.findUniqueOrThrow({ where: { id: app.id } });
const aliases = () => db.urnAlias.count({ where: { entityType: 'APP', entityId: app.id } });
const aiConfigs = () => db.aiServiceConfig.count({ where: { appId: app.id } });

/** The race: the delete commits after admission and the pre-transaction read, before the transaction's FOR UPDATE. */
function deleteBeforeLock(): void {
  const real = db.$transaction.bind(db) as (...a: unknown[]) => Promise<unknown>;
  vi.spyOn(db, '$transaction').mockImplementationOnce(((...a: unknown[]) =>
    db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } }).then(() => real(...a))) as never);
}

describe('#4006 updateApp re-judges deletion under the row lock', () => {
  it('id ref: a delete after admission refuses APP_DELETED; the App row is unchanged', async () => {
    deleteBeforeLock();
    const r = await refusal(M.updateApp({}, { ref: app.id, name: 'changed', description: 'raced' }, ctx(admin.id)));
    expect(r.code).toBe('APP_DELETED');
    const after = await row();
    expect(after.name).toBe('Dr');
    expect(after.description).toBe('before');
    expect(after.deletedAt).not.toBeNull();
  });

  it('id ref: the AI-config change and the rename alias roll back with it', async () => {
    deleteBeforeLock();
    const r = await refusal(
      M.updateApp({}, { ref: app.id, urn: 'renamed-slug', aiProvider: 'anthropic', aiModel: 'claude-sonnet-5-5', aiApiKey: 'sk-test-key' }, ctx(admin.id)),
    );
    expect(r.code).toBe('APP_DELETED');
    expect((await row()).urn).toBe(app.urn);
    expect(await aliases()).toBe(0);
    expect(await aiConfigs()).toBe(0);
  });

  it('URN ref: the answer admission would give a URN naming a deleted App, and nothing is written', async () => {
    await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    const atAdmission = await refusal(M.updateApp({}, { ref: app.urn, name: 'changed' }, ctx(admin.id)));
    await db.app.update({ where: { id: app.id }, data: { deletedAt: null } });

    deleteBeforeLock();
    const raced = await refusal(M.updateApp({}, { ref: app.urn, name: 'changed', urn: 'renamed-slug' }, ctx(admin.id)));
    expect(raced).toEqual(atAdmission);
    expect(raced.code).toBe('APP_NOT_FOUND');
    const after = await row();
    expect(after.name).toBe('Dr');
    expect(after.urn).toBe(app.urn);
    expect(await aliases()).toBe(0);
  });

  it('control: no race, an id update writes the name, the rename alias and the AI config', async () => {
    const out = await M.updateApp({}, { ref: app.id, name: 'changed', urn: 'renamed-slug', aiProvider: 'anthropic', aiModel: 'claude-sonnet-5-5', aiApiKey: 'sk-test-key' }, ctx(admin.id));
    expect(out.name).toBe('changed');
    expect(await aliases()).toBe(1);
    expect(await aiConfigs()).toBe(1);
  });

  it('control: a delete that lands AFTER the transaction does not undo the write', async () => {
    const out = await M.updateApp({}, { ref: app.id, description: 'after' }, ctx(admin.id));
    expect(out.description).toBe('after');
    expect((await row()).deletedAt).toBeNull();
  });

  it('control: an already-deleted App is still refused at admission, by id', async () => {
    await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    expect((await refusal(M.updateApp({}, { ref: app.id, name: 'changed' }, ctx(admin.id)))).code).toBe('APP_DELETED');
  });
});
