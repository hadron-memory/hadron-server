/**
 * #396 — the email surface over the provider capability tool.
 *
 * What this file pins:
 *   - requireEmailConnection is OWNER-ONLY (decided 2026-07-08): the owning
 *     user passes; other org members (even ADMIN), platform admins, and
 *     App-key principals are denied for MAIL OPERATIONS. Management ops
 *     (exchangeConnections list, deleteExchangeConnection) keep org-ADMIN.
 *   - Mail ops route through emailClient with the TOOL's connection id and
 *     the row's provider (dispatch key), never core's row id.
 *   - A legacy row without toolConnectionId fails typed
 *     (EMAIL_CONNECTION_NOT_MIGRATED), not with a provider call.
 *   - deleteExchangeConnection tears down the tool side best-effort.
 *
 * The provider tool is mocked at the emailClient seam — these tests cover
 * core's gate + routing, not the tool (it has its own 53-test suite).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApolloServer } from '@apollo/server';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';

vi.mock('../../../lib/emailClient.js', () => ({
  runEmailOperation: vi.fn(async () => ({ messages: [] })),
  deleteToolConnection: vi.fn(async () => {}),
  createToolConnection: vi.fn(async () => ({})),
  subscribeToolFolder: vi.fn(async () => ({})),
}));

import { runEmailOperation, deleteToolConnection } from '../../../lib/emailClient.js';
import { typeDefs } from './typeDefs.js';
import { resolvers, type Context } from './resolvers.js';

const server = new ApolloServer<Context>({ typeDefs, resolvers });

async function run(query: string, ctx: Partial<Context>) {
  const res = await server.executeOperation({ query }, { contextValue: { db, ...ctx } as Context });
  if (res.body.kind !== 'single') throw new Error('unexpected');
  return res.body.singleResult;
}

let owner: { id: string };
let orgAdmin: { id: string };
let orgId: string;
let connectionId: string;

beforeEach(async () => {
  vi.clearAllMocks();
  await cleanDb(db);
  owner = await db.user.create({
    data: { id: generateId(), handle: 'mailowner', githubId: 9101, githubUsername: 'mailowner', name: 'Owner' },
  });
  orgAdmin = await db.user.create({
    data: { id: generateId(), handle: 'orgadmin', githubId: 9102, githubUsername: 'orgadmin', name: 'Admin' },
  });
  const org = await db.organization.create({
    data: { id: generateId(), name: 'Mail Org', urn: 'mailorg.test', createdBy: owner.id },
  });
  orgId = org.id;
  await db.orgMember.createMany({
    data: [
      { organizationId: orgId, userId: owner.id, role: 'CONTRIBUTOR' },
      { organizationId: orgId, userId: orgAdmin.id, role: 'ADMIN' },
    ],
  });
  const connection = await db.exchangeConnection.create({
    data: {
      organizationId: orgId,
      userId: owner.id,
      mailboxEmail: 'owner@example.com',
      toolConnectionId: 'tool-conn-1',
      createdBy: owner.id,
    },
  });
  connectionId = connection.id;
});

const MESSAGES_QUERY = (id: string) => `query { exchangeMessages(connectionId: "${id}") { id subject } }`;

describe('owner-only mail-operation gate (#396)', () => {
  it('lets the owning user list messages through the tool', async () => {
    vi.mocked(runEmailOperation).mockResolvedValueOnce({
      messages: [
        {
          id: 'm-1',
          conversationId: 'c-1',
          subject: 'Hello',
          from: { name: null, address: 'a@b.c' },
          to: [],
          receivedAt: '2026-07-08T00:00:00Z',
          isRead: false,
          snippet: 'Hello…',
          body: { contentType: 'html', content: '<p>Hello</p>' },
          hasAttachments: false,
        },
      ],
    });
    const r = await run(MESSAGES_QUERY(connectionId), { userId: owner.id, roles: ['READER'] });
    expect(r.errors).toBeUndefined();
    expect(r.data?.exchangeMessages).toEqual([{ id: 'm-1', subject: 'Hello' }]);
    // Routed with the TOOL's connection id + the row's provider.
    expect(vi.mocked(runEmailOperation)).toHaveBeenCalledWith(
      'ms-exchange',
      'list-messages',
      expect.objectContaining({ connectionId: 'tool-conn-1' }),
    );
  });

  it('denies another org member — even an org ADMIN', async () => {
    const r = await run(MESSAGES_QUERY(connectionId), { userId: orgAdmin.id, roles: ['READER'] });
    expect(r.errors?.[0]?.message).toBe('Forbidden');
    expect(vi.mocked(runEmailOperation)).not.toHaveBeenCalled();
  });

  it('denies a platform ADMIN who is not the owner (no admin bypass on mail ops)', async () => {
    const r = await run(MESSAGES_QUERY(connectionId), { userId: orgAdmin.id, roles: ['ADMIN'] });
    expect(r.errors?.[0]?.message).toBe('Forbidden');
  });

  it('denies an App-key principal (no userId)', async () => {
    const r = await run(MESSAGES_QUERY(connectionId), { appId: 'app-1', roles: [] });
    expect(r.errors?.[0]?.message).toBe('Forbidden');
  });

  it('reports a soft-deleted connection as not found', async () => {
    await db.exchangeConnection.update({ where: { id: connectionId }, data: { deletedAt: new Date() } });
    const r = await run(MESSAGES_QUERY(connectionId), { userId: owner.id, roles: ['READER'] });
    expect(r.errors?.[0]?.message).toBe('Connection not found');
  });

  it('fails typed on a legacy row that has no tool connection yet', async () => {
    await db.exchangeConnection.update({ where: { id: connectionId }, data: { toolConnectionId: null } });
    const r = await run(MESSAGES_QUERY(connectionId), { userId: owner.id, roles: ['READER'] });
    expect(r.errors?.[0]?.extensions?.code).toBe('EMAIL_CONNECTION_NOT_MIGRATED');
    expect(vi.mocked(runEmailOperation)).not.toHaveBeenCalled();
  });

  it('rejects raw provider filters with a typed error, translating only unread-only', async () => {
    const raw = await run(
      `query { exchangeMessages(connectionId: "${connectionId}", filter: "from/emailAddress eq 'x'") { id } }`,
      { userId: owner.id, roles: ['READER'] },
    );
    expect(raw.errors?.[0]?.extensions?.code).toBe('EMAIL_FILTER_UNSUPPORTED');

    await run(`query { exchangeMessages(connectionId: "${connectionId}", filter: "isRead eq false") { id } }`, {
      userId: owner.id,
      roles: ['READER'],
    });
    expect(vi.mocked(runEmailOperation)).toHaveBeenCalledWith(
      'ms-exchange',
      'list-messages',
      expect.objectContaining({ unreadOnly: true }),
    );
  });
});

describe('list-messages arg mapping', () => {
  it('supports the first-class unreadOnly arg and clamps top to the tool cap', async () => {
    await run(`query { exchangeMessages(connectionId: "${connectionId}", unreadOnly: true, top: 500) { id } }`, {
      userId: owner.id,
      roles: ['READER'],
    });
    expect(vi.mocked(runEmailOperation)).toHaveBeenCalledWith(
      'ms-exchange',
      'list-messages',
      expect.objectContaining({ unreadOnly: true, top: 100 }),
    );
  });
});

describe('spec 002 email mutations', () => {
  it('emailSaveDraft routes a reply-draft with the idempotency key', async () => {
    vi.mocked(runEmailOperation).mockResolvedValueOnce({ draftId: 'd-1', conversationId: 'c-1' });
    const r = await run(
      `mutation { emailSaveDraft(connectionRef: "${connectionId}", replyToMessageId: "m-1", bodyHtml: "<p>Tue 2pm</p>", idempotencyKey: "k-1") { draftId conversationId } }`,
      { userId: owner.id, roles: ['READER'] },
    );
    expect(r.errors).toBeUndefined();
    expect(r.data?.emailSaveDraft).toEqual({ draftId: 'd-1', conversationId: 'c-1' });
    expect(vi.mocked(runEmailOperation)).toHaveBeenCalledWith(
      'ms-exchange',
      'save-draft',
      expect.objectContaining({
        connectionId: 'tool-conn-1',
        replyToMessageId: 'm-1',
        idempotencyKey: 'k-1',
      }),
    );
  });

  it('emailFlagMessage maps the enum to the neutral vocabulary', async () => {
    vi.mocked(runEmailOperation).mockResolvedValueOnce({ flag: 'none' });
    const r = await run(
      `mutation { emailFlagMessage(connectionRef: "${connectionId}", messageId: "m-1", flag: NONE) }`,
      { userId: owner.id, roles: ['READER'] },
    );
    expect(r.errors).toBeUndefined();
    expect(vi.mocked(runEmailOperation)).toHaveBeenCalledWith(
      'ms-exchange',
      'flag-message',
      expect.objectContaining({ flag: 'none' }),
    );
  });

  it('email mutations enforce the owner-only gate too', async () => {
    const r = await run(
      `mutation { emailSendDraft(connectionRef: "${connectionId}", draftId: "d-1") }`,
      { userId: orgAdmin.id, roles: ['READER'] },
    );
    expect(r.errors?.[0]?.message).toBe('Forbidden');
    expect(vi.mocked(runEmailOperation)).not.toHaveBeenCalled();
  });
});

describe('connection management stays org-ADMIN', () => {
  it('org ADMIN lists connections; a plain member cannot', async () => {
    const admin = await run(`query { exchangeConnections(orgId: "${orgId}") { id provider mailboxEmail } }`, {
      userId: orgAdmin.id,
      roles: ['READER'],
    });
    expect(admin.errors).toBeUndefined();
    expect(admin.data?.exchangeConnections).toEqual([
      { id: connectionId, provider: 'ms-exchange', mailboxEmail: 'owner@example.com' },
    ]);

    const member = await run(`query { exchangeConnections(orgId: "${orgId}") { id } }`, {
      userId: owner.id, // CONTRIBUTOR, not org ADMIN
      roles: ['READER'],
    });
    expect(member.errors?.[0]?.message).toBe('Forbidden');
  });

  describe('deleteExchangeConnection uniform denial (#2593, cor:dmo:080:04)', () => {
    const DELETE = (id: string) => `mutation { deleteExchangeConnection(id: "${id}") }`;
    const denial = (r: Awaited<ReturnType<typeof run>>) => r.errors?.map((e) => [e.message, e.extensions?.code]);

    async function expectUntouched() {
      const row = await db.exchangeConnection.findUniqueOrThrow({ where: { id: connectionId } });
      expect(vi.mocked(deleteToolConnection)).not.toHaveBeenCalled();
      return row;
    }

    it('denies the connection owner who is not an org ADMIN: no write, no teardown', async () => {
      const r = await run(DELETE(connectionId), { userId: owner.id, roles: ['READER'] });
      expect(denial(r)).toEqual([['Forbidden', 'FORBIDDEN']]);
      expect((await expectUntouched()).deletedAt).toBeNull();
    });

    it('denies an App-key principal holding no org role', async () => {
      const r = await run(DELETE(connectionId), { appId: 'app-1', roles: [] });
      expect(denial(r)).toEqual([['Forbidden', 'FORBIDDEN']]);
      expect((await expectUntouched()).deletedAt).toBeNull();
    });

    it('answers an unknown id with the identical denial as a non-ADMIN', async () => {
      const unknown = await run(DELETE(generateId()), { userId: orgAdmin.id, roles: ['READER'] });
      const nonAdmin = await run(DELETE(connectionId), { userId: owner.id, roles: ['READER'] });
      expect(denial(unknown)).toEqual([['Forbidden', 'FORBIDDEN']]);
      expect(denial(unknown)).toEqual(denial(nonAdmin));
      expect(vi.mocked(deleteToolConnection)).not.toHaveBeenCalled();
    });

    it("answers another org's ADMIN with the same denial", async () => {
      const other = await db.user.create({
        data: { id: generateId(), handle: 'otheradmin', githubId: 9103, githubUsername: 'otheradmin', name: 'Other' },
      });
      const otherOrg = await db.organization.create({
        data: { id: generateId(), name: 'Other Org', urn: 'otherorg.test', createdBy: other.id },
      });
      await db.orgMember.create({ data: { organizationId: otherOrg.id, userId: other.id, role: 'ADMIN' } });
      const r = await run(DELETE(connectionId), { userId: other.id, roles: ['READER'] });
      expect(denial(r)).toEqual([['Forbidden', 'FORBIDDEN']]);
      expect((await expectUntouched()).deletedAt).toBeNull();
    });

    it('a repeat delete by an ADMIN is denied, leaves deletedAt unchanged and does not tear down again', async () => {
      const first = await run(DELETE(connectionId), { userId: orgAdmin.id, roles: ['READER'] });
      expect(first.errors).toBeUndefined();
      const stamped = await db.exchangeConnection.findUniqueOrThrow({ where: { id: connectionId } });
      expect(vi.mocked(deleteToolConnection)).toHaveBeenCalledTimes(1);

      const again = await run(DELETE(connectionId), { userId: orgAdmin.id, roles: ['READER'] });
      expect(denial(again)).toEqual([['Forbidden', 'FORBIDDEN']]);
      const after = await db.exchangeConnection.findUniqueOrThrow({ where: { id: connectionId } });
      expect(after.deletedAt).toEqual(stamped.deletedAt);
      expect(after.deletedBy).toBe(stamped.deletedBy);
      expect(vi.mocked(deleteToolConnection)).toHaveBeenCalledTimes(1);
    });

    it('two concurrent ADMIN deletes: exactly one succeeds and tears down once', async () => {
      const [a, b] = await Promise.all([
        run(DELETE(connectionId), { userId: orgAdmin.id, roles: ['READER'] }),
        run(DELETE(connectionId), { userId: orgAdmin.id, roles: ['READER'] }),
      ]);
      const okCount = [a, b].filter((r) => !r.errors).length;
      expect(okCount).toBe(1);
      expect(denial([a, b].find((r) => r.errors)!)).toEqual([['Forbidden', 'FORBIDDEN']]);
      expect(vi.mocked(deleteToolConnection)).toHaveBeenCalledTimes(1);
    });

    it('an infrastructure error stays an error, not a FORBIDDEN', async () => {
      const spy = vi.spyOn(db.exchangeConnection, 'findFirst').mockRejectedValueOnce(new Error('db down'));
      try {
        const r = await run(DELETE(connectionId), { userId: orgAdmin.id, roles: ['READER'] });
        expect(r.errors?.[0]?.extensions?.code).not.toBe('FORBIDDEN');
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('deleteExchangeConnection soft-deletes and tears down the tool side', async () => {
    const r = await run(`mutation { deleteExchangeConnection(id: "${connectionId}") }`, {
      userId: orgAdmin.id,
      roles: ['READER'],
    });
    expect(r.errors).toBeUndefined();
    const row = await db.exchangeConnection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(row.deletedAt).not.toBeNull();
    expect(vi.mocked(deleteToolConnection)).toHaveBeenCalledWith('ms-exchange', 'tool-conn-1');
  });
});
