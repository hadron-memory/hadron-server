/**
 * #2417 (cor:dmo:050:14, Holger 2026-10-27; gate word on the issue, 2026-11-18) — whose grant a
 * compile asks for when a bare-loc include reaches a base through the TARGET's own chain.
 *
 * A recipient that does not own the target (an organisation or a user that installed it) needs
 * only the target: the base is read under the target's grant, and no grant to the base is asked
 * for or planned. Nothing else moves: the target's owner still needs the grant extending needs;
 * a full node URN, and an Agent outside the chain, still need that Agent's own grant; and the
 * target's own grant is still required.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb, createDbAgentOrgGrant } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { assembleBootPrompt, BootCompileRefusal, type AssembleInput, type CompileRecipient } from './assemble.js';

type Ag = { id: string; mem: string; memUrn: string };
let vendorId: string;
let baseVendorId: string;
let acmeId: string;
let appId: string;
let installId: string;
let engineer: Ag;
let backend: Ag;
let go: Ag;

async function makeAgent(org: string, slug: string, baseId?: string): Promise<Ag> {
  const memUrn = `a2417-${org.slice(-6)}:${slug}-sys`;
  const mem = await db.memory.create({ data: { id: generateId(), class: 'system', name: slug, urn: memUrn, organizationId: org } });
  const a = await db.agent.create({
    data: { id: generateId(), name: slug, urn: `a2417-${org.slice(-6)}:${slug}`, organizationId: org, systemMemoryId: mem.id, visibility: 'ORGANIZATION', extendsAgentId: baseId ?? null },
  });
  return { id: a.id, mem: mem.id, memUrn };
}
const put = (memoryId: string, loc: string, content: string, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content, ...extra } });

beforeEach(async () => {
  await cleanDb(db);
  const org = async (name: string) => (await db.organization.create({ data: { id: generateId(), name, urn: `${name}-${generateId().slice(-8)}.example` } })).id;
  vendorId = await org('vendor');
  baseVendorId = await org('basevendor');
  acmeId = await org('acme');
  engineer = await makeAgent(baseVendorId, 'engineer');
  backend = await makeAgent(vendorId, 'backend', engineer.id);
  go = await makeAgent(vendorId, 'go', backend.id);
  // The vendor extends another organisation's Agent under the grant extending needs.
  await createDbAgentOrgGrant(db, vendorId, engineer.id);
  await put(engineer.mem, 'parts:rules', 'engineer rules');
  await put(engineer.mem, 'parts:tone', 'engineer tone');
  await put(engineer.mem, 'parts:nested', 'nested: {{> parts:tone}}');
  await put(backend.mem, 'parts:tone', 'backend tone');
  appId = (await db.app.create({ data: { id: generateId(), name: 'App', urn: `acme-${generateId().slice(-8)}:app`, organizationId: acmeId } })).id;
  await db.appAgent.create({ data: { appId, agentId: backend.id } });
  installId = (await db.memory.create({
    data: { id: generateId(), class: 'system', name: 'install', urn: `acme-${generateId().slice(-8)}:install`, organizationId: acmeId, appId, installOfAgentId: backend.id, isInstallMemory: true },
  })).id;
});

/** A compile of `target`'s boot prompt for an App of `recipient`. */
async function input(text: string, recipient: CompileRecipient, target: Ag = backend, install: string | null = installId): Promise<AssembleInput> {
  await db.node.deleteMany({ where: { memoryId: target.mem, loc: 'boot:source' } });
  const src = await put(target.mem, 'boot:source', text, { role: 'boot-prompt' });
  return {
    target: install ? { kind: 'APP_AGENT', agentId: target.id, appId } : { kind: 'AGENT', agentId: target.id },
    installMemoryId: install,
    source: { nodeId: src.id, memoryId: src.memoryId },
    recipient,
    callerCanRead: async () => false,
  };
}
const acme = (): CompileRecipient => ({ kind: 'org', orgId: acmeId });
const refusal = async (p: Promise<unknown>) => {
  try { await p; return 'NO_REFUSAL'; } catch (e) { if (e instanceof BootCompileRefusal) return e.code; throw e; }
};

describe('#2417 — an installer compiles inherited parts under the target licence alone', () => {
  it('an organisation licensed to the child only: the base part compiles, and only the child grant is planned', async () => {
    await createDbAgentOrgGrant(db, acmeId, backend.id);
    const plan = await assembleBootPrompt(db, await input('{{> parts:rules}}|{{> parts:tone}}', acme()));
    expect(plan.text).toBe('engineer rules|backend tone');
    expect(plan.grants).toEqual([{ agentId: backend.id, provision: false }]);
  });

  it('a bare loc inside an inherited part resolves against the child, still under the child licence', async () => {
    await createDbAgentOrgGrant(db, acmeId, backend.id);
    const plan = await assembleBootPrompt(db, await input('{{> parts:nested}}', acme()));
    expect(plan.text).toBe('nested: backend tone');
    expect(plan.grants).toEqual([{ agentId: backend.id, provision: false }]);
  });

  it('a chain of three: both bases come along under the one licence', async () => {
    await createDbAgentOrgGrant(db, acmeId, go.id);
    await db.appAgent.create({ data: { appId, agentId: go.id } });
    const plan = await assembleBootPrompt(db, await input('{{> parts:rules}}|{{> parts:tone}}', acme(), go, null));
    expect(plan.text).toBe('engineer rules|backend tone');
    expect(plan.grants).toEqual([{ agentId: go.id, provision: false }]);
  });

  it('a user licensed to the child only (a subscription): the same', async () => {
    const userId = (await db.user.create({ data: { id: generateId(), email: `${generateId()}@u.test`, name: 'U' } })).id;
    await db.agentSubscription.create({ data: { userId, agentId: backend.id, activatedAt: new Date() } });
    const plan = await assembleBootPrompt(db, await input('{{> parts:rules}}', { kind: 'user', userId }));
    expect(plan.text).toBe('engineer rules');
    expect(plan.grants).toEqual([{ agentId: backend.id, provision: false }]);
  });

  it('the shadow scan follows the same rule: an install node records the base node it replaces', async () => {
    await createDbAgentOrgGrant(db, acmeId, backend.id);
    const base = await db.node.findFirstOrThrow({ where: { memoryId: engineer.mem, loc: 'parts:rules' } });
    await put(installId, 'parts:rules', 'acme rules');
    const plan = await assembleBootPrompt(db, await input('{{> parts:rules}}', acme()));
    expect(plan.text).toBe('acme rules');
    expect(plan.occurrences[1]).toMatchObject({ kind: 'replacement', replacesNodeId: base.id });
    expect(plan.grants).toEqual([{ agentId: backend.id, provision: false }]);
  });
});

describe('#2417 — what does not come along', () => {
  it('no licence to the child: refused before a base is read, though the installer holds the base licence', async () => {
    await createDbAgentOrgGrant(db, acmeId, engineer.id);
    expect(await refusal(assembleBootPrompt(db, await input('{{> parts:rules}}', acme())))).toBe('BOOT_PROMPT_INCLUDE_UNAVAILABLE');
  });

  it('a revoked licence to the child: refused', async () => {
    await createDbAgentOrgGrant(db, acmeId, backend.id, { revokedAt: new Date() });
    expect(await refusal(assembleBootPrompt(db, await input('{{> parts:rules}}', acme())))).toBe('BOOT_PROMPT_INCLUDE_UNAVAILABLE');
  });

  it('a base node named by its full URN, inherited or overridden, still needs the base licence', async () => {
    await createDbAgentOrgGrant(db, acmeId, backend.id);
    for (const loc of ['parts:rules', 'parts:tone']) {
      expect(await refusal(assembleBootPrompt(db, await input(`{{> hrn:node:${engineer.memUrn}:${loc}}}`, acme()))))
        .toBe('BOOT_PROMPT_INCLUDE_UNAVAILABLE');
    }
  });

  it('a base boot prompt is still never inherited', async () => {
    await createDbAgentOrgGrant(db, acmeId, backend.id);
    await put(engineer.mem, 'parts:boot', 'engineer boot', { role: 'boot-prompt' });
    expect(await refusal(assembleBootPrompt(db, await input('{{> parts:boot}}', acme())))).toBe('BOOT_PROMPT_INCLUDE_UNAVAILABLE');
  });

  it('a retired base part answers RETIRED to an installer, as it does to the owner', async () => {
    await createDbAgentOrgGrant(db, acmeId, backend.id);
    await db.node.updateMany({ where: { memoryId: engineer.mem, loc: 'parts:rules' }, data: { deletedAt: new Date() } });
    expect(await refusal(assembleBootPrompt(db, await input('{{> parts:rules}}', acme())))).toBe('BOOT_PROMPT_INCLUDE_RETIRED');
    await createDbAgentOrgGrant(db, vendorId, backend.id);
    expect(await refusal(assembleBootPrompt(db, await input('{{> parts:rules}}', { kind: 'org', orgId: vendorId }, backend, null))))
      .toBe('BOOT_PROMPT_INCLUDE_RETIRED');
  });

  it('an Agent outside the chain, and its own base, still need their own licences', async () => {
    await createDbAgentOrgGrant(db, acmeId, backend.id);
    const other = await makeAgent(vendorId, 'other', engineer.id);
    await put(other.mem, 'parts:own', 'own: {{> parts:rules}}');
    const urn = `hrn:node:${other.memUrn}:parts:own`;
    expect(await refusal(assembleBootPrompt(db, await input(`{{> ${urn}}}`, acme())))).toBe('BOOT_PROMPT_INCLUDE_UNAVAILABLE');
    // Licensed to that Agent, its own chain is not the target's: its base still needs a licence.
    await createDbAgentOrgGrant(db, acmeId, other.id);
    expect(await refusal(assembleBootPrompt(db, await input(`{{> ${urn}}}`, acme())))).toBe('BOOT_PROMPT_INCLUDE_UNAVAILABLE');
  });

  it('the child owner still needs the grant extending needs: without it the base part is refused', async () => {
    await createDbAgentOrgGrant(db, vendorId, backend.id);
    const vendor: CompileRecipient = { kind: 'org', orgId: vendorId };
    const ok = await assembleBootPrompt(db, await input('{{> parts:rules}}', vendor, backend, null));
    expect(ok.grants).toEqual(expect.arrayContaining([{ agentId: engineer.id, provision: false }]));
    await db.agentOrgGrant.update({ where: { orgId_agentId: { orgId: vendorId, agentId: engineer.id } }, data: { revokedAt: new Date() } });
    expect(await refusal(assembleBootPrompt(db, await input('{{> parts:rules}}', vendor, backend, null)))).toBe('BOOT_PROMPT_INCLUDE_UNAVAILABLE');
  });

  it('a user who owns the child still needs a subscription to its base', async () => {
    const userId = (await db.user.create({ data: { id: generateId(), email: `${generateId()}@u.test`, name: 'U' } })).id;
    await db.agent.update({ where: { id: backend.id }, data: { ownerUserId: userId, organizationId: null } });
    expect(await refusal(assembleBootPrompt(db, await input('{{> parts:rules}}', { kind: 'user', userId }, backend, null))))
      .toBe('BOOT_PROMPT_INCLUDE_UNAVAILABLE');
  });
});
