/**
 * #3238 (#1522 S3 residual) — differential proofs for the four cross-parent manifest rows that were
 * `open`: `ScopeMemoryEntry.memory`, `ScopeExplanation.memories`, `ScopeExplanation.winner` (the scope
 * lens, cor:acl:120:01) and `CompiledBootPrompt.node` (cor:acl:110:02).
 *
 * Each test asks the SAME principal two questions and compares the answers: what the nested field
 * returns, and what the direct read of that same object returns (`Query.memory` for a Memory,
 * `Query.node` for a Node). The claim proved is: the nested field never returns an object its
 * principal's direct read refuses. A lens never grants (cor:acl:120:01), so the converse is not
 * claimed: a memory the lens drops while the direct read admits it is a narrower answer, not a leak.
 * An unreadable memory the scope names is only ever a count (`droppedCount`), never a Memory object.
 *
 * Classification, not authorization: these pins show the nested field cannot exceed the direct read
 * for the principals and memory kinds below; they do not prove every principal.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

const Q = resolvers.Query as any;
const S = (resolvers as any).Scope;

type Who = { name: string; ctx: Context };
let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let contributor: { id: string };
let reader: { id: string };
let stranger: { id: string };
let admin: { id: string };
let scopeId: string;
let scopeUrn: string;
const mems: Record<string, { id: string; urn: string }> = {};
let principals: Who[];

const mkCtx = (userId: string | undefined, roles: Context['roles'] = ['READER']): Context => ({ db, userId, roles }) as Context;

async function mkMemory(slug: string, org: { id: string; urn: string } | null, data: Record<string, unknown>) {
  const m = await db.memory.create({
    data: { id: generateId(), urn: `${org?.urn ?? 'free'}:${slug}`, name: slug, organizationId: org?.id ?? null, ...data } as any,
  });
  mems[slug] = { id: m.id, urn: m.urn };
  return m;
}

beforeEach(async () => {
  await cleanDb(db);
  const t = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  orgA = await db.organization.create({ data: { id: generateId(), name: 'cp-a', urn: `cp-a-${t}` } });
  orgB = await db.organization.create({ data: { id: generateId(), name: 'cp-b', urn: `cp-b-${t}` } });
  contributor = await db.user.create({ data: { id: generateId(), githubId: 58101, githubUsername: `cp-contrib-${t}` } });
  reader = await db.user.create({ data: { id: generateId(), githubId: 58102, githubUsername: `cp-reader-${t}` } });
  stranger = await db.user.create({ data: { id: generateId(), githubId: 58103, githubUsername: `cp-stranger-${t}` } });
  admin = await db.user.create({ data: { id: generateId(), githubId: 58104, githubUsername: `cp-admin-${t}` } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgA.id, userId: contributor.id, role: 'CONTRIBUTOR' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgA.id, userId: reader.id, role: 'READER' } });
  await db.orgMember.create({ data: { id: generateId(), organizationId: orgB.id, userId: stranger.id, role: 'CONTRIBUTOR' } });
  const app = await db.app.create({ data: { id: generateId(), organizationId: orgA.id, name: 'cp app', urn: `${orgA.urn}:app` } });
  const agent = await db.agent.create({ data: { id: generateId(), organizationId: orgA.id, name: 'cp agent', urn: `${orgA.urn}:agent`, visibility: 'ORGANIZATION' } });
  await db.appAgent.create({ data: { appId: app.id, agentId: agent.id } });

  // The scope's memories, in order. Each kind is one where the record gate and the lens gate could differ.
  await mkMemory('org-knowledge', orgA, { class: 'knowledge', visibility: 'ORGANIZATION' });
  await mkMemory('foreign-org', orgB, { class: 'knowledge', visibility: 'ORGANIZATION' });
  await mkMemory('contrib-personal', orgA, { class: 'personal', userId: contributor.id, appId: app.id, userMemoryOfAgentId: agent.id });
  await mkMemory('reader-private', orgA, { class: 'private', userId: reader.id, appId: app.id, userMemoryOfAgentId: agent.id });
  await mkMemory('user-owned', null, { class: 'knowledge', ownerUserId: contributor.id });
  await mkMemory('org-system', orgA, { class: 'system' });
  await mkMemory('org-group', orgA, { class: 'group' });
  await mkMemory('app-class', orgA, { class: 'app', appId: app.id });
  const deleted = await mkMemory('deleted', orgA, { class: 'knowledge', visibility: 'ORGANIZATION' });
  await db.memory.update({ where: { id: deleted.id }, data: { deletedAt: new Date() } });

  const scope = await db.scope.create({ data: { id: generateId(), name: 'lens', organizationId: orgA.id } as any });
  scopeId = scope.id;
  scopeUrn = (scope as any).urn ?? scope.id;
  const order = ['foreign-org', 'contrib-personal', 'reader-private', 'user-owned', 'org-system', 'org-group', 'app-class', 'deleted', 'org-knowledge'];
  for (const [i, slug] of order.entries()) {
    await db.scopeMemory.create({ data: { scopeId, memoryId: mems[slug]!.id, position: i } as any });
    // One node at the same loc in every memory, so `winner` has to choose among them.
    await db.node.create({ data: { id: generateId(), memoryId: mems[slug]!.id, loc: 'shared:loc', name: slug, content: slug } });
  }

  // A real Agent system memory is bound to its Agent (`systemMemoryId`); an unbound system-class row is not a shaped
  // state, and the record gate (system memories follow their Agent's grants) answers it differently.
  await db.agent.update({ where: { id: agent.id }, data: { systemMemoryId: mems['org-system']!.id } });
  principals = [
    { name: 'contributor', ctx: mkCtx(contributor.id, ['CONTRIBUTOR']) },
    { name: 'reader', ctx: mkCtx(reader.id) },
    { name: 'stranger (other org)', ctx: mkCtx(stranger.id, ['CONTRIBUTOR']) },
    { name: 'platform admin', ctx: mkCtx(admin.id, ['ADMIN']) },
  ];
});

const direct = async (who: Who, id: string) => (await Q.memory({}, { ref: id }, who.ctx)) != null;
const ids = (names: string[]) => names.map((n) => mems[n]!.id);
const explain = (who: Who, loc?: string) => Q.scopeExplain({}, { scopeRef: scopeId, ...(loc ? { loc } : {}) }, who.ctx);
const who = (name: string) => principals.find((p) => p.name === name)!;

describe('#3238 scope lens: ScopeExplanation.memories, .winner and ScopeMemoryEntry.memory never exceed the direct read', () => {
  it('every Memory the lens returns is one the same principal reads directly (cor:acl:120:01)', async () => {
    for (const p of principals) {
      const ex = await explain(p, 'shared:loc');
      if (!ex) continue; // a principal with no read of the scope gets null, asserted below
      const entries = await S.memories({ id: scopeId }, {}, p.ctx);
      const returned = [
        ...ex.memories.map((m: any) => m.id),
        ...(ex.winner ? [ex.winner.id] : []),
        ...entries.map((e: any) => e.memory.id),
      ];
      expect(returned.length, p.name).toBeGreaterThan(0);
      for (const id of returned) expect(await direct(p, id), `${p.name} was handed memory ${id} its direct read refuses`).toBe(true);
    }
  });

  it('for an ordinary member the lens is exactly the direct read, in scope order', async () => {
    const live = ['foreign-org', 'contrib-personal', 'reader-private', 'user-owned', 'org-system', 'org-group', 'app-class', 'org-knowledge'];
    for (const name of ['contributor', 'reader']) {
      const p = who(name);
      const ex = await explain(p);
      const expected: string[] = [];
      for (const slug of live) if (await direct(p, mems[slug]!.id)) expected.push(mems[slug]!.id);
      expect(ex.memories.map((m: any) => m.id), name).toEqual(expected);
      expect((await S.memories({ id: scopeId }, {}, p.ctx)).map((e: any) => e.memory.id), `${name} entries`).toEqual(expected);
    }
  });

  it('a memory the caller cannot read is a count only: never a Memory object, and the tombstone is gone for everyone', async () => {
    const reader = who('reader');
    const ex = await explain(reader, 'shared:loc');
    expect(ex.memories.map((m: any) => m.id)).toEqual(ids(['reader-private', 'org-knowledge']));
    expect(ex.droppedCount).toBe(6);
    expect(ex.memories.map((m: any) => m.id)).not.toContain(mems['deleted']!.id);
    expect(JSON.stringify(ex)).not.toContain(mems['foreign-org']!.urn);
    expect(JSON.stringify(ex)).not.toContain(mems['contrib-personal']!.urn);
  });

  it('a platform admin is not handed ANOTHER user\'s personal, private or user-owned memory, and its direct read refuses the same ones', async () => {
    const admin = who('platform admin');
    const ex = await explain(admin, 'shared:loc');
    const returned = ex.memories.map((m: any) => m.id);
    for (const slug of ['contrib-personal', 'reader-private', 'user-owned']) {
      expect(returned, slug).not.toContain(mems[slug]!.id);
      expect(await direct(admin, mems[slug]!.id), `${slug} direct`).toBe(false);
    }
    // The personal memory sits earlier in the order than the winner's memory, so a gate that let it through would win.
    expect(ex.winner.id).toBe(mems['foreign-org']!.id);
    expect(await direct(admin, ex.winner.id)).toBe(true);
  });

  it('the winner skips an unreadable memory that holds the loc earlier in the order', async () => {
    // contrib-personal (position 1) and reader-private (position 2) both hold the loc; the reader may read only its own.
    const reader = who('reader');
    expect((await explain(reader, 'shared:loc')).winner.id).toBe(mems['reader-private']!.id);
    // The contributor reads its personal memory, which then wins by order.
    expect((await explain(who('contributor'), 'shared:loc')).winner.id).toBe(mems['contrib-personal']!.id);
  });

  it('a principal with no read of the scope gets null, the same as a missing scope', async () => {
    expect(await explain(who('stranger (other org)'), 'shared:loc')).toBeNull();
    expect(await Q.scopeExplain({}, { scopeRef: generateId() }, who('stranger (other org)').ctx)).toBeNull();
  });
});

describe('#3238 CompiledBootPrompt.node is a node its compiling principal reads directly (cor:acl:110:02)', () => {
  const compile = (ctx: Context) => (resolvers.Mutation as any).compileAgentBootPrompt({}, { agentRef: `${orgA.urn}:agent`, setPointer: false }, ctx);
  const directNode = async (ctx: Context, id: string) => (await Q.node({}, { ref: id }, ctx)) != null;

  beforeEach(async () => {
    await db.node.create({ data: { id: generateId(), memoryId: mems['org-system']!.id, loc: 'boot:source', name: 'src', content: 'hi', role: 'boot-prompt' } });
  });

  it('every principal whose compile succeeds reads the returned node directly, and it is the node in the compile memory', async () => {
    const orgAdmin = await db.user.create({ data: { id: generateId(), githubId: 58110, githubUsername: `cp-orgadmin-${Date.now()}` } });
    await db.orgMember.create({ data: { id: generateId(), organizationId: orgA.id, userId: orgAdmin.id, role: 'ADMIN' } });
    const compilers: Who[] = [
      { name: 'org admin', ctx: mkCtx(orgAdmin.id, []) },
      { name: 'platform admin', ctx: mkCtx(admin.id, ['ADMIN']) },
    ];
    const compiled: string[] = [];
    for (const p of compilers) {
      let out: any;
      try { out = await compile(p.ctx); } catch (e) {
        // A refusal hands the caller no node, so nothing to compare.
        expect((e as any).extensions?.code, p.name).toBe('BOOT_PROMPT_COMPILE_NOT_PERMITTED');
        continue;
      }
      compiled.push(p.name);
      expect(out.node.memoryId, p.name).toBe(mems['org-system']!.id);
      expect(await directNode(p.ctx, out.node.id), `${p.name} compiled a node its direct read refuses`).toBe(true);
    }
    expect(compiled, 'the org admin manages the Agent, so the comparison is not vacuous').toContain('org admin');
  });

  it('a principal who may not compile is refused, so no node is handed to a caller whose direct read would refuse it', async () => {
    for (const name of ['reader', 'stranger (other org)']) {
      await expect(compile(who(name).ctx), name).rejects.toMatchObject({ extensions: { code: 'BOOT_PROMPT_COMPILE_NOT_PERMITTED' } });
    }
  });
});
