/**
 * #1667 — hadron_set_asset_public_link: PARITY with GraphQL setAssetPublicLink. Both call the one core
 * (src/lib/asset/publicLink.ts), so the same principal meets the same refusal and the same audit on both.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import type { AuthContext } from '../middleware/auth.js';
import { createTestableMcpServer } from './server.js';

let org: { id: string; urn: string };
let admin: { id: string };
let writer: { id: string };
let memoryId: string;

const authOf = (userId: string) => ({ userId, roles: ['READER'], clientId: `user:${userId}`, organizationId: org.id }) as AuthContext;
const mcp = (userId: string) => createTestableMcpServer(authOf(userId), { sessionId: `apl-${generateId()}`, cachedAppResolution: { kind: 'multi-app' } });
const M = resolvers.Mutation as unknown as Record<string, (p: unknown, a: unknown, c: Context) => Promise<any>>;
const asset = async () => {
  const id = generateId();
  await db.asset.create({ data: { id, memoryId, filename: 'f.pdf', mimeType: 'application/pdf', sizeBytes: 1, storageKey: `k-${id}`, scanStatus: 'CLEAN' } });
  return id;
};

beforeEach(async () => {
  await cleanDb(db);
  process.env.ASSET_PUBLIC_HOTLINK_ENABLED = 'true';
  process.env.BASE_URL = 'https://hadron.example';
  org = await db.organization.create({ data: { id: generateId(), name: 'Apl', urn: `apl-${Date.now()}.example` } });
  admin = await db.user.create({ data: { githubId: 167001, githubUsername: 'apl-admin', handle: 'apl-admin', roles: [] } });
  writer = await db.user.create({ data: { githubId: 167002, githubUsername: 'apl-writer', handle: 'apl-writer', roles: [] } });
  await db.orgMember.createMany({ data: [
    { organizationId: org.id, userId: admin.id, role: 'ADMIN' },
    { organizationId: org.id, userId: writer.id, role: 'CONTRIBUTOR' },
  ] });
  memoryId = (await db.memory.create({ data: { id: generateId(), class: 'knowledge', organizationId: org.id, urn: `${org.urn}:k`, name: 'k', visibility: 'ORGANIZATION' } })).id;
});

describe('hadron_set_asset_public_link', () => {
  it('a manager switches it on and off, and the result never reads an empty URL as "off"', async () => {
    const id = await asset();
    const on = await mcp(admin.id).callToolText('hadron_set_asset_public_link', { asset: id, enabled: true });
    expect(on).toContain('public link ON');
    expect(on).toContain(`publicUrl: https://hadron.example/assets/${id}`);
    expect((await db.asset.findUniqueOrThrow({ where: { id } })).publicLinkEnabled).toBe(true);
    delete process.env.BASE_URL;
    const noOrigin = await mcp(admin.id).callToolText('hadron_set_asset_public_link', { asset: id, enabled: true });
    expect(noOrigin).toContain('public link ON');
    expect(noOrigin).toContain('publicUrl: (none)');
    expect(noOrigin).toContain('publicLinkAvailable: true');
    const off = await mcp(admin.id).callToolText('hadron_set_asset_public_link', { asset: id, enabled: false });
    expect(off).toContain('public link OFF');
    expect(await db.assetPublicLinkAudit.count({ where: { assetId: id } })).toBe(3);
  });

  it('an ordinary writer meets the same refusal as on GraphQL, and nothing changes', async () => {
    const id = await asset();
    const text = await mcp(writer.id).callToolText('hadron_set_asset_public_link', { asset: id, enabled: true });
    expect(text).toMatch(/^\[permission_denied\]/);
    await expect(M.setAssetPublicLink({}, { assetRef: id, enabled: true }, { db, userId: writer.id, roles: [] } as Context))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect((await db.asset.findUniqueOrThrow({ where: { id } })).publicLinkEnabled).toBe(false);
    expect(await db.assetPublicLinkAudit.count()).toBe(0);
  });
});
