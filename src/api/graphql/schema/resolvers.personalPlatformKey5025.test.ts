/**
 * hadron-server#5025 (Billing A8; cor:dmo:050:10 as amended, Holger's ruling 2: every consumer of the walk): with charging
 * and the credit gate both on (`creditGateActive()`), the platform level is open to a person's context in the decrypting
 * query (`resolveAIConfig`), the masked picker (`resolveAiServiceConfigs`) and the chat tool-choice read
 * (`effectiveChatToolChoice`), at parity with an organization. The platform key's plaintext still never reaches a person:
 * the decrypt gate does not move (the three findings: resolve-ai-config-user-owned-app-decrypt-leak,
 * user-owned-agent-config-decrypt-gate-diverges, host-ai-key-decrypt-falls-through-org-gate). With either switch off every
 * read answers as before, and every organization context answers the same with the switches on and off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Organization, User, Agent, App, AiServiceConfig } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb, createDbAgentOrgGrant } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { encryptToken } from '../../../lib/tokenCrypto.js';
import { effectiveChatToolChoice } from '../../../lib/chatbotAiConfig.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn() }));

const Q = resolvers.Query as any;
const KEY = 'platform-provider-key-5025';
const DEBIT = 'BILLING_DEBIT_ENABLED';
const GATE = 'BILLING_CREDIT_GATE_ENABLED';
let org: Organization, owner: User, member: User, orgAdmin: User, platform: User;
let mine: App, myAgent: Agent, pubAgent: Agent, orgApp: App, orgAgent: Agent, platformCfg: AiServiceConfig;

const ctx = (u: User, roles: string[] = ['READER']): Context => ({ db, userId: u.id, roles } as Context);
const switchesOn = () => { vi.stubEnv(DEBIT, 'true'); vi.stubEnv(GATE, 'true'); };
const CLOSED: Array<[string, Record<string, string | undefined>]> = [
  ['both unset', {}],
  ['debit off', { [GATE]: 'true' }],
  ['gate off', { [DEBIT]: 'true' }],
  ['gate `TRUE`', { [DEBIT]: 'true', [GATE]: 'TRUE' }],
];
const apply = (s: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(s)) vi.stubEnv(k, v as string); };

/** What a call answered, as plain data: the value, or the refusal's code and message (never a stack). */
async function outcome(p: Promise<unknown>): Promise<unknown> {
  try {
    return { ok: JSON.parse(JSON.stringify(await p)) };
  } catch (e: any) {
    return { error: e.extensions?.code ?? e.name, message: e.message };
  }
}
const decrypt = (c: Context, args: { appRef?: string; agentRef?: string }) => outcome(Q.resolveAIConfig(null, args, c));
const picker = (c: Context, appRef: string, agentRef?: string) => outcome(Q.resolveAiServiceConfigs(null, { appRef, agentRef }, c));

beforeEach(async () => {
  vi.stubEnv(DEBIT, undefined as unknown as string);
  vi.stubEnv(GATE, undefined as unknown as string);
  await cleanDb(db);
  const s = generateId();
  org = await db.organization.create({ data: { name: 'Publisher', urn: `pub-${s}.example` } });
  [owner, member, orgAdmin, platform] = await Promise.all(['owner', 'member', 'oadmin', 'platform'].map(h =>
    db.user.create({ data: { handle: `${h}-${s}`, roles: h === 'platform' ? ['ADMIN'] : ['READER'] } })));
  await db.orgMember.create({ data: { organizationId: org.id, userId: orgAdmin.id, role: 'ADMIN' } });
  // A person's App with their own Agent and an organization's published Agent installed; a member who is not the owner.
  mine = await db.app.create({ data: { ownerUserId: owner.id, name: 'Mine', urn: `owner-${s}:mine` } });
  myAgent = await db.agent.create({ data: { ownerUserId: owner.id, name: 'M', urn: `owner-${s}:agent`, visibility: 'PERSONAL' } });
  pubAgent = await db.agent.create({ data: { organizationId: org.id, name: 'P', urn: `${org.urn}:pub`, visibility: 'PUBLIC' } });
  await db.appAgent.createMany({ data: [{ appId: mine.id, agentId: myAgent.id }, { appId: mine.id, agentId: pubAgent.id }] });
  await db.agentSubscription.create({ data: { agentId: pubAgent.id, userId: owner.id, activatedAt: new Date() } });
  await db.appMember.create({ data: { appId: mine.id, userId: member.id, role: 'reader' } });
  // The publisher organization has a keyed default of its own: it must never answer in a person's App (item 4).
  await db.aiServiceConfig.create({ data: { organizationId: org.id, name: 'default', provider: 'openai', model: 'org-model', apiKeyEncrypted: encryptToken('org-key-5025'), enabled: true } });
  // An organization's App with its own Agent, for the parity table.
  orgApp = await db.app.create({ data: { organizationId: org.id, name: 'Work', urn: `${org.urn}:work` } });
  orgAgent = await db.agent.create({ data: { organizationId: org.id, name: 'A', urn: `${org.urn}:a`, visibility: 'ORGANIZATION' } });
  await db.appAgent.create({ data: { appId: orgApp.id, agentId: orgAgent.id } });
  await createDbAgentOrgGrant(db, org.id, orgAgent.id);
  await db.appMember.create({ data: { appId: orgApp.id, userId: orgAdmin.id, role: 'admin' } });
  // The platform's keyed default (the HadronServer level).
  const host = await db.hadronServer.create({ data: { url: `https://a8-${s}.example` } });
  platformCfg = await db.aiServiceConfig.create({ data: { hadronServerId: host.id, name: 'default', provider: 'anthropic', model: 'platform-model', apiKeyEncrypted: encryptToken(KEY), apiKeyPreview: '…5025', enabled: true } });
});
afterEach(() => { vi.unstubAllEnvs(); });

/** The four personal contexts the issue names, as decrypt-query arguments. */
const personalContexts = () => [
  { label: 'a person\'s App alone', args: { appRef: mine.id } },
  { label: 'with their own Agent', args: { appRef: mine.id, agentRef: myAgent.id } },
  { label: 'with an organization\'s Agent', args: { appRef: mine.id, agentRef: pubAgent.id } },
  { label: 'a person\'s Agent alone', args: { agentRef: myAgent.id } },
];

describe('#5025 the decrypting query: open to the owner with the switches on, and the key stays masked', () => {
  it('both switches on: the owner gets the platform configuration in all four personal contexts, apiKey null, never the plaintext', async () => {
    switchesOn();
    for (const { label, args } of personalContexts()) {
      const answer = await decrypt(ctx(owner), args) as { ok?: Record<string, unknown> };
      expect(answer.ok, label).toMatchObject({ configId: platformCfg.id, ownerType: 'HADRON_SERVER', model: 'platform-model', apiKey: null, params: null });
      expect(JSON.stringify(answer)).not.toContain(KEY);
    }
  });

  for (const [label, settings] of CLOSED) {
    it(`${label}: every personal context answers as before (no configuration), for the owner`, async () => {
      apply(settings);
      for (const c of personalContexts()) {
        expect(await decrypt(ctx(owner), c.args), c.label).toMatchObject({ error: 'NoAiConfigAvailableError' });
      }
    });
  }

  it('finding #1487 (an unrelated organization ADMIN names the person\'s App and their own organization\'s Agent): refused, the same with the switches on and off', async () => {
    const before = await decrypt(ctx(orgAdmin), { appRef: mine.id, agentRef: pubAgent.id });
    switchesOn();
    const after = await decrypt(ctx(orgAdmin), { appRef: mine.id, agentRef: pubAgent.id });
    expect(before).toMatchObject({ error: expect.any(String) });
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain(KEY);
  });

  it('a non-owner member, an App key, an impersonated owner and a platform admin are refused, the same with the switches on and off', async () => {
    const principals: Array<[string, Context]> = [
      ['member', ctx(member)],
      ['App key', { db, appId: mine.id, roles: [] } as unknown as Context],
      ['impersonated owner', { ...ctx(owner), impersonation: { actorId: platform.id } } as unknown as Context],
      ['platform admin', ctx(platform, ['ADMIN'])],
    ];
    const ask = () => Promise.all(principals.flatMap(([, c]) => personalContexts().map(({ args }) => decrypt(c, args))));
    const off = await ask();
    switchesOn();
    const on = await ask();
    expect(on).toEqual(off);
    for (const answer of on) {
      expect(answer).toMatchObject({ error: expect.any(String) });
      expect(JSON.stringify(answer)).not.toContain(KEY);
    }
  });

  it('finding #1491 (the platform key reaches only a platform admin): the ADMIN of an organization with no default gets HADRON_SERVER masked, on and off', async () => {
    const bare = await db.organization.create({ data: { name: 'Bare', urn: `bare-${generateId()}.example` } });
    await db.orgMember.create({ data: { organizationId: bare.id, userId: orgAdmin.id, role: 'ADMIN' } });
    const bareApp = await db.app.create({ data: { organizationId: bare.id, name: 'Bare', urn: `${bare.urn}:app` } });
    const off = await decrypt(ctx(orgAdmin), { appRef: bareApp.id });
    switchesOn();
    const on = await decrypt(ctx(orgAdmin), { appRef: bareApp.id });
    expect(on).toEqual(off);
    expect(on).toMatchObject({ ok: { configId: platformCfg.id, ownerType: 'HADRON_SERVER', apiKey: null } });
  });
});

describe('#5025 the masked picker and the tool-choice read follow the walk', () => {
  it('both switches on: the owner\'s picker lists the platform row (masked) for each App context, never the publisher\'s row', async () => {
    switchesOn();
    for (const agentRef of [undefined, myAgent.id, pubAgent.id]) {
      const list = (await picker(ctx(owner), mine.id, agentRef) as { ok: Array<Record<string, unknown>> }).ok;
      expect(list.map(r => r.id)).toContain(platformCfg.id);
      expect(list.some(r => r.ownerType === 'ORGANIZATION')).toBe(false);
      expect(JSON.stringify(list)).not.toContain(KEY);
    }
  });

  for (const [label, settings] of CLOSED) {
    it(`${label}: the picker lists no platform row and the tool-choice read is null, as before`, async () => {
      apply(settings);
      for (const agentRef of [undefined, myAgent.id, pubAgent.id]) {
        const list = (await picker(ctx(owner), mine.id, agentRef) as { ok: Array<Record<string, unknown>> }).ok;
        expect(list.some(r => r.ownerType === 'HADRON_SERVER' || r.ownerType === 'ORGANIZATION')).toBe(false);
      }
      for (const chat of [
        { appId: mine.id, agentId: null }, { appId: mine.id, agentId: myAgent.id }, { appId: mine.id, agentId: pubAgent.id }, { appId: null, agentId: myAgent.id },
      ]) expect(await effectiveChatToolChoice(db, { ...chat, storedChoice: null })).toBeNull();
    });
  }

  it('both switches on: the tool-choice read answers the platform configuration\'s decision in all four personal contexts', async () => {
    switchesOn();
    for (const chat of [
      { appId: mine.id, agentId: null }, { appId: mine.id, agentId: myAgent.id }, { appId: mine.id, agentId: pubAgent.id }, { appId: null, agentId: myAgent.id },
    ]) expect(await effectiveChatToolChoice(db, { ...chat, storedChoice: null })).not.toBeNull();
  });
});

describe('#5025 every organization context answers the same with the switches on and off (decrypt, picker, tool choice)', () => {
  it('an organization\'s App alone and with its own Agent, as its ADMIN', async () => {
    const answer = async () => ({
      decrypt: [await decrypt(ctx(orgAdmin), { appRef: orgApp.id }), await decrypt(ctx(orgAdmin), { appRef: orgApp.id, agentRef: orgAgent.id })],
      picker: [await picker(ctx(orgAdmin), orgApp.id), await picker(ctx(orgAdmin), orgApp.id, orgAgent.id)],
      toolChoice: [
        await effectiveChatToolChoice(db, { appId: orgApp.id, agentId: null, storedChoice: null }),
        await effectiveChatToolChoice(db, { appId: orgApp.id, agentId: orgAgent.id, storedChoice: null }),
        await effectiveChatToolChoice(db, { appId: null, agentId: orgAgent.id, storedChoice: null }),
      ],
    });
    const off = await answer();
    switchesOn();
    expect(await answer()).toEqual(off);
    // the organization's own default answers its contexts (the opening is not where they get a configuration from)
    expect(off.decrypt[0]).toMatchObject({ ok: { ownerType: 'ORGANIZATION', model: 'org-model' } });
  });
});
