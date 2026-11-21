/**
 * #4140 (S4 of #775) — memory, org and agent writes take refs (cor:api:140:01, :03).
 * updateMemory(ref, orgRef), updateOrganization(ref), createAgent(orgRef, systemMemoryRef),
 * updateAgent(systemMemoryRef): a URN works wherever a PK does; a foreign ref resolves AFTER the
 * resource's own gate; every not-found a promotion door can produce is one answer naming only the
 * caller's ref; no raw URN or empty value reaches a foreign key.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { buildSchema, type GraphQLObjectType } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { canOpenMemoryRecordById, type Context } from './resolvers.helpers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({ writeNodeToGit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({ syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }) }));

const M = resolvers.Mutation as any;
const ctxOf = (userId: string) => ({ db, userId, roles: ['READER'], clientId: `user:${userId}` }) as unknown as Context;
const refusal = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as any; } throw new Error('expected a rejection'); };
const codeOf = (e: any) => e.extensions?.code ?? e.code;

let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let admin: { id: string };
let member: { id: string }; // org MEMBER of A, not an admin
let stranger: { id: string };

beforeEach(async () => {
  await cleanDb(db);
  const s = generateId().toLowerCase();
  orgA = await db.organization.create({ data: { id: generateId(), name: 'refs-a', urn: `refs-a-${s}.com` } });
  orgB = await db.organization.create({ data: { id: generateId(), name: 'refs-b', urn: `refs-b-${s}.com` } });
  const mk = (n: number) => db.user.create({ data: { id: generateId(), githubId: 940100 + n, githubUsername: `refs4140-${n}-${s}`, roles: ['READER'] } });
  admin = await mk(1); member = await mk(2); stranger = await mk(3);
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgA.id, userId: admin.id, role: 'ADMIN' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgA.id, userId: member.id, role: 'READER' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgB.id, userId: admin.id, role: 'ADMIN' } });
});

const knowledge = (org: { id: string; urn: string }, name: string) =>
  db.memory.create({ data: { id: generateId(), name, urn: `${org.urn}:${name}-${generateId()}`, organizationId: org.id, class: 'knowledge' } });
const brainless = async (name = 'Agent') => {
  const a = await M.createAgent({}, { orgRef: orgA.urn, name }, ctxOf(admin.id));
  await db.agent.update({ where: { id: a.id }, data: { systemMemoryId: null } });
  return a as { id: string; urn: string };
};

describe('#4140 SDL: the old names are gone', () => {
  const fields = () => (buildSchema(typeDefs).getType('Mutation') as GraphQLObjectType).getFields();
  const args = (n: string) => fields()[n]!.args.map((a) => a.name);
  it('declares only the new names, and retypes the optional system-memory refs to ID', () => {
    expect(args('updateMemory')).toEqual(expect.arrayContaining(['ref', 'orgRef']));
    expect(args('updateMemory')).not.toEqual(expect.arrayContaining(['id']));
    expect(args('updateMemory')).not.toContain('organizationId');
    expect(args('updateOrganization')).toContain('ref');
    expect(args('updateOrganization')).not.toContain('id');
    expect(args('createAgent')).toEqual(expect.arrayContaining(['orgRef', 'systemMemoryRef']));
    expect(args('createAgent')).not.toEqual(expect.arrayContaining(['orgId']));
    expect(args('createAgent')).not.toContain('systemMemoryId');
    expect(args('updateAgent')).toContain('systemMemoryRef');
    expect(args('updateAgent')).not.toContain('systemMemoryId');
    const t = (n: string, a: string) => String(fields()[n]!.args.find((x) => x.name === a)!.type);
    expect(t('createAgent', 'systemMemoryRef')).toBe('ID');
    expect(t('updateAgent', 'systemMemoryRef')).toBe('ID');
  });
});

describe('#4140 updateMemory(ref, orgRef) and updateOrganization(ref)', () => {
  it('#4218: the SDL documents orgRef as PK or URN on the resolved id, the transfer refusal, and the manage-scoped org miss', () => {
    const doc = (buildSchema(typeDefs).getType('Mutation') as GraphQLObjectType).getFields().updateMemory!.description ?? '';
    expect(doc).toMatch(/fully-qualified URN/);
    expect(doc).toMatch(/RESOLVED organization id/);
    expect(doc).toContain('USE_TRANSFER_MEMORY_OWNERSHIP');
    expect(doc).toContain('transferMemoryOwnership');
    expect(doc).toMatch(/may manage the memory, an organization that\s+does not exist answers ORGANIZATION_NOT_FOUND/);
    expect(doc).toMatch(/cannot read the\s+memory gets its concealed MEMORY_NOT_FOUND/);
    expect(doc).toMatch(/can read\s+it but may not manage it gets the ordinary authorization denial/);
    expect(doc).not.toMatch(/must equal/i);
  });
  it('ref accepts a PK and a URN; the memory\'s OWN org by URN or PK is a no-op', async () => {
    const m = await knowledge(orgA, 'mem');
    for (const ref of [m.id, m.urn]) {
      for (const orgRef of [orgA.id, orgA.urn]) {
        // #4218: a no-op orgRef must not swallow the rest of the call: the description really round-trips.
        const description = `d-${ref.length}-${orgRef.length}`;
        const updated = await M.updateMemory({}, { ref, orgRef, description }, ctxOf(admin.id));
        expect(updated.id).toBe(m.id);
        expect(updated.description).toBe(description);
        expect((await db.memory.findUniqueOrThrow({ where: { id: m.id } })).description).toBe(description);
      }
    }
  });
  it('another org (PK or URN) is the transfer refusal; an unknown org is typed ORGANIZATION_NOT_FOUND; empty is never resolved', async () => {
    const m = await knowledge(orgA, 'mem2');
    for (const orgRef of [orgB.id, orgB.urn]) {
      expect(codeOf(await refusal(M.updateMemory({}, { ref: m.id, orgRef }, ctxOf(admin.id))))).toBe('USE_TRANSFER_MEMORY_OWNERSHIP');
    }
    expect(codeOf(await refusal(M.updateMemory({}, { ref: m.id, orgRef: 'no-such-org.example' }, ctxOf(admin.id))))).toBe('ORGANIZATION_NOT_FOUND');
    expect(codeOf(await refusal(M.updateMemory({}, { ref: m.id, orgRef: '' }, ctxOf(admin.id))))).toBe('USE_TRANSFER_MEMORY_OWNERSHIP');
  });
  it('the memory\'s own gate runs BEFORE orgRef resolves: an unreadable memory answers as missing even with a bogus orgRef', async () => {
    const m = await knowledge(orgB, 'hidden');
    const outsider = await refusal(M.updateMemory({}, { ref: m.id, orgRef: 'no-such-org.example' }, ctxOf(stranger.id)));
    const missing = await refusal(M.updateMemory({}, { ref: generateId(), orgRef: 'no-such-org.example' }, ctxOf(stranger.id)));
    expect(codeOf(outsider)).toBe('MEMORY_NOT_FOUND');
    expect(codeOf(missing)).toBe('MEMORY_NOT_FOUND');
  });
  it('#4218: a readable non-manager gets the ordinary authorization denial, never the org lookup or the concealed answer, as the SDL says', async () => {
    const m = await knowledge(orgA, 'readable');
    // The precondition that makes this the readable-non-manager case, not the concealed one.
    expect(await canOpenMemoryRecordById(ctxOf(member.id), m.id)).toBe(true);
    const denied = await refusal(M.updateMemory({}, { ref: m.id, orgRef: 'no-such-org.example', description: 'must-not-land' }, ctxOf(member.id)));
    // Brooks (blind, #4692): pin the exact denial, not a set of not-X codes.
    expect(codeOf(denied)).toBe('FORBIDDEN');
    // ...and the refused call wrote nothing.
    expect((await db.memory.findUniqueOrThrow({ where: { id: m.id } })).description).not.toBe('must-not-land');
  });
  it('updateOrganization ref accepts a PK and a URN, and the ADMIN gate is on the resolved org', async () => {
    for (const ref of [orgA.id, orgA.urn]) {
      expect((await M.updateOrganization({}, { ref, listedOnMarketplace: false }, ctxOf(admin.id))).id).toBe(orgA.id);
    }
    expect(String((await refusal(M.updateOrganization({}, { ref: orgA.urn, listedOnMarketplace: true }, ctxOf(member.id)))).message)).toMatch(/forbidden|admin|permission/i);
  });
});

describe('#4140 createAgent(orgRef, systemMemoryRef)', () => {
  it('orgRef takes a URN; systemMemoryRef takes a URN and promotes the resolved memory', async () => {
    const m = await knowledge(orgA, 'brain');
    const a = await M.createAgent({}, { orgRef: orgA.urn, name: 'ByUrn', systemMemoryRef: m.urn }, ctxOf(admin.id));
    expect(a.systemMemoryId).toBe(m.id);
    expect((await db.memory.findUniqueOrThrow({ where: { id: m.id } })).class).toBe('system');
  });
  it('an empty systemMemoryRef auto-provisions (never resolved, never a foreign-key value)', async () => {
    const a = await M.createAgent({}, { orgRef: orgA.id, name: 'Auto', systemMemoryRef: '' }, ctxOf(admin.id));
    expect(a.systemMemoryId).toBeTruthy();
    expect((await db.memory.findUniqueOrThrow({ where: { id: a.systemMemoryId } })).class).toBe('system');
  });
  it('missing, deleted and unreadable refs give ONE not-found naming only the caller\'s ref', async () => {
    const hidden = await knowledge(orgB, 'hidden-brain');
    await db.orgMember.deleteMany({ where: { organizationId: orgB.id, userId: admin.id } });
    const gone = await knowledge(orgA, 'gone');
    await db.memory.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    const refs = [hidden.urn, gone.urn, `${orgA.urn}:never-existed`];
    const answers = [];
    for (const r of refs) {
      const e = await refusal(M.createAgent({}, { orgRef: orgA.id, name: 'X', systemMemoryRef: r }, ctxOf(admin.id)));
      expect(codeOf(e)).toBe('MEMORY_NOT_FOUND');
      expect(e.message).toBe(`MEMORY_NOT_FOUND: ${r}`);
      expect(e.message).not.toContain(hidden.id);
      answers.push(e.message.replace(r, '<ref>'));
    }
    expect(new Set(answers).size).toBe(1);
  });
  it('the org authority precedes resolution: a non-admin gets the role refusal whether the memory exists or not', async () => {
    const m = await knowledge(orgA, 'exists');
    const a = await refusal(M.createAgent({}, { orgRef: orgA.id, name: 'X', systemMemoryRef: m.id }, ctxOf(member.id)));
    const b = await refusal(M.createAgent({}, { orgRef: orgA.id, name: 'X', systemMemoryRef: generateId() }, ctxOf(member.id)));
    expect(codeOf(a)).not.toBe('MEMORY_NOT_FOUND');
    expect(codeOf(b)).toBe(codeOf(a));
  });
});

describe('#4140 updateAgent(systemMemoryRef)', () => {
  const REFUSAL = /Cannot unset or change/;
  it('the CURRENT system memory by PK or URN is accepted as unchanged; the column is untouched', async () => {
    const a = await M.createAgent({}, { orgRef: orgA.id, name: 'Has brain' }, ctxOf(admin.id));
    const sys = await db.memory.findUniqueOrThrow({ where: { id: a.systemMemoryId } });
    for (const ref of [sys.id, sys.urn]) {
      expect((await M.updateAgent({}, { ref: a.id, systemMemoryRef: ref, description: 'ok' }, ctxOf(admin.id))).systemMemoryId).toBe(sys.id);
    }
  });
  it('another, missing, unreadable or empty ref while attached is the SAME refusal', async () => {
    const a = await M.createAgent({}, { orgRef: orgA.id, name: 'Has brain 2' }, ctxOf(admin.id));
    const other = await knowledge(orgA, 'other');
    const hidden = await knowledge(orgB, 'hidden2');
    await db.orgMember.deleteMany({ where: { organizationId: orgB.id, userId: admin.id } });
    for (const ref of [other.id, other.urn, generateId(), `${orgA.urn}:never-existed`, hidden.id, hidden.urn, '']) {
      const e = await refusal(M.updateAgent({}, { ref: a.id, systemMemoryRef: ref }, ctxOf(admin.id)));
      expect(codeOf(e)).toBe('BAD_USER_INPUT');
      expect(e.message).toMatch(REFUSAL);
    }
    expect((await db.agent.findUniqueOrThrow({ where: { id: a.id } })).systemMemoryId).toBe(a.systemMemoryId);
  });
  it('an empty ref on an unattached agent is an accepted no-op: the column stays NULL, never an empty string', async () => {
    const a = await brainless('Empty');
    const out = await M.updateAgent({}, { ref: a.id, systemMemoryRef: '', description: 'still brainless' }, ctxOf(admin.id));
    expect(out.systemMemoryId).toBeNull();
    expect((await db.agent.findUniqueOrThrow({ where: { id: a.id } })).systemMemoryId).toBeNull();
  });
  it('first attach by URN promotes the resolved memory and writes its PK', async () => {
    const a = await brainless('Attach');
    const m = await knowledge(orgA, 'attach-me');
    const out = await M.updateAgent({}, { ref: a.id, systemMemoryRef: m.urn }, ctxOf(admin.id));
    expect(out.systemMemoryId).toBe(m.id);
    expect((await db.memory.findUniqueOrThrow({ where: { id: m.id } })).class).toBe('system');
  });
  it('first attach: missing, deleted and unreadable give the one not-found naming the caller\'s ref', async () => {
    const a = await brainless('AttachMiss');
    const hidden = await knowledge(orgB, 'hidden3');
    await db.orgMember.deleteMany({ where: { organizationId: orgB.id, userId: admin.id } });
    const gone = await knowledge(orgA, 'gone2');
    await db.memory.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    for (const r of [hidden.urn, gone.urn, `${orgA.urn}:never-existed`]) {
      const e = await refusal(M.updateAgent({}, { ref: a.id, systemMemoryRef: r }, ctxOf(admin.id)));
      expect(codeOf(e)).toBe('MEMORY_NOT_FOUND');
      expect(e.message).toBe(`MEMORY_NOT_FOUND: ${r}`);
    }
  });
  it('first attach on a USER-owned agent is the owner\'s act BEFORE resolution: an admitted platform ADMIN sees the exact FORBIDDEN for existing, missing and relative refs', async () => {
    const owner = await db.user.create({ data: { id: generateId(), githubId: 940199, githubUsername: `refs4140-owner-${generateId()}`, handle: `own${generateId().slice(0, 8)}`.toLowerCase(), roles: ['READER'] } });
    const agent = await db.agent.create({ data: { id: generateId(), ownerUserId: owner.id, urn: `${owner.handle}:brainless`, name: 'Mine', visibility: 'PERSONAL' } });
    // A persisted PLATFORM admin passes Agent admission (the personal agent is visible to them), so the owner-act
    // guard is what refuses. A plain org ADMIN would stop earlier at AGENT_NOT_FOUND and never reach it (LOCAL F2).
    const pa = await db.user.create({ data: { id: generateId(), githubId: 940198, githubUsername: `refs4140-pa-${generateId()}`, roles: ['ADMIN'] } });
    const paCtx = { db, userId: pa.id, roles: ['ADMIN'], clientId: `user:${pa.id}` } as unknown as Context;
    const m = await knowledge(orgA, 'x');
    for (const ref of [m.id, m.urn, generateId(), `${orgA.urn}:never-existed`, 'relative:shape']) {
      const e = await refusal(M.updateAgent({}, { ref: agent.id, systemMemoryRef: ref }, paCtx));
      expect(codeOf(e)).toBe('FORBIDDEN');
      expect(e.message).toMatch(/owner's act/);
    }
    expect((await db.agent.findUniqueOrThrow({ where: { id: agent.id } })).systemMemoryId).toBeNull();
  });
  it('positive control: a non-owner platform ADMIN resending the CURRENT system memory by URN succeeds unchanged', async () => {
    const owner = await db.user.create({ data: { id: generateId(), githubId: 940197, githubUsername: `refs4140-own2-${generateId()}`, handle: `own${generateId().slice(0, 8)}`.toLowerCase(), roles: ['READER'] } });
    const created = await M.createAgent({}, { name: 'Mine with brain' }, ctxOf(owner.id));
    const sys = await db.memory.findUniqueOrThrow({ where: { id: created.systemMemoryId } });
    const pa = await db.user.create({ data: { id: generateId(), githubId: 940196, githubUsername: `refs4140-pa2-${generateId()}`, roles: ['ADMIN'] } });
    const paCtx = { db, userId: pa.id, roles: ['ADMIN'], clientId: `user:${pa.id}` } as unknown as Context;
    const out = await M.updateAgent({}, { ref: created.id, systemMemoryRef: sys.urn, description: 'admin touch' }, paCtx);
    expect(out.systemMemoryId).toBe(sys.id);
  });
});

describe('#4140 LOCAL F1: an unreadable AMBIGUOUS legacy alias is indistinguishable from a missing ref', () => {
  const twoClaimants = async () => {
    const claim = `${orgB.urn}:ambig-${generateId()}`;
    const a = await knowledge(orgB, 'amb1');
    const b = await knowledge(orgB, 'amb2');
    await db.memory.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { legacyUrn: claim } });
    await db.orgMember.deleteMany({ where: { organizationId: orgB.id, userId: admin.id } });
    return { claim, ids: [a.id, b.id] };
  };
  const clear = (ids: string[]) => db.memory.updateMany({ where: { id: { in: ids } }, data: { legacyUrn: null } });

  it('createAgent: same answer with and without the foreign aliases', async () => {
    const { claim, ids } = await twoClaimants();
    const withAlias = await refusal(M.createAgent({}, { orgRef: orgA.id, name: 'Amb', systemMemoryRef: claim }, ctxOf(admin.id)));
    await clear(ids);
    const without = await refusal(M.createAgent({}, { orgRef: orgA.id, name: 'Amb', systemMemoryRef: claim }, ctxOf(admin.id)));
    expect(codeOf(withAlias)).toBe('MEMORY_NOT_FOUND');
    expect(withAlias.message).toBe(without.message);
    expect(withAlias.message).toBe(`MEMORY_NOT_FOUND: ${claim}`);
  });
  it('updateAgent first attach: same answer with and without the foreign aliases', async () => {
    const a = await brainless('AmbAttach');
    const { claim, ids } = await twoClaimants();
    const withAlias = await refusal(M.updateAgent({}, { ref: a.id, systemMemoryRef: claim }, ctxOf(admin.id)));
    await clear(ids);
    const without = await refusal(M.updateAgent({}, { ref: a.id, systemMemoryRef: claim }, ctxOf(admin.id)));
    expect(codeOf(withAlias)).toBe('MEMORY_NOT_FOUND');
    expect(withAlias.message).toBe(without.message);
  });
  it('updateAgent while attached: the one Cannot-unset-or-change refusal either way', async () => {
    const a = await M.createAgent({}, { orgRef: orgA.id, name: 'AmbAttached' }, ctxOf(admin.id));
    const { claim, ids } = await twoClaimants();
    const withAlias = await refusal(M.updateAgent({}, { ref: a.id, systemMemoryRef: claim }, ctxOf(admin.id)));
    await clear(ids);
    const without = await refusal(M.updateAgent({}, { ref: a.id, systemMemoryRef: claim }, ctxOf(admin.id)));
    expect(codeOf(withAlias)).toBe('BAD_USER_INPUT');
    expect(withAlias.message).toMatch(/Cannot unset or change/);
    expect(withAlias.message).toBe(without.message);
  });
});
