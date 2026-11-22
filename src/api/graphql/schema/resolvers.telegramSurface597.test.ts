/**
 * #597 (Telegram phase 2) — the TelegramConnection GraphQL surface (cor:api:120 reads, cor:api:140 refs).
 *
 *   - createTelegramConnection: org ADMIN/OWNER of the APP's org (the org is derived from the App, never supplied);
 *     a plain member, a REVOKED member, another org's admin and an unknown App all get the one refusal and the tool is
 *     never called; the bot token is forwarded to the tool and stored nowhere in core or on any read surface;
 *     a second ACTIVE connection for the App is refused (before the tool is called, and by the partial unique under a
 *     race), a soft-deleted one does not block; a failed row write (the race) tears the tool row down.
 *   - deleteTelegramConnection: soft-delete + best-effort tool teardown; an outsider or revoked member gets NOT_FOUND.
 *   - telegramConnection(ref) / telegramConnections: member-scoped reads, null/empty for outsiders.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { createTelegramToolConnection, deleteTelegramToolConnection } from '../../../lib/telegramClient.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../lib/telegramClient.js', () => ({
  createTelegramToolConnection: vi.fn(),
  deleteTelegramToolConnection: vi.fn().mockResolvedValue(undefined),
  runTelegramOperation: vi.fn().mockResolvedValue({ ok: true }),
}));

const BOT_TOKEN = '123456:SECRET-bot-token';

let org: { id: string };
let app: { id: string };
let admin: { id: string };
let owner: { id: string };
let member: { id: string };
let revoked: { id: string };
let foreignAdmin: { id: string };

const identity = (overrides: Record<string, unknown> = {}) => ({
  id: 'tool-conn-1',
  provider: 'telegram',
  botId: '99',
  botUsername: 'IrisBot',
  displayName: 'Iris',
  status: 'ACTIVE',
  ...overrides,
});

const ctxFor = (userId: string): Context => ({ db, roles: ['READER'], userId }) as Context;

async function createUser(name: string, orgId: string | null, role: 'OWNER' | 'ADMIN' | 'READER' = 'READER', deletedAt?: Date) {
  const user = await db.user.create({ data: { id: generateId(), email: `${name}@tg.test`, name } });
  if (orgId) await db.orgMember.create({ data: { id: generateId(), organizationId: orgId, userId: user.id, role, deletedAt: deletedAt ?? null } });
  return user;
}

beforeEach(async () => {
  await cleanDb(db);
  vi.mocked(createTelegramToolConnection).mockReset();
  vi.mocked(createTelegramToolConnection).mockResolvedValue(identity());
  vi.mocked(deleteTelegramToolConnection).mockClear();
  org = await db.organization.create({ data: { id: generateId(), name: 'tg-org', urn: 'tg-org' } });
  app = await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'tg-app', urn: 'tg-org::tg-app' } });
  admin = await createUser('admin', org.id, 'ADMIN');
  owner = await createUser('owner', org.id, 'OWNER');
  member = await createUser('member', org.id, 'READER');
  revoked = await createUser('revoked', org.id, 'ADMIN', new Date());
  const other = await db.organization.create({ data: { id: generateId(), name: 'other', urn: 'other-org' } });
  foreignAdmin = await createUser('foreign', other.id, 'ADMIN');
});

const create = (ctx?: Context, appRef = app.id) =>
  resolvers.Mutation.createTelegramConnection({}, { appRef, botToken: BOT_TOKEN }, ctx ?? ctxFor(admin.id));

describe('createTelegramConnection', () => {
  it('as org admin: the row exists with the tool identity, the token went to the tool and is stored nowhere', async () => {
    const connection = await create();
    expect(connection).toMatchObject({
      organizationId: org.id,
      appId: app.id,
      provider: 'telegram',
      toolConnectionId: 'tool-conn-1',
      botId: '99',
      botUsername: 'IrisBot',
      displayName: 'Iris',
      status: 'ACTIVE',
      createdBy: admin.id,
    });
    expect(createTelegramToolConnection).toHaveBeenCalledWith('telegram', { botToken: BOT_TOKEN });
    const raw = await db.telegramConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(JSON.stringify(raw)).not.toContain('SECRET-bot-token');
    // No read surface can return it: the SDL type has no token-shaped field.
    const block = /type TelegramConnection \{[^}]*\}/.exec(typeDefs)?.[0] ?? '';
    expect(block).not.toBe('');
    expect(block.toLowerCase()).not.toContain('token');
  });

  it('an org OWNER may create too', async () => {
    expect((await create(ctxFor(owner.id))).appId).toBe(app.id);
  });

  it('a plain member, a revoked member, another org\'s admin and an unknown App get the SAME refusal, and the tool is never called', async () => {
    const messages: string[] = [];
    for (const attempt of [
      () => create(ctxFor(member.id)),
      () => create(ctxFor(revoked.id)),
      () => create(ctxFor(foreignAdmin.id)),
      () => create(ctxFor(admin.id), generateId()),
      () => create(ctxFor(foreignAdmin.id), generateId()),
    ]) {
      const err = await attempt().then(
        () => null,
        (e: Error & { extensions?: Record<string, unknown> }) => e,
      );
      expect(err).not.toBeNull();
      messages.push(`${err!.message}|${String(err!.extensions?.code)}`);
    }
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toContain('Forbidden');
    expect(createTelegramToolConnection).not.toHaveBeenCalled();
    expect(await db.telegramConnection.count()).toBe(0);
  });

  it('a user-owned App (no org) is refused the same way', async () => {
    const owner2 = await createUser('solo', null);
    const solo = await db.app.create({
      data: { id: generateId(), organizationId: null, ownerUserId: owner2.id, name: 'solo-app', urn: 'solo::solo-app' },
    });
    await expect(create(ctxFor(owner2.id), solo.id)).rejects.toThrow('Forbidden');
    expect(createTelegramToolConnection).not.toHaveBeenCalled();
  });

  it('a second ACTIVE connection for the App is refused, before the tool is called', async () => {
    await create();
    vi.mocked(createTelegramToolConnection).mockClear();
    vi.mocked(createTelegramToolConnection).mockResolvedValue(identity({ id: 'tool-conn-2', botId: '100' }));
    await expect(create()).rejects.toThrow(/already has a Telegram connection/);
    expect(createTelegramToolConnection).not.toHaveBeenCalled();
    expect(await db.telegramConnection.count({ where: { deletedAt: null } })).toBe(1);
  });

  it('two creates that both pass the pre-check leave one row (the partial unique decides) and tear the loser\'s tool row down', async () => {
    // Hold the first create's tool call until the second has also reached the tool: both have then passed the
    // pre-check (no row yet), so only the partial unique index can refuse the second write.
    let secondReachedTool!: () => void;
    const gate = new Promise<void>((resolve) => (secondReachedTool = resolve));
    vi.mocked(createTelegramToolConnection)
      .mockImplementationOnce(async () => {
        await gate;
        return identity({ id: 'tool-a' });
      })
      .mockImplementationOnce(async () => {
        secondReachedTool();
        return identity({ id: 'tool-b', botId: '100' });
      });
    const results = await Promise.allSettled([create(), create()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(loser.reason.message)).toMatch(/already has a Telegram connection/);
    expect(await db.telegramConnection.count({ where: { deletedAt: null } })).toBe(1);
    const kept = (await db.telegramConnection.findFirstOrThrow({ where: { deletedAt: null } })).toolConnectionId;
    const lost = kept === 'tool-a' ? 'tool-b' : 'tool-a';
    expect(deleteTelegramToolConnection).toHaveBeenCalledWith('telegram', lost);
    expect(deleteTelegramToolConnection).not.toHaveBeenCalledWith('telegram', kept);
  });

  it('a soft-deleted connection does not block a new one', async () => {
    const first = await create();
    await resolvers.Mutation.deleteTelegramConnection({}, { ref: first.id }, ctxFor(admin.id));
    vi.mocked(createTelegramToolConnection).mockResolvedValue(identity({ id: 'tool-conn-3' }));
    expect((await create()).toolConnectionId).toBe('tool-conn-3');
  });

  it('a tool failure creates no row and leaves nothing to tear down', async () => {
    vi.mocked(createTelegramToolConnection).mockRejectedValue(new Error('tool down'));
    await expect(create()).rejects.toThrow('tool down');
    expect(await db.telegramConnection.count()).toBe(0);
    expect(deleteTelegramToolConnection).not.toHaveBeenCalled();
  });
});

describe('deleteTelegramConnection', () => {
  it('soft-deletes and tears down the tool side (org admin only)', async () => {
    const connection = await create();
    await expect(resolvers.Mutation.deleteTelegramConnection({}, { ref: connection.id }, ctxFor(member.id))).rejects.toThrow('Forbidden');
    expect(await resolvers.Mutation.deleteTelegramConnection({}, { ref: connection.id }, ctxFor(admin.id))).toBe(true);
    const row = await db.telegramConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(row.deletedAt).not.toBeNull();
    expect(row.deletedBy).toBe(admin.id);
    expect(deleteTelegramToolConnection).toHaveBeenCalledWith('telegram', 'tool-conn-1');
  });

  it('two concurrent deletes tear the tool side down once (the soft-delete is guarded on the live row)', async () => {
    const connection = await create();
    const results = await Promise.all([
      resolvers.Mutation.deleteTelegramConnection({}, { ref: connection.id }, ctxFor(admin.id)),
      resolvers.Mutation.deleteTelegramConnection({}, { ref: connection.id }, ctxFor(owner.id)),
    ].map((p) => p.then((v: boolean) => v, (e: Error) => e.message)));
    expect(results.filter((r) => r === true).length).toBeGreaterThanOrEqual(1);
    expect(deleteTelegramToolConnection).toHaveBeenCalledTimes(1);
  });

  it('an outsider, a revoked member, another org\'s admin and a missing id all get NOT_FOUND, byte-identical', async () => {
    const connection = await create();
    const seen = new Set<string>();
    for (const [ctx, ref] of [
      [ctxFor(foreignAdmin.id), connection.id],
      [ctxFor(revoked.id), connection.id],
      [ctxFor(admin.id), 'nope'],
    ] as const) {
      const err = await resolvers.Mutation.deleteTelegramConnection({}, { ref }, ctx).then(
        () => null,
        (e: Error & { extensions?: Record<string, unknown> }) => e,
      );
      seen.add(`${err?.message}|${String(err?.extensions?.code)}`);
    }
    expect([...seen]).toEqual(['Telegram connection not found.|NOT_FOUND']);
    expect(deleteTelegramToolConnection).not.toHaveBeenCalled();
  });
});

describe('telegramConnection(ref) and telegramConnections', () => {
  it('returns the row to an org member and null to an outsider or a revoked member', async () => {
    const connection = await create();
    expect((await resolvers.Query.telegramConnection({}, { ref: connection.id }, ctxFor(member.id)))?.id).toBe(connection.id);
    expect(await resolvers.Query.telegramConnection({}, { ref: connection.id }, ctxFor(foreignAdmin.id))).toBeNull();
    expect(await resolvers.Query.telegramConnection({}, { ref: connection.id }, ctxFor(revoked.id))).toBeNull();
    expect(await resolvers.Query.telegramConnection({}, { ref: 'nope' }, ctxFor(member.id))).toBeNull();
  });

  it('pages the member-scoped set; orgId narrows; an outsider gets an empty page; limit 0 counts', async () => {
    const connection = await create();
    const page = await resolvers.Query.telegramConnections({}, {}, ctxFor(member.id));
    expect(page.total).toBe(1);
    expect(page.items[0]!.id).toBe(connection.id);
    expect(await resolvers.Query.telegramConnections({}, { orgId: org.id }, ctxFor(foreignAdmin.id))).toEqual({ items: [], total: 0 });
    expect(await resolvers.Query.telegramConnections({}, { limit: 0 }, ctxFor(member.id))).toEqual({ items: [], total: 1 });
    expect((await resolvers.Query.telegramConnections({}, { offset: -5 }, ctxFor(member.id))).items).toHaveLength(1);
  });
});
