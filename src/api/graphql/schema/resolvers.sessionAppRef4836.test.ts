/**
 * #4836 — startSession's appRef refusals conceal reach and echo.
 *
 * The contract under test is cor:dmo:070:05's Proposed clause (V58's partition,
 * the one cor:api:140:02 records for `updateApp`): a caller WITHOUT standing
 * gets ONE answer for an App ref — APP_NOT_FOUND, "App not found." — whether
 * the App is missing, deleted, uninstalled, malformed/ambiguous as a ref, or
 * existing but inaccessible, and whether the caller is an outsider, anonymous,
 * a hybrid user whose MCP selection names an App they never joined, or a pure
 * App key naming any other App. The answer echoes no value the caller sent
 * (a token pasted into appRef must not land in a terminal or error tracker)
 * and carries no appId. A caller WITH standing keeps the specific answers:
 * APP_UNINSTALLED by PK with the appId their own ref resolved to.
 *
 * Every concealed row asserts the FULL serialized envelope is byte-identical
 * (`{"message":"App not found.","extensions":{"code":"APP_NOT_FOUND"}}`) —
 * same code, same message, no extra extension keys — and that the caller's
 * ref, the App's PK and the canary appear nowhere in it.
 *
 * Member rows are regression pins (green on main): the concealment must not
 * swallow a member's answers. The V58 exception (a caller with reach keeps an
 * authorization refusal) is pinned on the launch-grant path, the one place
 * this mutation still refuses a caller it already told the worker exists.
 *
 * Red-first note (#4844 fold, LOCAL F2): these pins and the implementation
 * landed in one commit (78af34826), so history cannot show the pins red. The
 * rerun: with this file held and the production change reverted
 * (reverse-apply the production hunks of aac9cd966 and 78af34826 to
 * resolvers.mutation.session.ts), 24 of 31 pins fail (re-measured 2026-11-23,
 * #4853; the 21 of 28 recorded before it was exact for the 28 `it` blocks
 * on main then, and #4853 added three member-side pins, all red); the 7 that
 * pass are the member regression pins, which are green on main by design.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError, buildSchema, defaultFieldResolver, graphql } from 'graphql';
import { createHash } from 'node:crypto';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { generateId } from '../../../lib/id.js';
import { WORKER_SIGNATURE_DEFAULTS } from '../../../lib/workerSignature.js';
import { SHAPE_HADRON_START_SESSION } from '../../../mcp/toolShapes.js';
import { startSessionAppRefRefusal } from './resolvers.mutation.session.js';
import { resolvers, type Context } from './resolvers.js';
import { typeDefs } from './typeDefs.js';
import { formatGraphQLError } from '../formatError.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;

function ctx(userId?: string, appId?: string): Context {
  return { db, userId, appId, roles: ['READER'] };
}

const startSession = (c: Context, input: Record<string, unknown>) =>
  M.startSession({}, { input: { id: generateId(), tool: 'claude-code', ...input } }, c);

/** The one concealed envelope, byte-identical everywhere (#3977's shared V58 answer). */
const CONCEALED = '{"message":"App not found.","extensions":{"code":"APP_NOT_FOUND"}}';

/**
 * Asserts `p` refuses with EXACTLY the concealed envelope — message and the
 * whole extensions object serialize to the same bytes — and that none of
 * `secrets` (the ref, a PK, the canary) appears anywhere in the serialization.
 */
async function concealedRefusal(p: Promise<unknown>, secrets: string[] = []): Promise<void> {
  try {
    await p;
    expect.fail('expected the concealed unknown-App refusal');
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    const g = e as GraphQLError;
    const blob = JSON.stringify({ message: g.message, extensions: g.extensions });
    expect(blob).toBe(CONCEALED);
    for (const s of secrets) {
      expect(blob.includes(s), `the refusal leaks "${s}"`).toBe(false);
    }
  }
}

const CANARY = 'hdr_canary_SECRET_0123456789abcdef';

let org: { id: string; urn: string };
let admin: { id: string };
let appMember: { id: string };
let outsider: { id: string; handle: string };
let teamAgent: { id: string };
let app: { id: string; urn: string };
let otherApp: { id: string; urn: string };

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'sar4836-org', urn: `sar4836-${suffix}.com` },
  });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 9483601, githubUsername: `sar4836-admin-${suffix}`, roles: ['READER'] },
  });
  appMember = await db.user.create({
    data: { id: generateId(), githubId: 9483602, githubUsername: `sar4836-member-${suffix}`, roles: ['READER'] },
  });
  outsider = await db.user.create({
    data: {
      id: generateId(),
      githubId: 9483603,
      githubUsername: `sar4836-outsider-${suffix}`,
      handle: `sar4836-outsider-${suffix}`.replace(/[^a-z0-9-]/gi, '-'),
      roles: ['READER'],
    },
    select: { id: true, handle: true },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });
  const created = await M.createAgent({}, { orgRef: org.id, name: 'Team Agent', personaRole: 'test-worker' }, ctx(admin.id));
  teamAgent = { id: created.id };
  app = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'Team App', urn: `${org.urn}:team` },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: teamAgent.id } });
  await db.appMember.create({ data: { appId: app.id, userId: appMember.id, role: 'reader' } });
  otherApp = await db.app.create({
    data: { id: generateId(), organizationId: org.id, name: 'Other App', urn: `${org.urn}:other` },
  });
  await serveEveryAgent(db); // #2712: binds are served the Agent's boot prompt
});

describe('#4836 — one concealed refusal for every no-standing shape', () => {
  it('a signed-in non-member gets the same bytes for a missing App by URN', async () => {
    const ref = `${org.urn}:no-such-app`;
    await concealedRefusal(startSession(ctx(outsider.id), { appRef: `hrn:app:${ref}` }), [`hrn:app:${ref}`]);
  });

  it('…for a missing App by PK', async () => {
    const ref = 'c' + 'a'.repeat(24);
    await concealedRefusal(startSession(ctx(outsider.id), { appRef: ref }), [ref]);
  });

  it('…for an EXISTING App by PK (the existence oracle the issue reported)', async () => {
    await concealedRefusal(startSession(ctx(outsider.id), { appRef: app.id }), [app.id]);
  });

  it('…for an EXISTING App by URN', async () => {
    await concealedRefusal(startSession(ctx(outsider.id), { appRef: `hrn:app:${app.urn}` }), [app.urn, `hrn:app:${app.urn}`]);
  });

  it('…for an uninstalled App by PK (state is not told to a non-member)', async () => {
    const gone = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'Gone App', urn: `${org.urn}:gone`, uninstalledAt: new Date() },
    });
    await concealedRefusal(startSession(ctx(outsider.id), { appRef: gone.id }), [gone.id]);
  });

  it('…for a soft-deleted App by PK', async () => {
    const dead = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'Dead App', urn: `${org.urn}:dead`, deletedAt: new Date() },
    });
    await concealedRefusal(startSession(ctx(outsider.id), { appRef: dead.id }), [dead.id]);
  });

  it('…for a malformed bare ref CARRYING A CANARY (the pasted-token case; nothing echoes)', async () => {
    await concealedRefusal(startSession(ctx(outsider.id), { appRef: CANARY }), [CANARY]);
  });

  it('…for a canary inside an otherwise well-formed App URN', async () => {
    const ref = `hrn:app:${org.urn}:${CANARY}`;
    await concealedRefusal(startSession(ctx(outsider.id), { appRef: ref }), [ref, CANARY]);
  });

  it('…for an ambiguous legacy URN (two live rows claim it)', async () => {
    const legacyUrn = `${org.urn}:legacy-dup`;
    for (const slug of ['dup-a', 'dup-b']) {
      await db.app.create({
        data: { id: generateId(), organizationId: org.id, name: `Dup ${slug}`, urn: `${org.urn}:${slug}`, legacyUrn },
      });
    }
    const ref = `hrn:app:${legacyUrn}`;
    await concealedRefusal(startSession(ctx(outsider.id), { appRef: ref }), [ref, legacyUrn]);
  });

  it('…for another user\'s user-owned App (no org arm can admit it)', async () => {
    const foreign = await db.app.create({
      data: { id: generateId(), ownerUserId: appMember.id, name: 'Their Solo App', urn: `solo-${generateId().slice(-8)}:app` },
    });
    await concealedRefusal(startSession(ctx(outsider.id), { appRef: foreign.id }), [foreign.id]);
  });

  it('…for an anonymous caller (no user, no App key)', async () => {
    await concealedRefusal(startSession({ db } as Context, { appRef: app.id }), [app.id]);
  });

  it('a HYBRID principal (user + MCP active-App selection) is judged on the USER: a non-member\'s selection grants nothing', async () => {
    await concealedRefusal(startSession(ctx(outsider.id, app.id), { appRef: app.id }), [app.id]);
    await concealedRefusal(startSession(ctx(outsider.id, app.id), { appRef: otherApp.id }), [otherApp.id]);
  });
});

describe('#4836 — a pure App key naming any other App gets the same unknown-App answer', () => {
  it('byte-identical for an EXISTING other App and a MISSING one (the SESSION_APP_MISMATCH oracle is gone)', async () => {
    const envelopes: string[] = [];
    for (const ref of [otherApp.id, 'c' + 'b'.repeat(24)]) {
      try {
        await startSession(ctx(undefined, app.id), { appRef: ref });
        expect.fail('expected the concealed unknown-App refusal');
      } catch (e) {
        expect(e).toBeInstanceOf(GraphQLError);
        envelopes.push(JSON.stringify({ message: (e as GraphQLError).message, extensions: (e as GraphQLError).extensions }));
      }
    }
    expect(envelopes[0]).toBe(CONCEALED);
    expect(envelopes[1]).toBe(CONCEALED);
    expect(JSON.stringify(envelopes[0])).not.toContain(otherApp.id);
    expect(JSON.stringify(envelopes[1])).not.toContain('bbbb');
  });

  it('its OWN App still resolves (a credential is standing for exactly its App)', async () => {
    const s = await startSession(ctx(undefined, app.id), { appRef: app.urn });
    expect(s.appId).toBe(app.id);
    expect(s.userId).toBeNull();
  });

  it('a pure App key naming its OWN uninstalled App by PK keeps APP_UNINSTALLED with the appId (LOCAL F3, #4844 fold)', async () => {
    // Standing is TRUE here (a key IS its App, whatever its state), so this is
    // not the concealed answer but the specific one — the pin the first review
    // asked for: reach first, state after, also on the credential arm. (By URN
    // the same App does not resolve — the #944 asymmetry pinned above.)
    const gone = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'Gone Key App', urn: `${org.urn}:gone-key`, uninstalledAt: new Date() },
    });
    // One call, one non-vacuous assertion: capture the rejection (the 1037 file's shape) so a resolved call
    // fails with its own message instead of being swallowed by the catch.
    const e = await startSession(ctx(undefined, gone.id), { appRef: gone.id }).then(
      () => { throw new Error('expected APP_UNINSTALLED'); },
      (x: unknown) => x,
    );
    const g = e as GraphQLError;
    expect(g).toBeInstanceOf(GraphQLError);
    expect(g.extensions?.code).toBe('APP_UNINSTALLED');
    expect(g.extensions?.appId).toBe(gone.id);
    expect(g.message).toBe('Cannot start a session in an uninstalled App.');
  });
});

describe('#4836 — a caller WITH standing keeps the specific answers (regression pins, green on main)', () => {
  it('a member starts a session by PK and by URN', async () => {
    expect((await startSession(ctx(appMember.id), { appRef: app.id })).appId).toBe(app.id);
    expect((await startSession(ctx(admin.id), { appRef: `hrn:app:${app.urn}` })).appId).toBe(app.id);
  });

  it('a member naming an UNINSTALLED App by PK keeps APP_UNINSTALLED with the appId', async () => {
    const gone = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'Gone App', urn: `${org.urn}:gone`, uninstalledAt: new Date() },
    });
    try {
      await startSession(ctx(admin.id), { appRef: gone.id });
      expect.fail('expected APP_UNINSTALLED');
    } catch (e) {
      const g = e as GraphQLError;
      expect(g.extensions?.code).toBe('APP_UNINSTALLED');
      expect(g.extensions?.appId).toBe(gone.id);
      expect(g.message).toBe('Cannot start a session in an uninstalled App.');
    }
  });

  it('a member naming an uninstalled App by URN gets the CONCEALED answer (the URN does not resolve: #944)', async () => {
    const gone = await db.app.create({
      data: { id: generateId(), organizationId: org.id, name: 'Gone App', urn: `${org.urn}:gone2`, uninstalledAt: new Date() },
    });
    await concealedRefusal(startSession(ctx(admin.id), { appRef: `hrn:app:${gone.urn}` }), [gone.urn, gone.id]);
  });
});

describe('#4836 — a MEMBER gets the concealed answer for malformed and ambiguous refs too (cor:dmo:070:05; the SDL says "to a member exactly as to an outsider")', () => {
  // The fold runs before standing is judged, so these never reach the reach gate: a member is
  // told nothing more than an outsider about a ref that does not resolve.
  it('a member naming a malformed bare ref CARRYING A CANARY', async () => {
    await concealedRefusal(startSession(ctx(appMember.id), { appRef: CANARY }), [CANARY]);
  });

  it('a member naming a canary inside an otherwise well-formed App URN', async () => {
    const ref = `hrn:app:${org.urn}:${CANARY}`;
    await concealedRefusal(startSession(ctx(appMember.id), { appRef: ref }), [ref, CANARY]);
  });

  it('a member naming an ambiguous legacy URN (two live rows claim it)', async () => {
    const legacyUrn = `${org.urn}:legacy-dup-member`;
    for (const slug of ['dup-ma', 'dup-mb']) {
      await db.app.create({
        data: { id: generateId(), organizationId: org.id, name: `Dup ${slug}`, urn: `${org.urn}:${slug}`, legacyUrn },
      });
    }
    const ref = `hrn:app:${legacyUrn}`;
    await concealedRefusal(startSession(ctx(appMember.id), { appRef: ref }), [ref, legacyUrn]);
  });
});

describe('#4836 — V58\'s exception: a caller with reach keeps an authorization refusal, not the unknown-App answer', () => {
  /**
   * The appRef door itself has no member-lacks-authority arm — a participant
   * (any role, cor:acl:030:01) may always attribute — so the exception is
   * pinned where it lives on this mutation: a launch-grant holder redeeming
   * the grant for a worker the start already told them exists, whose
   * participation has since lapsed. #10775 ruled that caller must reach the
   * FORBIDDEN that fails the start (not a not-found that leaves it hanging);
   * #4836's concealment must not swallow it. The refusal surfaces wrapped, as
   * LAUNCH_REFUSED with reason FORBIDDEN.
   */
  it('a launch-grant holder who left the App keeps FORBIDDEN (wrapped as LAUNCH_REFUSED)', async () => {
    const holder = await db.user.create({
      data: { id: generateId(), githubId: 9483604, githubUsername: `sar4836-holder-${Date.now()}`, roles: ['READER'] },
    });
    await db.appMember.create({ data: { appId: app.id, userId: holder.id, role: 'member' } });
    const heldAt = new Date();
    const worker = await db.worker.create({
      data: {
        ...WORKER_SIGNATURE_DEFAULTS,
        id: generateId(), appId: app.id, agentId: teamAgent.id, name: 'Kit', slug: 'kit',
        heldByUserId: holder.id, heldAt,
      },
    });
    const op = await db.hostOperation.create({
      data: {
        id: generateId(), appId: app.id, hostId: 'sar4836-host', type: 'worker.start',
        args: { workerId: worker.id, worktree: 'hadron-server/kit', family: 'claude' },
        workerId: worker.id, status: 'collected', issuedBy: 'platform',
        holdUserId: holder.id, holdAt: heldAt, collectedAt: new Date(),
      },
    });
    const raw = `hlg_${generateId()}${generateId()}`;
    await db.launchGrant.create({
      data: {
        id: generateId(), appId: app.id, operationId: op.id, workerId: worker.id,
        hostId: 'sar4836-host', holderUserId: holder.id,
        tokenHash: createHash('sha256').update(raw).digest('hex'),
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    // The holder's membership lapses AFTER the start was issued.
    await db.appMember.delete({ where: { appId_userId: { appId: app.id, userId: holder.id } } });
    try {
      await startSession(ctx(holder.id), { launchGrant: raw });
      expect.fail('expected LAUNCH_REFUSED');
    } catch (e) {
      const g = e as GraphQLError;
      expect(g.extensions?.code).toBe('LAUNCH_REFUSED');
      expect(g.extensions?.reason).toBe('FORBIDDEN');
    }
  });
});

describe('#4836 — the envelope through the real GraphQL schema (full execution)', () => {
  const schema = buildSchema(typeDefs);
  const fieldResolver = (p: any, a: any, c: any, i: any) =>
    typeof (resolvers as any)[i.parentType.name]?.[i.fieldName] === 'function'
      ? (resolvers as any)[i.parentType.name][i.fieldName](p, a, c, i)
      : defaultFieldResolver(p, a, c, i);
  const exec = (appRef: string, contextValue: unknown) =>
    graphql({
      schema,
      source: 'mutation($input: SessionInput!){ startSession(input: $input){ id } }',
      variableValues: { input: { id: generateId(), tool: 'claude-code', appRef } },
      contextValue,
      fieldResolver,
    });

  it('a missing App and an existing-but-inaccessible App answer the SAME bytes over the wire', async () => {
    // Each assertion below is tied to the value its call SENT (Braxton F5, #4853): the constants are what the
    // calls send, so a renamed ref moves the call and the assertion together instead of leaving an
    // absence check that can no longer fail.
    const missingRef = `hrn:app:${org.urn}:no-such-app`;
    const existingRef = app.id;
    const missing = await exec(missingRef, ctx(outsider.id));
    const existing = await exec(existingRef, ctx(outsider.id));
    for (const r of [missing, existing]) {
      expect(r.errors).toHaveLength(1);
      expect(r.errors![0]!.message).toBe('App not found.');
      expect(r.errors![0]!.extensions?.code).toBe('APP_NOT_FOUND');
    }
    expect(JSON.stringify(existing.errors![0]!.extensions)).toBe('{"code":"APP_NOT_FOUND"}');
    // Meaningful absence (Braxton F3, #4844): each call's OWN inputs — the missing call's sent URN (whole,
    // and its slug and org parts), the existing call's App PK — must not appear. (The old
    // `not.toContain(CANARY)` here could never fail: the `missing` call never sent the canary.)
    expect(missingRef).toContain('no-such-app'); // the substrings below are parts of what was sent
    expect(missingRef).toContain(org.urn);
    expect(JSON.stringify(missing.errors)).not.toContain(missingRef);
    expect(JSON.stringify(missing.errors)).not.toContain('no-such-app');
    expect(JSON.stringify(missing.errors)).not.toContain(org.urn);
    expect(JSON.stringify(existing.errors)).not.toContain(existingRef);
  });

  it('a canary-bearing malformed ref over the wire: the canary appears nowhere', async () => {
    const r = await exec(CANARY, ctx(outsider.id));
    expect(r.errors).toHaveLength(1);
    expect(JSON.stringify(r.errors![0])).not.toContain(CANARY);
    expect(r.errors![0]!.extensions?.code).toBe('APP_NOT_FOUND');
  });

  it('a fault INSIDE the ref lookup is not folded into the unknown-App answer (the narrow catch)', async () => {
    // Seat pins (LOCAL F1 = SEC10 P2-1, #4844 fold): broadening the catch's
    // final `throw e;` to `throw appNotFound();` left every earlier pin green
    // — a database fault inside resolveAppRef would read as "App not found.",
    // an outage masked as a missing App. This pin dies on that mutant three
    // ways: the raw fault propagates out of the resolver unchanged, the wire
    // formatter masks it as INTERNAL_SERVER_ERROR (cor:api:260:01 — never
    // APP_NOT_FOUND), and no session row is written.
    const fault = new Error('sar4836: db fault inside the ref lookup');
    // Seam (Braxton F2, #4853): the spy faults ONLY the ref lookup (the `where` carries this ref's URN) and
    // passes every other `app.findFirst` through, and the pin asserts it fired on that exact `where`. A
    // refactor that puts another `findFirst` ahead of the lookup, or moves the lookup off `app.findFirst`,
    // fails here instead of silently leaving the narrow-catch mutant-kill measuring a different call.
    const refUrn = `${org.urn}:no-such-app`;
    const original = db.app.findFirst.bind(db.app) as (args: any) => Promise<unknown>;
    const spy = vi.spyOn(db.app, 'findFirst').mockImplementation(((args: any) =>
      args?.where?.urn === refUrn ? Promise.reject(fault) : original(args)) as any);
    try {
      await expect(
        startSession(ctx(outsider.id), { appRef: `hrn:app:${refUrn}` }),
      ).rejects.toThrow('sar4836: db fault inside the ref lookup');
      expect(spy.mock.calls.some(([a]) => (a as any)?.where?.urn === refUrn), 'the fault pin never reached the ref lookup').toBe(true);
      const r = await exec(`hrn:app:${refUrn}`, ctx(outsider.id));
      expect(r.errors).toHaveLength(1);
      expect(r.errors![0]!.message).not.toBe('App not found.');
      const e = r.errors![0]!;
      const formatted = formatGraphQLError({ message: e.message, extensions: { ...e.extensions }, path: ['startSession'] }, e);
      expect(formatted.extensions?.code).not.toBe('APP_NOT_FOUND');
      expect(formatted.extensions?.code).toBe('INTERNAL_SERVER_ERROR');
    } finally {
      spy.mockRestore();
    }
    expect(await db.session.count()).toBe(0);
  });
});

describe('#4836 — the MCP door never took an appRef (contract pin)', () => {
  it('SHAPE_HADRON_START_SESSION has no appRef field, so the App-ref sites are unreachable there', () => {
    expect(Object.keys(SHAPE_HADRON_START_SESSION)).not.toContain('appRef');
  });
});

describe('#4836 — the judge: reach first, state after (cor:api:140:02\'s partition)', () => {
  /**
   * Pure unit pins on startSessionAppRefRefusal — the race arms the resolver
   * table cannot reach (a row deleted between resolveAppRef and the row read
   * needs a TOCTOU window) and the ORDER the gate addendum fixed (amendment
   * 3): standing is judged before state, so a non-member is never told the
   * App's state, and the deleted-while-reading row reads as missing for
   * EVERYONE.
   */
  const live = { id: 'cjudge0001live', deletedAt: null, uninstalledAt: null };
  const deleted = { id: 'cjudge0002dead', deletedAt: new Date(), uninstalledAt: null };
  const uninstalled = { id: 'cjudge0003gone', deletedAt: null, uninstalledAt: new Date() };
  const env = (e: GraphQLError | null) =>
    e === null ? null : JSON.stringify({ message: e.message, extensions: e.extensions });

  it('no standing → the concealed envelope whatever the state (live, deleted, uninstalled)', () => {
    for (const row of [live, deleted, uninstalled]) {
      expect(env(startSessionAppRefRefusal(false, row))).toBe(CONCEALED);
    }
  });

  it('standing + deleted (the resolve-then-read race) → the concealed envelope for EVERYONE', () => {
    expect(env(startSessionAppRefRefusal(true, deleted))).toBe(CONCEALED);
  });

  it('standing + uninstalled → APP_UNINSTALLED with the appId (a member keeps the specific answer)', () => {
    const e = startSessionAppRefRefusal(true, uninstalled);
    expect(e).toBeInstanceOf(GraphQLError);
    expect(e!.message).toBe('Cannot start a session in an uninstalled App.');
    expect(e!.extensions).toEqual({ code: 'APP_UNINSTALLED', appId: uninstalled.id });
  });

  it('standing + live → null (the ref stands; attribution proceeds)', () => {
    expect(startSessionAppRefRefusal(true, live)).toBeNull();
  });

  it('ORDER: without standing an uninstalled App is NOT reported APP_UNINSTALLED (state is told only to standing callers)', () => {
    const e = startSessionAppRefRefusal(false, uninstalled);
    expect(e!.extensions?.code).toBe('APP_NOT_FOUND');
    expect(JSON.stringify(e!.extensions)).not.toContain(uninstalled.id);
  });
});
