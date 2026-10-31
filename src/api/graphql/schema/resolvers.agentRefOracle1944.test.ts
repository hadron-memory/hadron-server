/**
 * #1944 — the Agent surfaces must not tell a caller who cannot READ an Agent
 * whether it exists (the Agent-side sibling of #1742 / #1939).
 *
 * Every surface resolved an Agent ref and then gated the resolved row. A
 * caller who can't read a non-PUBLIC Agent was refused FORBIDDEN, while an
 * absent Agent answered AGENT_NOT_FOUND (or null, for `Query.agent`), so
 * guessing `hrn:agent:<org>:<slug>` and reading the answer enumerated another
 * tenant's Agents (Cameron's repro on setAgentBase; Xylon's gate found the
 * other four). Now a caller who can't read the Agent gets the absent Agent's
 * answer exactly. FORBIDDEN stays for a caller who CAN read it and may not
 * manage it, including anyone at all on a PUBLIC Agent, whose existence is
 * public by design.
 *
 * Envelopes are read off the GraphQL WIRE (a real request through the
 * server's own `formatGraphQLError`), since a not-found's code is attached
 * there. The same-ref pins compare one ref before and after its Agent is
 * deleted, so "identical" covers every byte, the echoed ref included.
 */

import { ApolloServer } from '@apollo/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { formatGraphQLError } from '../formatError.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const graphql = new ApolloServer<Context>({ typeDefs, resolvers, formatError: formatGraphQLError });

/** What a client receives: the data field, and the error's message and extensions (no dev-only stacktrace). */
type Answer = { data: unknown; error: { message: string; extensions: Record<string, unknown> } | null };

async function ask(c: Context, query: string, ref: string): Promise<Answer> {
  const res = await graphql.executeOperation({ query, variables: { ref } }, { contextValue: c });
  if (res.body.kind !== 'single') throw new Error('unexpected incremental response');
  const { data, errors } = res.body.singleResult;
  const e = errors?.[0];
  const { stacktrace: _drop, ...extensions } = (e?.extensions ?? {}) as Record<string, unknown>;
  return { data: data ? Object.values(data)[0] ?? null : null, error: e ? { message: e.message, extensions } : null };
}

/** The five surfaces, each as the GraphQL request a client sends. */
const SURFACES: Array<[string, string]> = [
  ['updateAgent', 'mutation($ref: ID!) { updateAgent(ref: $ref, description: "x") { id } }'],
  ['deleteAgent', 'mutation($ref: ID!) { deleteAgent(ref: $ref) }'],
  ['setAgentBase', 'mutation($ref: ID!) { setAgentBase(ref: $ref, baseRef: null) { id } }'],
  ['setAgentIndexRefs', 'mutation($ref: ID!) { setAgentIndexRefs(ref: $ref, tasksIndexRef: null) { id } }'],
  ['Query.agent', 'query($ref: ID!) { agent(ref: $ref) { id } }'],
];
const MUTATIONS = SURFACES.filter(([s]) => s !== 'Query.agent');

/** An absent Agent's answer on each surface: AGENT_NOT_FOUND echoing the ref, or null with no error. */
const absentAnswer = (surface: string, ref: string): Answer => surface === 'Query.agent'
  ? { data: null, error: null }
  : { data: null, error: { message: `AGENT_NOT_FOUND: ${ref}`, extensions: { code: 'AGENT_NOT_FOUND', ref } } };

let orgA: { id: string; urn: string };
let orgB: { id: string; urn: string };
let admin: string;
let member: string;
let outsider: string;
let foreignAdmin: string;
let foreignApp: string;
let secret: { id: string; urn: string };
let pub: { id: string; urn: string };

const ctx = (userId?: string, extra: Partial<Context> = {}): Context => ({ db, userId, roles: ['READER'], ...extra });
const urnOf = (a: { urn: string }) => `hrn:agent:${a.urn}`;
const nobody = () => `hrn:agent:${orgA.urn}:nobody`;

async function user(handle: string): Promise<string> {
  return (await db.user.create({ data: { id: generateId(), name: handle, handle: `${handle}-${generateId().slice(-6)}`, roles: ['READER'] } })).id;
}

async function orgAgent(slug: string, visibility: 'ORGANIZATION' | 'PUBLIC') {
  const mem = await db.memory.create({ data: { class: 'system', organizationId: orgA.id, name: `${slug} system`, urn: `${orgA.urn}:${slug}-system` } });
  const a = await db.agent.create({ data: { organizationId: orgA.id, name: slug, urn: `${orgA.urn}:${slug}`, visibility, systemMemoryId: mem.id } });
  return { id: a.id, urn: a.urn };
}

/** Principals who cannot read orgA's non-PUBLIC Agent. */
const OUTSIDERS: Array<[string, () => Context]> = [
  ['a signed-in user with no membership', () => ctx(outsider)],
  ["another org's ADMIN", () => ctx(foreignAdmin)],
  ["another org's App key", () => ({ db, roles: [], appId: foreignApp } as Context)],
];

beforeEach(async () => {
  await cleanDb(db);
  const n = generateId().slice(-8);
  orgA = await db.organization.create({ data: { name: 'A', urn: `oracle-a-${n}.example` }, select: { id: true, urn: true } });
  orgB = await db.organization.create({ data: { name: 'B', urn: `oracle-b-${n}.example` }, select: { id: true, urn: true } });
  admin = await user('admin');
  member = await user('member');
  outsider = await user('outsider');
  foreignAdmin = await user('foreign-admin');
  await db.orgMember.create({ data: { organizationId: orgA.id, userId: admin, role: 'ADMIN' } });
  await db.orgMember.create({ data: { organizationId: orgA.id, userId: member, role: 'READER' } });
  await db.orgMember.create({ data: { organizationId: orgB.id, userId: foreignAdmin, role: 'ADMIN' } });
  foreignApp = (await db.app.create({ data: { organizationId: orgB.id, name: 'Elsewhere', urn: `${orgB.urn}:elsewhere` } })).id;
  secret = await orgAgent('secret', 'ORGANIZATION');
  pub = await orgAgent('public', 'PUBLIC');
});

describe('#1944 the oracle is closed: an unreadable Agent answers like an absent one', () => {
  for (const [surface, query] of SURFACES) {
    for (const [who, as] of OUTSIDERS) {
      it(`${surface}, ${who}: a real Agent and a guessed one get the same answer`, async () => {
        expect(await ask(as(), query, nobody())).toEqual(absentAnswer(surface, nobody()));
        // The only difference is the echoed ref, which the caller supplied.
        expect(await ask(as(), query, urnOf(secret))).toEqual(absentAnswer(surface, urnOf(secret)));
      });
    }

    it(`${surface}: the same ref answers byte-identically before and after its Agent is deleted`, async () => {
      const before = await ask(ctx(foreignAdmin), query, urnOf(secret));
      await db.agent.update({ where: { id: secret.id }, data: { deletedAt: new Date() } });
      const after = await ask(ctx(foreignAdmin), query, urnOf(secret));
      expect(JSON.stringify(before)).toBe(JSON.stringify(after));
    });

    it(`${surface}: the id form is closed too`, async () => {
      const absentId = generateId();
      expect(await ask(ctx(foreignAdmin), query, secret.id)).toEqual(absentAnswer(surface, secret.id));
      expect(await ask(ctx(foreignAdmin), query, absentId)).toEqual(absentAnswer(surface, absentId));
    });
  }

  it('nothing is written for a refused outsider', async () => {
    for (const [, query] of MUTATIONS) await ask(ctx(foreignAdmin), query, urnOf(secret));
    const row = await db.agent.findUniqueOrThrow({ where: { id: secret.id } });
    expect(row.deletedAt).toBeNull();
    expect(row.description).toBeNull();
  });
});

describe('#1944 the PUBLIC boundary, both ways', () => {
  it('a PUBLIC Agent is readable by anyone, so a foreign caller still gets FORBIDDEN on every mutation, and the query returns it', async () => {
    for (const [surface, query] of MUTATIONS) {
      const a = await ask(ctx(foreignAdmin), query, urnOf(pub));
      expect(a.error?.extensions.code, surface).toBe('FORBIDDEN');
    }
    expect((await ask(ctx(foreignAdmin), 'query($ref: ID!) { agent(ref: $ref) { id } }', urnOf(pub))).data).toEqual({ id: pub.id });
  });

  it('the same foreign caller on a non-PUBLIC Agent gets the absent answer instead', async () => {
    for (const [surface, query] of SURFACES) {
      expect(await ask(ctx(foreignAdmin), query, urnOf(secret)), surface).toEqual(absentAnswer(surface, urnOf(secret)));
    }
  });
});

describe('#1944 controls: readers keep their answers', () => {
  it('a member who can read the Agent but not manage it is still refused FORBIDDEN, which tells them nothing new', async () => {
    for (const [surface, query] of MUTATIONS) {
      expect((await ask(ctx(member), query, urnOf(secret))).error?.extensions.code, surface).toBe('FORBIDDEN');
    }
    expect((await ask(ctx(member), 'query($ref: ID!) { agent(ref: $ref) { id } }', urnOf(secret))).data).toEqual({ id: secret.id });
  });

  it('an absent Agent is still AGENT_NOT_FOUND (null for the query) to a member', async () => {
    for (const [surface, query] of SURFACES) {
      expect(await ask(ctx(member), query, nobody()), surface).toEqual(absentAnswer(surface, nobody()));
    }
  });

  it('the manager still makes every change', async () => {
    expect((await ask(ctx(admin), SURFACES[0]![1], urnOf(secret))).error).toBeNull();
    expect((await db.agent.findUniqueOrThrow({ where: { id: secret.id } })).description).toBe('x');
    expect((await ask(ctx(admin), SURFACES[2]![1], urnOf(secret))).error).toBeNull();
    expect((await ask(ctx(admin), SURFACES[3]![1], urnOf(secret))).error).toBeNull();
    expect((await ask(ctx(admin), SURFACES[1]![1], urnOf(secret))).data).toBe(true);
  });

  it('an under-qualified ref is still the caller\'s input error, not a not-found', async () => {
    for (const [surface, query] of SURFACES) {
      expect((await ask(ctx(foreignAdmin), query, 'secret')).error?.extensions.code, surface).toBe('URN_NOT_QUALIFIED');
    }
  });

  it('an outage inside the read gate propagates; it is never reported as a missing Agent', async () => {
    const down = () => { throw new Error('database unavailable'); };
    const broken = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'orgMember') return new Proxy({}, { get: () => down });
        return Reflect.get(target, prop, receiver);
      },
    }) as Context['db'];
    for (const [surface, query] of SURFACES) {
      const a = await ask({ db: broken, userId: foreignAdmin, roles: ['READER'] } as Context, query, urnOf(secret));
      expect(a.error?.extensions.code, surface).not.toBe('AGENT_NOT_FOUND');
      expect(a.data, surface).toBeNull();
      expect(a.error, surface).not.toBeNull();
    }
  });
});

/**
 * The sweep (Eden, #11795): every other surface that resolves an Agent ref and
 * then refuses on access to THAT Agent. A memory or import ref these take is
 * a live row the caller names, so the only thing varying is the Agent.
 */
const SWEEP: Array<[string, (agentRef: string) => { query: string; variables: Record<string, unknown> }]> = [
  ['addMemoryToAgent', (ref) => ({ query: 'mutation($ref: ID!, $mem: ID!) { addMemoryToAgent(agentRef: $ref, memoryRef: $mem, role: "read") { id } }', variables: { ref, mem: knowledge } })],
  ['updateAgentMemoryRole', (ref) => ({ query: 'mutation($ref: ID!, $mem: ID!) { updateAgentMemoryRole(agentRef: $ref, memoryRef: $mem, role: "read") { id } }', variables: { ref, mem: knowledge } })],
  ['removeMemoryFromAgent', (ref) => ({ query: 'mutation($ref: ID!, $mem: ID!) { removeMemoryFromAgent(agentRef: $ref, memoryRef: $mem) { id } }', variables: { ref, mem: knowledge } })],
  ['createRevision', (ref) => ({ query: 'mutation($ref: ID!) { createRevision(agentId: $ref) { revisionLoc } }', variables: { ref } })],
  ['publishRevision', (ref) => ({ query: 'mutation($ref: ID!) { publishRevision(agentId: $ref, revisionLoc: "revisions:r1") { revisionLoc } }', variables: { ref } })],
  ['restoreRevision', (ref) => ({ query: 'mutation($ref: ID!) { restoreRevision(agentId: $ref, revisionLoc: "revisions:r1") { revisionLoc } }', variables: { ref } })],
  ['acquireEditorLock', (ref) => ({ query: 'mutation($ref: ID!) { acquireEditorLock(agentId: $ref) { locked } }', variables: { ref } })],
  ['releaseEditorLock', (ref) => ({ query: 'mutation($ref: ID!) { releaseEditorLock(agentId: $ref) }', variables: { ref } })],
  ['agentAIConfig', (ref) => ({ query: 'query($ref: ID!) { agentAIConfig(agentRef: $ref) { provider } }', variables: { ref } })],
  ['agentSubscriptions', (ref) => ({ query: 'query($ref: ID!) { agentSubscriptions(agentRef: $ref) { agentId } }', variables: { ref } })],
  ['publishAgentImport', (ref) => ({ query: 'mutation($ref: ID!, $imp: ID!) { publishAgentImport(parentAgentRef: $ref, importedAgentRef: $imp, position: 0) { parentAgentId } }', variables: { ref, imp: urnOf(pub) } })],
];

let knowledge: string;

async function askWith(c: Context, req: { query: string; variables: Record<string, unknown> }): Promise<Answer> {
  const res = await graphql.executeOperation(req, { contextValue: c });
  if (res.body.kind !== 'single') throw new Error('unexpected incremental response');
  const { data, errors } = res.body.singleResult;
  const e = errors?.[0];
  const { stacktrace: _drop, ...extensions } = (e?.extensions ?? {}) as Record<string, unknown>;
  return { data: data ? Object.values(data)[0] ?? null : null, error: e ? { message: e.message, extensions } : null };
}

/** An answer with the caller-supplied ref masked, so a real and a guessed Agent compare whole. */
const masked = (a: Answer, ref: string) => JSON.parse(JSON.stringify(a).split(ref).join('<ref>'));

describe('#1944 the sweep: every surface gated on the Agent answers an unreadable one as absent', () => {
  beforeEach(async () => {
    knowledge = (await db.memory.create({ data: { class: 'knowledge', organizationId: orgB.id, name: 'Theirs', urn: `${orgB.urn}:theirs` } })).id;
  });

  for (const [surface, req] of SWEEP) {
    it(`${surface}: another org's ADMIN gets exactly AGENT_NOT_FOUND for a real Agent and a guessed one`, async () => {
      expect(await askWith(ctx(foreignAdmin), req(nobody()))).toEqual(absentAnswer(surface, nobody()));
      expect(await askWith(ctx(foreignAdmin), req(urnOf(secret)))).toEqual(absentAnswer(surface, urnOf(secret)));
    });

    for (const [who, as] of OUTSIDERS) {
      it(`${surface}, ${who}: a real Agent and a guessed one read the same`, async () => {
        expect(masked(await askWith(as(), req(urnOf(secret))), urnOf(secret)))
          .toEqual(masked(await askWith(as(), req(nobody())), nobody()));
      });
    }

    it(`${surface}: the same ref answers byte-identically before and after its Agent is deleted`, async () => {
      const before = await askWith(ctx(foreignAdmin), req(urnOf(secret)));
      await db.agent.update({ where: { id: secret.id }, data: { deletedAt: new Date() } });
      const after = await askWith(ctx(foreignAdmin), req(urnOf(secret)));
      expect(JSON.stringify(before)).toBe(JSON.stringify(after));
    });

    it(`${surface}: the PUBLIC boundary holds — a foreign caller on a PUBLIC Agent still gets FORBIDDEN`, async () => {
      expect((await askWith(ctx(foreignAdmin), req(urnOf(pub)))).error?.extensions.code).toBe('FORBIDDEN');
    });

    it(`${surface}: a member who can read but not manage still gets FORBIDDEN`, async () => {
      expect((await askWith(ctx(member), req(urnOf(secret)))).error?.extensions.code).toBe('FORBIDDEN');
    });

    it(`${surface}: an outage inside the read gate propagates`, async () => {
      const down = () => { throw new Error('database unavailable'); };
      const broken = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === 'orgMember') return new Proxy({}, { get: () => down });
          return Reflect.get(target, prop, receiver);
        },
      }) as Context['db'];
      const a = await askWith({ db: broken, userId: foreignAdmin, roles: ['READER'] } as Context, req(urnOf(secret)));
      expect(a.error).not.toBeNull();
      expect(a.error?.extensions.code).not.toBe('AGENT_NOT_FOUND');
    });
  }
});

describe('#1944 startSession\'s optional agentRef: an unreadable Agent answers like an absent one', () => {
  const start = (ref: string) => ({
    query: 'mutation($input: SessionInput!) { startSession(input: $input) { id } }',
    variables: { input: { id: generateId(), agentRef: ref } },
  });
  const absent = (ref: string): Answer => ({ data: null, error: { message: `Agent not found: ${ref}`, extensions: { code: 'BAD_USER_INPUT' } } });

  it('another org\'s ADMIN gets exactly the absent answer for a real Agent and a guessed one, and no session is written', async () => {
    expect(await askWith(ctx(foreignAdmin), start(nobody()))).toEqual(absent(nobody()));
    expect(await askWith(ctx(foreignAdmin), start(urnOf(secret)))).toEqual(absent(urnOf(secret)));
    expect(await db.session.count({ where: { userId: foreignAdmin } })).toBe(0);
  });

  it('the same ref answers byte-identically before and after its Agent is deleted', async () => {
    const before = await askWith(ctx(foreignAdmin), start(urnOf(secret)));
    await db.agent.update({ where: { id: secret.id }, data: { deletedAt: new Date() } });
    expect(JSON.stringify(await askWith(ctx(foreignAdmin), start(urnOf(secret))))).toBe(JSON.stringify(before));
  });

  it('controls: a PUBLIC Agent attaches for anyone; a member attaches the org\'s Agent', async () => {
    expect((await askWith(ctx(foreignAdmin), start(urnOf(pub)))).error).toBeNull();
    expect((await askWith(ctx(member), start(urnOf(secret)))).error).toBeNull();
  });
});

/**
 * Group A (Eden, #11808): the remaining surfaces gated on the Agent itself.
 * revokeAgentSubscription answers an absent Agent with resolveRefArg's own
 * envelope, so a denied one must get that same envelope; the rest answer
 * AGENT_NOT_FOUND.
 */
const GROUP_A: Array<[string, (agentRef: string) => { query: string; variables: Record<string, unknown> }, (ref: string) => Answer]> = [
  ['revokeAgentSubscription',
    (ref) => ({ query: 'mutation($ref: String, $user: String) { revokeAgentSubscription(agentRef: $ref, userRef: $user) { agentId } }', variables: { ref, user: member } }),
    (ref) => ({ data: null, error: { message: `No match for agentRef "${ref}".`, extensions: { code: 'NOT_FOUND' } } })],
  ['removeAgentImport',
    (ref) => ({ query: 'mutation($ref: ID!, $imp: ID!) { removeAgentImport(parentAgentRef: $ref, importedAgentRef: $imp) }', variables: { ref, imp: urnOf(pub) } }),
    (ref) => absentAnswer('removeAgentImport', ref)],
  ['createAiServiceConfig (AGENT owner)',
    (ref) => ({ query: 'mutation($ref: ID!) { createAiServiceConfig(ownerType: AGENT, ownerId: $ref, name: "probe", provider: "anthropic", model: "m") { id } }', variables: { ref } }),
    (ref) => absentAnswer('createAiServiceConfig', ref)],
  ['aiServiceConfigs (AGENT owner)',
    (ref) => ({ query: 'query($ref: ID!) { aiServiceConfigs(filter: { ownerType: AGENT, ownerId: $ref }) { total } }', variables: { ref } }),
    (ref) => absentAnswer('aiServiceConfigs', ref)],
  ['updateAgentAIConfig',
    (ref) => ({ query: 'mutation($ref: ID!) { updateAgentAIConfig(agentId: $ref, provider: "anthropic", apiKey: "sk-probe", model: "m") { id } }', variables: { ref } }),
    (ref) => absentAnswer('updateAgentAIConfig', ref)],
  ['clearAgentAIConfig',
    (ref) => ({ query: 'mutation($ref: ID!) { clearAgentAIConfig(agentId: $ref) { id } }', variables: { ref } }),
    (ref) => absentAnswer('clearAgentAIConfig', ref)],
  ['createScope (agent owner)',
    (ref) => ({ query: 'mutation($ref: ID!) { createScope(input: { name: "probe", agentRef: $ref, memoryRefs: [] }) { id } }', variables: { ref } }),
    (ref) => absentAnswer('createScope', ref)],
  ['resolveAIConfig (agentRef, no appRef)',
    (ref) => ({ query: 'query($ref: ID!) { resolveAIConfig(agentRef: $ref) { configId } }', variables: { ref } }),
    (ref) => absentAnswer('resolveAIConfig', ref)],
];

describe('#1944 group A: the remaining surfaces gated on the Agent answer an unreadable one as absent', () => {
  for (const [surface, req, absent] of GROUP_A) {
    it(`${surface}: another org's ADMIN gets exactly the absent answer for a real Agent and a guessed one`, async () => {
      expect(await askWith(ctx(foreignAdmin), req(nobody()))).toEqual(absent(nobody()));
      expect(await askWith(ctx(foreignAdmin), req(urnOf(secret)))).toEqual(absent(urnOf(secret)));
    });

    for (const [who, as] of OUTSIDERS) {
      it(`${surface}, ${who}: a real Agent and a guessed one read the same`, async () => {
        expect(masked(await askWith(as(), req(urnOf(secret))), urnOf(secret)))
          .toEqual(masked(await askWith(as(), req(nobody())), nobody()));
      });
    }

    it(`${surface}: the same ref answers byte-identically before and after its Agent is deleted`, async () => {
      const before = await askWith(ctx(foreignAdmin), req(urnOf(secret)));
      await db.agent.update({ where: { id: secret.id }, data: { deletedAt: new Date() } });
      expect(JSON.stringify(await askWith(ctx(foreignAdmin), req(urnOf(secret))))).toBe(JSON.stringify(before));
    });

    it(`${surface}: a foreign caller on a PUBLIC Agent, and a member who can read but not manage, still get FORBIDDEN`, async () => {
      expect((await askWith(ctx(foreignAdmin), req(urnOf(pub)))).error?.extensions.code).toBe('FORBIDDEN');
      expect((await askWith(ctx(member), req(urnOf(secret)))).error?.extensions.code).toBe('FORBIDDEN');
    });

    it(`${surface}: an outage inside the read gate propagates`, async () => {
      const down = () => { throw new Error('database unavailable'); };
      const broken = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop === 'orgMember') return new Proxy({}, { get: () => down });
          return Reflect.get(target, prop, receiver);
        },
      }) as Context['db'];
      const a = await askWith({ db: broken, userId: foreignAdmin, roles: ['READER'] } as Context, req(urnOf(secret)));
      expect(a.error).not.toBeNull();
      expect(a.error?.extensions.code).not.toBe('AGENT_NOT_FOUND');
      expect(a.error?.extensions.code).not.toBe('NOT_FOUND');
    });
  }
});

/**
 * Atilla's P2 on #1950: Query.agent must serve the row it authorized. A
 * PUBLIC Agent flipped to ORGANIZATION with a new private prompt between two
 * reads must never reach a foreign reader: they get either null or the PUBLIC
 * version they were admitted to, never the newly private one.
 */
describe('#1944 Query.agent serves only the row it authorized (Atilla\'s P2 on #1950)', () => {
  it('a PUBLIC→ORGANIZATION flip with a new private prompt right after the first read never leaks the private version', async () => {
    await db.agent.update({ where: { id: pub.id }, data: { description: 'PUBLIC prompt' } });
    let flipped = false;
    const racy = new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== 'agent') return typeof value === 'function' ? value.bind(target) : value;
        return new Proxy(value, {
          get(t, p) {
            const fn = Reflect.get(t, p);
            if (p !== 'findUnique') return typeof fn === 'function' ? fn.bind(t) : fn;
            return async (args: unknown) => {
              const out = await fn.call(t, args);
              if (!flipped) {
                flipped = true;
                await db.agent.update({ where: { id: pub.id }, data: { visibility: 'ORGANIZATION', description: 'PRIVATE marker' } });
              }
              return out;
            };
          },
        });
      },
    }) as Context['db'];
    const a = await ask({ db: racy, userId: foreignAdmin, roles: ['READER'] } as Context,
      'query($ref: ID!) { agent(ref: $ref) { id visibility description } }', urnOf(pub));
    expect(flipped).toBe(true);
    expect(JSON.stringify(a)).not.toContain('PRIVATE marker');
    if (a.data !== null) expect((a.data as { visibility: string }).visibility).toBe('PUBLIC');
  });
});
