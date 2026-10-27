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

const server = new ApolloServer<Context>({ typeDefs, resolvers, includeStacktraceInErrorResponses: false });

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


describe('#2593 delete connection uniform denial', () => {
  const del = async (id: string, extra: Partial<Context> = {}) => {
    const result = await server.executeOperation({
      query: 'mutation Delete($id: ID!) { deleteExchangeConnection(id: $id) }', variables: { id },
    }, { contextValue: { db, userId: orgAdmin.id, roles: ['READER'], ...extra } as Context });
    if (result.body.kind !== 'single') throw new Error('unexpected');
    return result.body.singleResult;
  };
  it('missing, foreign-org, owner non-admin, revoked and delegated callers have identical wire refusals and no effects', async () => {
    const original = await db.exchangeConnection.findUniqueOrThrow({where: {id: connectionId}});
    const otherOrg = await db.organization.create({data: {name: 'Other', urn: 'other-mailorg.test'}});
    const foreign = await db.exchangeConnection.create({data: {organizationId: otherOrg.id, userId: owner.id, mailboxEmail: 'other@example.com', toolConnectionId: 'foreign-tool'}});
    const app = await db.app.create({data: {organizationId: orgId, name: 'Delegate', urn: 'mailorg.test:delegate'}});
    await db.connectionGrant.create({data: {connectionId, granteeAppId: app.id, grantedByUserId: owner.id, scopes: ['mail.read']}});
    // Prove the delegated principal really has operation authority, not just an arbitrary app id.
    const operation = await run(MESSAGES_QUERY(connectionId), {appId: app.id, roles: []});
    expect(operation.errors).toBeUndefined();
    vi.mocked(runEmailOperation).mockClear();
    const update = vi.spyOn(db.exchangeConnection, 'update');
    try {
      const missing = await del(generateId());
      expect(missing.errors?.[0]).toMatchObject({message: 'Forbidden', extensions: {code: 'FORBIDDEN'}});
      const wire = JSON.stringify(missing);
      expect(JSON.stringify(await del(foreign.id))).toBe(wire);
      expect(JSON.stringify(await del(connectionId, {userId: owner.id}))).toBe(wire);
      expect(JSON.stringify(await del(connectionId, {userId: undefined, appId: app.id, roles: []}))).toBe(wire);
      await db.orgMember.updateMany({where: {organizationId: orgId, userId: orgAdmin.id}, data: {deletedAt: new Date()}});
      expect(JSON.stringify(await del(connectionId))).toBe(wire);
      expect(update).not.toHaveBeenCalled();
      expect(deleteToolConnection).not.toHaveBeenCalled();
      expect(runEmailOperation).not.toHaveBeenCalled();
      expect(await db.exchangeConnection.findUniqueOrThrow({where: {id: connectionId}})).toEqual(original);
      expect((await db.exchangeConnection.findUniqueOrThrow({where: {id: foreign.id}})).deletedAt).toBeNull();
    } finally { update.mockRestore(); }
  });
  it('repeat delete by ADMIN is missing, preserves the original tombstone and never tears down twice', async () => {
    expect((await del(connectionId)).data?.deleteExchangeConnection).toBe(true);
    const tombstone = await db.exchangeConnection.findUniqueOrThrow({where: {id: connectionId}});
    expect(tombstone.deletedAt).not.toBeNull();
    expect(deleteToolConnection).toHaveBeenCalledTimes(1);
    vi.mocked(deleteToolConnection).mockClear();
    const missing = await del(generateId());
    expect(JSON.stringify(await del(connectionId))).toBe(JSON.stringify(missing));
    expect(await db.exchangeConnection.findUniqueOrThrow({where: {id: connectionId}})).toEqual(tombstone);
    expect(deleteToolConnection).not.toHaveBeenCalled();
  });
  it('simultaneous ADMIN deletes produce one success, one refusal and one teardown', async () => {
    const results = await Promise.all([del(connectionId), del(connectionId)]);
    expect(results.filter(r => r.data?.deleteExchangeConnection === true)).toHaveLength(1);
    const denial = results.find(r => r.errors);
    expect(denial?.errors?.[0]).toMatchObject({message: 'Forbidden', extensions: {code: 'FORBIDDEN'}});
    expect(deleteToolConnection).toHaveBeenCalledTimes(1);
  });
  it('database failures remain infrastructure errors rather than Forbidden', async () => {
    const failure = new Error('synthetic database outage');
    const broken = {exchangeConnection: {
      findUniqueOrThrow: async () => {throw failure;}, findFirst: async () => {throw failure;},
    }};
    await expect(resolvers.Mutation.deleteExchangeConnection(null, {id: connectionId}, {
      db: broken, userId: orgAdmin.id, roles: ['READER'],
    } as unknown as Context)).rejects.toBe(failure);
    expect(deleteToolConnection).not.toHaveBeenCalled();
  });
});
