/**
 * #2245 / #2246: `cloneBlockers` is the one predicate behind S1's refusals and S2's offer reasons.
 * Amendment 2: a non-PUBLIC source passes only for a same-org manager; the outsider audience
 * never gets the exemption. Redaction: a subject is named only when the reading caller may read it.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import type { Context } from '../../api/graphql/schema/resolvers.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';
import { AgentNotFoundError } from '../entityRef/errors.js';
import { CLONE_BLOCKER_CODES, CLONE_SOURCE_CHANGED, cloneBlockers } from './blockers.js';

let orgA: string;
let orgB: string;
let admin: string;
let reader: string;
let outsider: string;

const ctxFor = (userId: string): Context => ({ db, userId, roles: ['READER'] }) as Context;

async function user(tag: string) {
  const id = generateId();
  await db.user.create({ data: { id, email: `${tag}-${id}@x.test`, handle: `${tag}${id.slice(-6)}`.toLowerCase() } });
  return id;
}
async function member(orgId: string, userId: string, role: 'ADMIN' | 'READER') {
  await db.orgMember.create({ data: { organizationId: orgId, userId, role } });
}
async function agent(orgId: string, visibility: 'PUBLIC' | 'ORGANIZATION' | 'PERSONAL', extra: Record<string, unknown> = {}) {
  const id = generateId();
  await db.agent.create({ data: { id, organizationId: orgId, urn: `cb-${id}`, name: `A-${id.slice(-5)}`, visibility, ...extra } });
  return id;
}
async function memory(orgId: string, patch: Record<string, unknown> = {}) {
  const id = generateId();
  await db.memory.create({ data: { id, organizationId: orgId, name: `m-${id.slice(-5)}`, urn: `cbm-${id}`, class: 'knowledge', ...patch } as never });
  return id;
}
const link = (agentId: string, memoryId: string) => db.agentMemoryItem.create({ data: { agentId, memoryId } });

beforeEach(async () => {
  await cleanDb(db);
  orgA = (await db.organization.create({ data: { id: generateId(), name: 'cb-a', urn: 'cb-a' } })).id;
  orgB = (await db.organization.create({ data: { id: generateId(), name: 'cb-b', urn: 'cb-b' } })).id;
  admin = await user('adm');
  reader = await user('rdr');
  outsider = await user('out');
  await member(orgA, admin, 'ADMIN');
  await member(orgA, reader, 'READER');
  await member(orgB, admin, 'ADMIN');
});

const codes = async (src: string, audience: Parameters<typeof cloneBlockers>[2]) =>
  (await cloneBlockers(db, src, audience)).map((b) => b.code);

describe('code table', () => {
  it('maps every raw blocker to its public code', () => {
    expect(CLONE_BLOCKER_CODES).toEqual({
      AGENT_NOT_PUBLIC: 'AGENT_NOT_PUBLIC',
      AGENT_RETIRED: 'AGENT_RETIRED',
      LINKED_MEMORY_ENCRYPTED: 'CLONE_LINKED_MEMORY_ENCRYPTED',
      LINKED_MEMORY_UNREADABLE: 'CLONE_LINKED_MEMORY_UNREADABLE',
      BASE_UNUSABLE: 'CLONE_BASE_UNUSABLE',
      IMPORT_UNUSABLE: 'CLONE_IMPORT_UNUSABLE',
    });
  });
  it('describes the retryable source-changed conflict', () => {
    expect(CLONE_SOURCE_CHANGED).toEqual({ graphqlCode: 'CONFLICT', reason: 'AGENT_CLONE_SOURCE_CHANGED', retryable: true });
  });
});

describe('AGENT_NOT_PUBLIC (R181, amendment 2)', () => {
  it('PUBLIC passes for the org and outsider audiences, cross-org included', async () => {
    const a = await agent(orgA, 'PUBLIC');
    expect(await codes(a, { kind: 'org', orgId: orgA, ctx: ctxFor(admin) })).toEqual([]);
    expect(await codes(a, { kind: 'org', orgId: orgB, ctx: ctxFor(admin) })).toEqual([]);
    expect(await codes(a, { kind: 'outsider', ctx: ctxFor(admin), reader: ctxFor(outsider) })).toEqual([]);
  });
  it('non-PUBLIC: same-org manager passes, everyone else gets AGENT_NOT_PUBLIC', async () => {
    const a = await agent(orgA, 'ORGANIZATION');
    expect(await codes(a, { kind: 'org', orgId: orgA, ctx: ctxFor(admin) })).toEqual([]);
    expect(await codes(a, { kind: 'org', orgId: orgA, ctx: ctxFor(reader) })).toEqual(['AGENT_NOT_PUBLIC']);
    expect(await codes(a, { kind: 'org', orgId: orgB, ctx: ctxFor(admin) })).toEqual(['AGENT_NOT_PUBLIC']);
    expect(await codes(a, { kind: 'outsider', ctx: ctxFor(admin), reader: ctxFor(outsider) })).toEqual(['AGENT_NOT_PUBLIC']);
  });
});

describe('retired and missing', () => {
  it('a retired source lists AGENT_RETIRED right after AGENT_NOT_PUBLIC', async () => {
    const a = await agent(orgA, 'ORGANIZATION', { deletedAt: new Date() });
    expect(await codes(a, { kind: 'outsider', ctx: ctxFor(admin), reader: ctxFor(outsider) })).toEqual(['AGENT_NOT_PUBLIC', 'AGENT_RETIRED']);
    expect(await codes(a, { kind: 'org', orgId: orgA, ctx: ctxFor(admin) })).toEqual(['AGENT_RETIRED']);
  });
  it('a missing source is AgentNotFoundError', async () => {
    await expect(cloneBlockers(db, 'nope', { kind: 'outsider', ctx: ctxFor(admin), reader: ctxFor(outsider) })).rejects.toBeInstanceOf(AgentNotFoundError);
  });
});

describe('linked memories (R172, R170.3) and redaction', () => {
  it('an encrypted linked memory blocks and is named to a reader of it', async () => {
    const a = await agent(orgA, 'PUBLIC');
    const m = await memory(orgA, { isEncrypted: true });
    await link(a, m);
    const [b] = await cloneBlockers(db, a, { kind: 'org', orgId: orgA, ctx: ctxFor(admin) });
    expect(b.code).toBe('CLONE_LINKED_MEMORY_ENCRYPTED');
    expect(b.count).toBe(1);
  });
  it('an unreadable linked memory blocks without a name; a readable one passes', async () => {
    const a = await agent(orgA, 'PUBLIC');
    const secret = await memory(orgB, { class: 'personal', userId: outsider, name: 'TOP-SECRET' });
    const fine = await memory(orgA);
    await link(a, secret);
    await link(a, fine);
    const blockers = await cloneBlockers(db, a, { kind: 'org', orgId: orgA, ctx: ctxFor(reader) });
    expect(blockers.map((x) => x.code)).toEqual(['CLONE_LINKED_MEMORY_UNREADABLE']);
    expect(blockers[0].count).toBe(1);
    expect(JSON.stringify(blockers)).not.toContain('TOP-SECRET');
  });
  it('a soft-deleted link or memory is ignored', async () => {
    const a = await agent(orgA, 'PUBLIC');
    const m = await memory(orgA, { isEncrypted: true, deletedAt: new Date() });
    await link(a, m);
    expect(await codes(a, { kind: 'org', orgId: orgA, ctx: ctxFor(admin) })).toEqual([]);
  });
});

describe('base and imports (R147)', () => {
  it('a base the target org cannot use blocks; a licensed one does not', async () => {
    const foreignBase = await agent(orgB, 'ORGANIZATION');
    const a = await agent(orgA, 'PUBLIC', { extendsAgentId: foreignBase });
    expect(await codes(a, { kind: 'org', orgId: orgA, ctx: ctxFor(admin) })).toEqual(['CLONE_BASE_UNUSABLE']);
    await db.agentOrgGrant.create({ data: { orgId: orgA, agentId: foreignBase, activatedAt: new Date(Date.now() - 1000) } });
    expect(await codes(a, { kind: 'org', orgId: orgA, ctx: ctxFor(admin) })).toEqual([]);
  });
  it('an import the target org cannot use blocks; a subscribable PUBLIC one does not', async () => {
    const a = await agent(orgA, 'PUBLIC');
    const hidden = await agent(orgB, 'ORGANIZATION');
    const open = await agent(orgB, 'PUBLIC');
    for (const [i, imp] of [hidden, open].entries()) {
      await db.agentOrgGrant.create({ data: { orgId: orgA, agentId: imp, activatedAt: new Date(Date.now() - 1000) } });
      await db.agentImport.create({ data: { parentAgentId: a, importedAgentId: imp, position: 100 * (i + 1), agentOrgGrantOrgId: orgA, agentOrgGrantAgentId: imp } });
    }
    // Revoke the grant on the hidden one: concealed foreign non-PUBLIC.
    await db.agentOrgGrant.update({ where: { orgId_agentId: { orgId: orgA, agentId: hidden } }, data: { revokedAt: new Date() } });
    const blockers = await cloneBlockers(db, a, { kind: 'org', orgId: orgA, ctx: ctxFor(admin) });
    expect(blockers.map((x) => x.code)).toEqual(['CLONE_IMPORT_UNUSABLE']);
    expect(blockers[0].count).toBe(1);
  });
});

it('keeps the fixed order across blockers', async () => {
  const a = await agent(orgA, 'ORGANIZATION');
  const enc = await memory(orgA, { isEncrypted: true });
  await link(a, enc);
  expect(await codes(a, { kind: 'outsider', ctx: ctxFor(admin), reader: ctxFor(outsider) })).toEqual(['AGENT_NOT_PUBLIC', 'CLONE_LINKED_MEMORY_ENCRYPTED']);
});

describe('outsider audience: blockers follow the outsider, names follow the reading manager (#2246)', () => {
  it('a linked memory only the manager can read blocks the outsider and is named to the manager', async () => {
    const a = await agent(orgA, 'PUBLIC');
    const m = await memory(orgA, { name: 'ORG-PRIVATE' });
    await link(a, m);
    const audience = { kind: 'outsider' as const, ctx: ctxFor(admin), reader: ctxFor(outsider) };
    const blockers = await cloneBlockers(db, a, audience);
    expect(blockers.map((b) => b.code)).toEqual(['CLONE_LINKED_MEMORY_UNREADABLE']);
    expect(blockers[0].subjects).toEqual([{ position: 0, name: 'ORG-PRIVATE' }]);
    // The same answer a real unrelated-org cloner is refused with.
    expect(await codes(a, { kind: 'org', orgId: orgB, ctx: ctxFor(outsider) })).toEqual(['CLONE_LINKED_MEMORY_UNREADABLE']);
  });
  it('the reader never changes who is named: a memory the manager cannot read stays unnamed', async () => {
    const a = await agent(orgA, 'PUBLIC');
    const secret = await memory(orgB, { class: 'personal', userId: reader, name: 'TOP-SECRET' });
    await link(a, secret);
    const blockers = await cloneBlockers(db, a, { kind: 'outsider', ctx: ctxFor(admin), reader: ctxFor(outsider) });
    expect(blockers.map((b) => b.code)).toEqual(['CLONE_LINKED_MEMORY_UNREADABLE']);
    expect(JSON.stringify(blockers)).not.toContain('TOP-SECRET');
  });
});
