/**
 * #2046 (S9-2) — the strict assembler: what a compile reads, and every typed
 * refusal, against a real database. Read-only: no test here expects a write.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { assembleBootPrompt, BootCompileRefusal, DEFAULT_ASSEMBLE_LIMITS, type AssembleInput } from './assemble.js';
import { sha256Hex } from './provenance.js';

let orgId: string;
let otherOrgId: string;
const agent: Record<string, { id: string; mem: string }> = {};
let appId: string;
let installId: string;
let n = 0;

async function makeAgent(key: string, opts: { org?: string; base?: string; visibility?: 'PUBLIC' | 'ORGANIZATION' } = {}) {
  const org = opts.org ?? orgId;
  const mem = await db.memory.create({ data: { id: generateId(), class: 'system', name: `${key}-sys`, urn: `as-${org.slice(-6)}:${key}-sys`, organizationId: org } });
  const a = await db.agent.create({
    data: { id: generateId(), name: key, urn: `as-${org.slice(-6)}:${key}`, organizationId: org, systemMemoryId: mem.id, visibility: opts.visibility ?? 'ORGANIZATION', extendsAgentId: opts.base ? agent[opts.base]!.id : null },
  });
  agent[key] = { id: a.id, mem: mem.id };
}
const put = (memoryId: string, loc: string, content: string, extra: Record<string, unknown> = {}) =>
  db.node.create({ data: { id: generateId(), memoryId, loc, name: loc, content, ...extra } });

beforeEach(async () => {
  await cleanDb(db);
  orgId = (await db.organization.create({ data: { id: generateId(), name: 'asm', urn: `asm-${++n}.example` } })).id;
  otherOrgId = (await db.organization.create({ data: { id: generateId(), name: 'asm-other', urn: `asm-other-${n}.example` } })).id;
  await makeAgent('root');
  await makeAgent('child', { base: 'root' });
  appId = (await db.app.create({ data: { id: generateId(), name: 'App', urn: `asm-${n}.example:app`, organizationId: orgId } })).id;
  await db.appAgent.create({ data: { appId, agentId: agent.child!.id } });
  installId = (await db.memory.create({
    data: { id: generateId(), class: 'system', name: 'install', urn: `asm-${n}.example:install`, organizationId: orgId, appId, installOfAgentId: agent.child!.id, isInstallMemory: true },
  })).id;
});

const input = async (sourceMemory: string, text: string, app = false): Promise<AssembleInput> => {
  const src = await put(sourceMemory, 'boot:source', text, { role: 'boot-prompt' });
  return {
    target: app ? { kind: 'APP_AGENT', agentId: agent.child!.id, appId } : { kind: 'AGENT', agentId: agent.child!.id },
    installMemoryId: app ? installId : null,
    source: { nodeId: src.id, memoryId: src.memoryId },
    recipient: { kind: 'org', orgId },
    callerCanRead: async () => true,
  };
};
const refusal = async (p: Promise<unknown>) => {
  try { await p; return 'NO_REFUSAL'; } catch (e) { if (e instanceof BootCompileRefusal) return e.code; throw e; }
};

describe('#2046 S9-2 — what a compile reads', () => {
  it('expands a part, leaves variables and code-formatted tags literal, and records provenance', async () => {
    await put(agent.child!.mem, 'parts:a', 'Part A for {{worker.name}}.');
    const plan = await assembleBootPrompt(db, await input(agent.child!.mem, 'Hi.\n{{> parts:a}}\n`{{> parts:a}}`'));
    expect(plan.text).toBe('Hi.\nPart A for {{worker.name}}.\n`{{> parts:a}}`');
    expect(plan.contentHash).toBe(sha256Hex(plan.text));
    expect(plan.occurrences.map((o) => [o.order, o.kind, o.depth, o.parent])).toEqual([[0, 'source', 0, null], [1, 'include', 1, 0]]);
    expect(plan.occurrences[1]).toMatchObject({ position: { line: 2, column: 1 }, selection: { rev: null, approved: false, signed: false } });
  });

  it('R8: a bare loc reaches a base part; the nearest level wins', async () => {
    await put(agent.root!.mem, 'parts:rules', 'base rules');
    await put(agent.root!.mem, 'parts:tone', 'base tone');
    await put(agent.child!.mem, 'parts:tone', 'child tone');
    const plan = await assembleBootPrompt(db, await input(agent.child!.mem, '{{> parts:rules}}|{{> parts:tone}}'));
    expect(plan.text).toBe('base rules|child tone');
  });

  it("R8: a base's boot-prompt-role node is never inherited", async () => {
    await put(agent.root!.mem, 'parts:boot', 'base boot', { role: 'boot-prompt' });
    expect(await refusal(assembleBootPrompt(db, await input(agent.child!.mem, '{{> parts:boot}}')))).toBe('BOOT_PROMPT_INCLUDE_UNAVAILABLE');
  });

  it('App compile: an install node at the same loc replaces the Agent node, recorded as a replacement', async () => {
    const own = await put(agent.child!.mem, 'parts:a', 'agent A');
    await put(installId, 'parts:a', 'app A');
    const plan = await assembleBootPrompt(db, await input(agent.child!.mem, '{{> parts:a}}', true));
    expect(plan.text).toBe('app A');
    expect(plan.occurrences[1]).toMatchObject({ kind: 'replacement', replacesNodeId: own.id });
  });

  it('R83: a soft-deleted install node is absent, and the Agent node is used', async () => {
    await put(agent.child!.mem, 'parts:a', 'agent A');
    await put(installId, 'parts:a', 'app A', { deletedAt: new Date() });
    const plan = await assembleBootPrompt(db, await input(agent.child!.mem, '{{> parts:a}}', true));
    expect(plan.text).toBe('agent A');
    expect(plan.occurrences[1]!.kind).toBe('include');
  });

  it('a live replacement that does not qualify refuses, with no fallback to the Agent node', async () => {
    await put(agent.child!.mem, 'parts:a', 'agent A');
    await put(installId, 'parts:a', 'app A');
    expect(await refusal(assembleBootPrompt(db, await input(agent.child!.mem, '{{> parts:a approved}}', true)))).toBe('BOOT_PROMPT_INCLUDE_REVISION_UNAVAILABLE');
  });

  it('a pinned revision is served, and recorded with its selection', async () => {
    const part = await put(agent.child!.mem, 'parts:a', 'v1');
    await db.nodeRevision.create({ data: { nodeId: part.id, memoryId: part.memoryId, loc: part.loc, name: part.name, content: 'v1', revNo: 1, tags: [] } });
    await db.node.update({ where: { id: part.id }, data: { content: 'v2', revSeq: 2 } });
    const plan = await assembleBootPrompt(db, await input(agent.child!.mem, '{{> parts:a rev=1}}'));
    expect(plan.text).toBe('v1');
    expect(plan.occurrences[1]).toMatchObject({ revNo: 1, hash: sha256Hex('v1'), selection: { rev: 1, approved: false, signed: false } });
  });
});

describe('#2046 S9-2 — every refusal', () => {
  it('R79: a pin past the target\'s revisions refuses as unavailable', async () => {
    await put(agent.child!.mem, 'parts:a', 'v1');
    expect(await refusal(assembleBootPrompt(db, await input(agent.child!.mem, '{{> parts:a rev=7}}')))).toBe('BOOT_PROMPT_INCLUDE_UNAVAILABLE');
    await db.node.deleteMany({ where: { loc: 'boot:source' } });
    // With `approved` too: still missing (R79), not "no qualifying revision".
    expect(await refusal(assembleBootPrompt(db, await input(agent.child!.mem, '{{> parts:a rev=7 approved}}')))).toBe('BOOT_PROMPT_INCLUDE_UNAVAILABLE');
  });

  it('a cycle refuses', async () => {
    await put(agent.child!.mem, 'parts:a', '{{> parts:b}}');
    await put(agent.child!.mem, 'parts:b', '{{> parts:a}}');
    expect(await refusal(assembleBootPrompt(db, await input(agent.child!.mem, '{{> parts:a}}')))).toBe('BOOT_PROMPT_INCLUDE_CYCLE');
  });

  it('R75: ten levels of includes are accepted, eleven refused', async () => {
    for (let i = 1; i <= 11; i++) await put(agent.child!.mem, `parts:l${i}`, i < 11 ? `{{> parts:l${i + 1}}}` : 'bottom');
    const at = async (top: number) => {
      await db.node.updateMany({ where: { memoryId: agent.child!.mem, loc: `parts:l${top}` }, data: { content: 'bottom' } });
    };
    // Levels 1..10 below the source: l1..l10 with l10 the bottom.
    await at(10);
    expect((await assembleBootPrompt(db, await input(agent.child!.mem, '{{> parts:l1}}'))).text).toBe('bottom');
    await db.node.updateMany({ where: { memoryId: agent.child!.mem, loc: 'parts:l10' }, data: { content: '{{> parts:l11}}' } });
    await db.node.deleteMany({ where: { memoryId: agent.child!.mem, loc: 'boot:source' } });
    expect(await refusal(assembleBootPrompt(db, await input(agent.child!.mem, '{{> parts:l1}}')))).toBe('BOOT_PROMPT_INCLUDE_TOO_DEEP');
  });

  it('a missing include refuses as unavailable; a soft-deleted URN target as retired', async () => {
    expect(await refusal(assembleBootPrompt(db, await input(agent.child!.mem, '{{> parts:none}}')))).toBe('BOOT_PROMPT_INCLUDE_UNAVAILABLE');
    await db.node.deleteMany({ where: { loc: 'boot:source' } });
    await put(agent.root!.mem, 'parts:gone', 'gone', { deletedAt: new Date() });
    const urn = `hrn:node:${(await db.memory.findUniqueOrThrow({ where: { id: agent.root!.mem } })).urn}:parts:gone`;
    expect(await refusal(assembleBootPrompt(db, await input(agent.child!.mem, `{{> ${urn}}}`)))).toBe('BOOT_PROMPT_INCLUDE_RETIRED');
  });

  it('a disallowed source: SOURCE_DISALLOWED when the caller can read it, UNAVAILABLE when not', async () => {
    const know = await db.memory.create({ data: { id: generateId(), class: 'knowledge', name: 'k', urn: `asm-${n}.example:know`, organizationId: orgId, visibility: 'ORGANIZATION' } });
    await put(know.id, 'parts:k', 'knowledge');
    const urn = `hrn:node:asm-${n}.example:know:parts:k`;
    const readable = await input(agent.child!.mem, `{{> ${urn}}}`);
    expect(await refusal(assembleBootPrompt(db, readable))).toBe('BOOT_PROMPT_INCLUDE_SOURCE_DISALLOWED');
    expect(await refusal(assembleBootPrompt(db, { ...readable, callerCanRead: async () => false }))).toBe('BOOT_PROMPT_INCLUDE_UNAVAILABLE');
  });

  it("another App's install memory is a disallowed source", async () => {
    const app2 = await db.app.create({ data: { id: generateId(), name: 'App2', urn: `asm-${n}.example:app2`, organizationId: orgId } });
    await db.appAgent.create({ data: { appId: app2.id, agentId: agent.child!.id } });
    const other = await db.memory.create({ data: { id: generateId(), class: 'system', name: 'i2', urn: `asm-${n}.example:install2`, organizationId: orgId, appId: app2.id, installOfAgentId: agent.child!.id, isInstallMemory: true } });
    await put(other.id, 'parts:x', 'other app');
    expect(await refusal(assembleBootPrompt(db, await input(agent.child!.mem, `{{> hrn:node:asm-${n}.example:install2:parts:x}}`, true)))).toBe('BOOT_PROMPT_INCLUDE_SOURCE_DISALLOWED');
  });

  it('an encrypted memory never enters assembly', async () => {
    await db.memory.update({ where: { id: agent.root!.mem }, data: { isEncrypted: true } });
    await put(agent.root!.mem, 'parts:secret', 'ciphertext');
    expect(await refusal(assembleBootPrompt(db, await input(agent.child!.mem, '{{> parts:secret}}')))).toBe('BOOT_PROMPT_INCLUDE_UNAVAILABLE');
  });

  it('a malformed stored tag refuses', async () => {
    expect(await refusal(assembleBootPrompt(db, await input(agent.child!.mem, '{{> parts:a rev=x}}')))).toBe('BOOT_PROMPT_INCLUDE_MALFORMED');
  });

  it('the occurrence and byte limits refuse', async () => {
    await put(agent.child!.mem, 'parts:a', 'x');
    const i = await input(agent.child!.mem, '{{> parts:a}}{{> parts:a}}{{> parts:a}}');
    expect(await refusal(assembleBootPrompt(db, i, { ...DEFAULT_ASSEMBLE_LIMITS, maxOccurrences: 2 }))).toBe('BOOT_PROMPT_COMPILE_LIMIT_EXCEEDED');
    expect(await refusal(assembleBootPrompt(db, i, { ...DEFAULT_ASSEMBLE_LIMITS, maxBytes: 10 }))).toBe('BOOT_PROMPT_COMPILE_LIMIT_EXCEEDED');
  });
});

describe('#2046 S9-2 — grants (cor:agt:040:08)', () => {
  it('a missing same-org grant is provisioned; an active one passes', async () => {
    await put(agent.root!.mem, 'parts:r', 'r');
    await db.agentOrgGrant.create({ data: { orgId, agentId: agent.child!.id, activatedAt: new Date() } });
    const plan = await assembleBootPrompt(db, await input(agent.child!.mem, '{{> parts:r}}'));
    expect(plan.grants).toEqual([
      { agentId: agent.child!.id, provision: false },
      { agentId: agent.root!.id, provision: true },
    ].sort((a, b) => a.agentId.localeCompare(b.agentId)));
  });

  it('a revoked same-org grant is never revived', async () => {
    await db.agentOrgGrant.create({ data: { orgId, agentId: agent.child!.id, activatedAt: new Date(), revokedAt: new Date() } });
    expect(await refusal(assembleBootPrompt(db, await input(agent.child!.mem, 'plain')))).toBe('BOOT_PROMPT_GRANT_REQUIRED');
  });

  it('a foreign PUBLIC Agent needs a subscription; a foreign non-public one is concealed', async () => {
    await makeAgent('pub', { org: otherOrgId, visibility: 'PUBLIC' });
    await makeAgent('priv', { org: otherOrgId });
    await put(agent.pub!.mem, 'parts:p', 'public part');
    await put(agent.priv!.mem, 'parts:q', 'private part');
    const urnOf = async (key: string, loc: string) => `hrn:node:${(await db.memory.findUniqueOrThrow({ where: { id: agent[key]!.mem } })).urn}:${loc}`;
    expect(await refusal(assembleBootPrompt(db, await input(agent.child!.mem, `{{> ${await urnOf('pub', 'parts:p')}}}`)))).toBe('BOOT_PROMPT_GRANT_REQUIRED');
    await db.node.deleteMany({ where: { loc: 'boot:source' } });
    expect(await refusal(assembleBootPrompt(db, await input(agent.child!.mem, `{{> ${await urnOf('priv', 'parts:q')}}}`)))).toBe('BOOT_PROMPT_INCLUDE_UNAVAILABLE');
    await db.node.deleteMany({ where: { loc: 'boot:source' } });
    await db.agentOrgGrant.create({ data: { orgId, agentId: agent.pub!.id, activatedAt: new Date() } });
    const plan = await assembleBootPrompt(db, await input(agent.child!.mem, `{{> ${await urnOf('pub', 'parts:p')}}}`));
    expect(plan.text).toBe('public part');
  });
});
