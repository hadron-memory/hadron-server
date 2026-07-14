import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { decryptToken } from '../../../lib/tokenCrypto.js';
import { resolvers, type Context } from './resolvers.js';

let org: { id: string };
let admin: { id: string };
let member: { id: string };
let outsider: { id: string };

function ctxFor(userId: string): Context {
  return { db, roles: ['READER'], userId } as Context;
}

async function createUser(name: string, orgId: string | null, role: 'ADMIN' | 'READER' = 'READER') {
  const user = await db.user.create({ data: { id: generateId(), email: `${name}@resend.test`, name } });
  if (orgId) {
    await db.orgMember.create({
      data: { id: generateId(), organizationId: orgId, userId: user.id, role },
    });
  }
  return user;
}

beforeEach(async () => {
  await cleanDb(db);
  org = await db.organization.create({ data: { id: generateId(), name: 'resend-org', urn: 'resend-org' } });
  admin = await createUser('admin', org.id, 'ADMIN');
  member = await createUser('member', org.id);
  outsider = await createUser('outsider', null);
});

async function createSender(overrides: Record<string, unknown> = {}, ctx = ctxFor(admin.id)) {
  return resolvers.Mutation.createResendSender(
    {},
    {
      orgRef: org.id,
      from: 'Acme Agent <agent@acme.example>',
      apiKey: 're_org_secret',
      ...overrides,
    } as never,
    ctx,
  );
}

describe('ResendSender writes', () => {
  it('creates one org sender and encrypts its write-only API key', async () => {
    const sender = await createSender();
    expect(sender).toMatchObject({
      organizationId: org.id,
      fromAddress: 'Acme Agent <agent@acme.example>',
      enabled: true,
    });
    const raw = await db.resendSender.findUniqueOrThrow({ where: { id: sender.id } });
    expect(JSON.stringify(raw)).not.toContain('re_org_secret');
    expect(decryptToken(raw.apiKeyEncrypted)).toBe('re_org_secret');
    expect(resolvers.ResendSender.hasApiKey(raw)).toBe(true);
    expect(resolvers.ResendSender.from(raw)).toBe('Acme Agent <agent@acme.example>');
  });

  it('requires org ADMIN and permits only one sender per org', async () => {
    await expect(createSender({}, ctxFor(member.id))).rejects.toThrow('Forbidden');
    await createSender();
    await expect(createSender()).rejects.toThrow(/already has/);
  });

  it('rejects malformed sender identities and API keys before storage', async () => {
    await expect(createSender({ from: 'not-an-email' })).rejects.toThrow(/from/);
    await expect(createSender({ from: 'Bad\nHeader <agent@acme.example>' })).rejects.toThrow(/newlines/);
    await expect(createSender({ apiKey: 'has whitespace' })).rejects.toThrow(/apiKey/);
  });

  it('updates sender identity, rotates the key, and disables sending', async () => {
    const sender = await createSender();
    const updated = await resolvers.Mutation.updateResendSender(
      {},
      { ref: sender.id, from: 'Ops <ops@acme.example>', apiKey: 're_rotated', enabled: false },
      ctxFor(admin.id),
    );
    expect(updated).toMatchObject({ fromAddress: 'Ops <ops@acme.example>', enabled: false });
    expect(decryptToken(updated.apiKeyEncrypted)).toBe('re_rotated');
  });

  it('hard-deletes for an admin and hides existence from outsiders', async () => {
    const sender = await createSender();
    await expect(
      resolvers.Mutation.updateResendSender({}, { ref: sender.id, enabled: false }, ctxFor(outsider.id)),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    await expect(
      resolvers.Mutation.deleteResendSender({}, { ref: sender.id }, ctxFor(member.id)),
    ).rejects.toThrow('Forbidden');
    await expect(
      resolvers.Mutation.deleteResendSender({}, { ref: sender.id }, ctxFor(admin.id)),
    ).resolves.toBe(true);
    expect(await db.resendSender.findUnique({ where: { id: sender.id } })).toBeNull();
  });
});

describe('ResendSender sanitized reads', () => {
  it('find-one is visible to members, null to outsiders and for missing rows', async () => {
    const sender = await createSender();
    expect(await resolvers.Query.resendSender({}, { ref: sender.id }, ctxFor(member.id))).toMatchObject({
      id: sender.id,
    });
    expect(await resolvers.Query.resendSender({}, { ref: sender.id }, ctxFor(outsider.id))).toBeNull();
    expect(await resolvers.Query.resendSender({}, { ref: 'missing' }, ctxFor(member.id))).toBeNull();
  });

  it('lists only senders in the caller\'s member orgs', async () => {
    const sender = await createSender();
    const page = await resolvers.Query.resendSenders({}, {}, ctxFor(member.id));
    expect(page).toMatchObject({ total: 1 });
    expect(page.items[0].id).toBe(sender.id);
    await expect(resolvers.Query.resendSenders({}, { orgId: org.id }, ctxFor(outsider.id))).resolves.toEqual({
      items: [],
      total: 0,
    });
  });
});
