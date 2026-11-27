/**
 * hadron-internal#90 (Holger, 2026-11-27, decisions:2026-11-27-holger-rulings-to-victor-chat-memory-public-links): an organisation or
 * platform admin may switch a public link OFF on a file in a user's chat holding, never ON; the public hotlink is unchanged. The holding is
 * seeded through the product's own write path (a real startChat by an Agent manager with no installed App); the platform admins are real
 * user rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { generateId } from '../../../lib/id.js';
import { cleanDb, chatNodeByLocOrThrow } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { runAuthContext } from '../../../lib/auth/runPrincipal.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const FILENAME = 'secret-chat-file-90.pdf';
let orgId: string, otherOrgId: string, agentId: string, appId: string, holdingId: string, plainId: string;
const u: Record<string, string> = {};
const ROLES: Record<string, string[]> = { platformadmin: ['ADMIN'], platformowner: ['OWNER'] };
const as = (who: string): Context => ({ db, userId: u[who], roles: ROLES[who] ?? ['READER'] }) as Context;

async function user(handle: string, orgRole?: 'READER' | 'CONTRIBUTOR' | 'ADMIN' | 'OWNER', org = orgId) {
  const id = (await db.user.create({ data: { handle, roles: (ROLES[handle] ?? ['READER']) as never } })).id;
  u[handle] = id;
  if (orgRole) await db.orgMember.create({ data: { organizationId: org, userId: id, role: orgRole } });
}
async function assetOn(memoryId: string, enabled: boolean) {
  const id = generateId();
  await db.asset.create({ data: { id, memoryId, filename: FILENAME, mimeType: 'application/pdf', sizeBytes: 4242, storageKey: `k-${id}`, scanStatus: 'CLEAN', publicLinkEnabled: enabled, description: 'private description 90', uploadedBy: u.creator } });
  return id;
}
const flag = async (id: string) => (await db.asset.findUniqueOrThrow({ where: { id } })).publicLinkEnabled;
const audits = (id: string) => db.assetPublicLinkAudit.findMany({ where: { assetId: id } });
const attempt = async (p: Promise<unknown>) => { try { return { ok: await p }; } catch (e: any) { return { code: e?.extensions?.code ?? e?.code ?? 'error', message: String(e?.message ?? '') }; } };
const sw = (c: Context, asset: string, enabled: boolean) => attempt(M.setAssetPublicLink({}, { assetRef: asset, enabled }, c));

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { name: 'Link org', urn: 'link90.test' } })).id;
  otherOrgId = (await db.organization.create({ data: { name: 'Other link org', urn: 'linkother90.test' } })).id;
  await user('creator', 'ADMIN');
  await user('orgadmin', 'ADMIN');
  await user('orgowner', 'OWNER');
  await user('member', 'READER');
  await user('contributor', 'CONTRIBUTOR');
  await user('foreigner', 'ADMIN', otherOrgId);
  await user('outsider');
  await user('platformadmin');
  await user('platformowner');
  const agent = await M.createAgent({}, { orgRef: orgId, name: 'Link90 agent', visibility: 'ORGANIZATION' }, as('creator'));
  agentId = agent.id;
  for (const row of [
    { loc: 'conversations', data: {} },
    { loc: 'conversations:flow', data: { stageOrder: ['step'], isSetup: false } },
    { loc: 'conversations:flow:step', data: { promptRef: 'prompts:step' } },
    { loc: 'prompts', data: {} },
    { loc: 'prompts:step', content: 'STAGE', data: {} },
  ]) await db.node.create({ data: { memoryId: agent.systemMemoryId, name: row.loc, nodeType: 'system', ...row } });
  await serveEveryAgent(db);
  const started = await M.startChat({}, { agentRef: agentId, scope: 'private', conversationName: 'flow' }, as('creator'));
  holdingId = (await chatNodeByLocOrThrow(db, started.chatId)).memoryId;
  expect(await db.memory.findUniqueOrThrow({ where: { id: holdingId } })).toMatchObject({ class: 'knowledge', ownerUserId: null, appId: null, userMemoryOfAgentId: agentId, createdBy: u.creator });
  plainId = (await db.memory.create({ data: { id: generateId(), name: 'Plain90', urn: 'link90.test:plain', organizationId: orgId, class: 'knowledge', visibility: 'ORGANIZATION', createdBy: u.creator } })).id;
  appId = (await db.app.create({ data: { name: 'Link app', urn: 'link90.test:app', organizationId: orgId } })).id;
});

const ADMINS = ['orgadmin', 'orgowner', 'platformadmin', 'platformowner'] as const;

describe('an admin may switch a holding\'s public link OFF, never ON (hadron-internal#90)', () => {
  for (const who of ADMINS) {
    it(`${who}: switches a live link off (the flag the public hotlink reads is false) and one audit row records the admin`, async () => {
      const asset = await assetOn(holdingId, true);
      const out = await sw(as(who), asset, false);
      expect('ok' in out, JSON.stringify(out)).toBe(true);
      expect(await flag(asset)).toBe(false);
      const rows = await audits(asset);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorUserId: u[who], enabled: false, previouslyEnabled: true, memoryId: holdingId });
    });
    it(`${who}: the off result names nothing (no filename, type, size, description, uploader or memory name)`, async () => {
      const asset = await assetOn(holdingId, true);
      const out = (await sw(as(who), asset, false)) as { ok: Record<string, unknown> };
      expect(out.ok).toMatchObject({ id: asset, filename: '', mimeType: 'application/octet-stream', sizeBytes: 0, description: null, uploadedBy: null, publicLinkEnabled: false });
      const text = JSON.stringify(out);
      for (const secret of [FILENAME, 'private description 90', 'application/pdf', 'Link90', 'link90.test', u.creator]) expect(text, secret).not.toContain(secret);
    });
    it(`${who}: an off on an already-off link is allowed and still writes its row`, async () => {
      const asset = await assetOn(holdingId, false);
      expect('ok' in (await sw(as(who), asset, false))).toBe(true);
      const rows = await audits(asset);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actorUserId: u[who], enabled: false, previouslyEnabled: false });
    });
    it(`${who}: switching ON is refused exactly as for a missing asset and changes nothing`, async () => {
      const asset = await assetOn(holdingId, false);
      const refused = await sw(as(who), asset, true);
      expect(refused).not.toHaveProperty('ok');
      expect(refused).toEqual(await sw(as(who), generateId(), true));
      expect(await flag(asset)).toBe(false);
      expect(await audits(asset)).toHaveLength(0);
      // ON also stays refused when the link is already on (the revoke path must not double as a toggle).
      const live = await assetOn(holdingId, true);
      expect(await sw(as(who), live, true)).not.toHaveProperty('ok');
      expect(await flag(live)).toBe(true);
    });
  }

  it('the creator switches on and off as before, with the ordinary result', async () => {
    const asset = await assetOn(holdingId, false);
    const on = (await sw(as('creator'), asset, true)) as { ok: Record<string, unknown> };
    expect(on.ok).toMatchObject({ publicLinkEnabled: true, filename: FILENAME });
    const off = (await sw(as('creator'), asset, false)) as { ok: Record<string, unknown> };
    expect(off.ok).toMatchObject({ publicLinkEnabled: false, filename: FILENAME });
    expect((await audits(asset)).map((r) => r.enabled)).toEqual([true, false]);
  });

  it('a non-admin non-creator (member, contributor, another org\'s admin, an outsider) is refused both ways', async () => {
    for (const who of ['member', 'contributor', 'foreigner', 'outsider'] as const) {
      const live = await assetOn(holdingId, true);
      const off = await sw(as(who), live, false);
      expect(off, `${who} off`).not.toHaveProperty('ok');
      expect(off, `${who} off`).toEqual(await sw(as(who), generateId(), false));
      expect(await flag(live), `${who} off`).toBe(true);
      const dead = await assetOn(holdingId, false);
      expect(await sw(as(who), dead, true), `${who} on`).not.toHaveProperty('ok');
      expect(await flag(dead), `${who} on`).toBe(false);
    }
  });

  it('an impersonated session, a run principal and an App key are refused both ways, even when they carry an admin\'s id', async () => {
    const impersonated = { db, userId: u.orgadmin, roles: [], impersonation: { orgId } } as unknown as Context;
    const run = { db, ...runAuthContext({ id: generateId(), appId, userId: u.orgadmin, organizationId: orgId }) } as unknown as Context;
    const appKey = { db, appId, organizationId: orgId, roles: [] } as unknown as Context;
    for (const [label, c] of [['impersonated', impersonated], ['run', run], ['appKey', appKey]] as const) {
      const live = await assetOn(holdingId, true);
      expect(await sw(c, live, false), `${label} off`).not.toHaveProperty('ok');
      expect(await flag(live), `${label} off`).toBe(true);
      const dead = await assetOn(holdingId, false);
      expect(await sw(c, dead, true), `${label} on`).not.toHaveProperty('ok');
      expect(await flag(dead), `${label} on`).toBe(false);
    }
  });

  it('an ordinary memory is untouched: its admins switch on and off with the full result, a member cannot', async () => {
    for (const who of ['orgadmin', 'platformadmin'] as const) {
      const asset = await assetOn(plainId, false);
      const on = (await sw(as(who), asset, true)) as { ok: Record<string, unknown> };
      expect(on.ok, who).toMatchObject({ publicLinkEnabled: true, filename: FILENAME });
      const off = (await sw(as(who), asset, false)) as { ok: Record<string, unknown> };
      expect(off.ok, who).toMatchObject({ publicLinkEnabled: false, filename: FILENAME });
    }
    expect(await sw(as('member'), await assetOn(plainId, true), false)).not.toHaveProperty('ok');
  });

  it('the asset publicUrl field answers null after an admin\'s off (nothing is served), and canManagePublicLink stays false for the admin', async () => {
    const asset = await assetOn(holdingId, true);
    await sw(as('orgadmin'), asset, false);
    const row = await db.asset.findUniqueOrThrow({ where: { id: asset } });
    const fields = (resolvers as any).Asset;
    expect(await fields.publicUrl(row, {}, as('orgadmin'))).toBeNull();
    expect(await fields.canManagePublicLink(row, {}, as('orgadmin'))).toBe(false);
  });
});
