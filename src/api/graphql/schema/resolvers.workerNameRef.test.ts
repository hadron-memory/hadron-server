/**
 * #990 — `workerRef` accepts a worker NAME, resolved within the session's App.
 *
 * The contract lines under test:
 *   - a bare name resolves, case-insensitively, matching the DB's lower()
 *     (the expression workers_app_name_uniq indexes) rather than JS folding;
 *   - the three ref forms are told apart by SHAPE, so a malformed URN never
 *     falls through to a roster search;
 *   - without App context, #1597 resolves only a unique authorized name;
 *   - the roster is never an oracle: an outsider is refused before any name is
 *     looked up, and existing vs nonexistent names are reported identically;
 *   - resolution is not authorization: every downstream gate still runs.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { serveEveryAgent } from '../../../test/servedBootPrompt.js';
import { generateId } from '../../../lib/id.js';
import { resolvers, type Context } from './resolvers.js';

vi.mock('../../../integrations/github/writeNodeToGit.js', () => ({
  writeNodeToGit: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../integrations/github/syncGraphFromGithub.js', () => ({
  syncGraphFromGithub: vi.fn().mockResolvedValue({ error: null }),
}));

const M = resolvers.Mutation as any;
const W = resolvers.Worker as any;

function ctx(userId?: string, appId?: string): Context {
  return { db, userId, appId, roles: ['READER'] };
}

async function expectCode(p: Promise<unknown>, code: string) {
  try {
    await p;
    expect.fail(`expected rejection with extensions.code=${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(GraphQLError);
    expect((e as GraphQLError).extensions?.code).toBe(code);
  }
}

let org: { id: string; urn: string };
let admin: { id: string };
let outsider: { id: string };
let roleAgent: { id: string };
let app: { id: string; urn: string };

beforeEach(async () => {
  await cleanDb(db);
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
  org = await db.organization.create({
    data: { id: generateId(), name: 'wnr-org', urn: `wnr-org-${suffix}.com` },
  });
  admin = await db.user.create({
    data: { id: generateId(), githubId: 99500, githubUsername: `wnr-admin-${suffix}`, roles: ['READER'] },
  });
  outsider = await db.user.create({
    data: { id: generateId(), githubId: 99501, githubUsername: `wnr-out-${suffix}`, roles: ['READER'] },
  });
  await db.orgMember.create({
    data: { id: generateId(), organizationId: org.id, userId: admin.id, role: 'ADMIN' },
  });

  const role = await M.createAgent(
    {},
    {
      orgId: org.id,
      name: 'WNR Backend Engineer',
      personaRole: 'backend-engineer',
    },
    ctx(admin.id),
  );
  roleAgent = { id: role.id };

  app = await db.app.create({
    data: {
      id: generateId(),
      organizationId: org.id,
      name: 'WNR Team App',
      urn: `${org.urn}:wnr-team`,
    },
  });
  await db.appAgent.create({ data: { appId: app.id, agentId: roleAgent.id } });
  await serveEveryAgent(db); // #2712: binds need a served prompt
});

const cast = (name: string) =>
  M.castWorker({}, { appRef: app.id, agentRef: roleAgent.id, name }, ctx(admin.id));

const start = (input: Record<string, unknown>, c: Context = ctx(admin.id)) =>
  M.startSession({}, { input: { id: generateId(), tool: 'vitest', ...input } }, c);

describe('#990 — workerRef by name', () => {
  it('resolves a bare name within the App', async () => {
    const w = await cast('Iris');
    const s = await start({ appRef: app.id, workerRef: 'Iris' });
    expect(s.workerId).toBe(w.id);
    // …and stamps the role-agent, exactly as the id form does.
    expect(s.agentId).toBe(roleAgent.id);
  });

  it('is case-insensitive, matching the DB lower() the unique indexes', async () => {
    const w = await cast('Iris');
    for (const spelling of ['iris', 'IRIS', 'iRiS', '  Iris  ']) {
      // force: the point here is that each spelling RESOLVES to the same row;
      // the second binding would otherwise hit WORKER_TAKEN, which is the #940
      // contract working, not a resolution failure.
      const s = await start({ appRef: app.id, workerRef: spelling, force: true });
      expect(s.workerId).toBe(w.id);
    }
  });

  it('resolves a name containing spaces (names are unconstrained)', async () => {
    const w = await cast('Mary Jane');
    const s = await start({ appRef: app.id, workerRef: 'mary jane' });
    expect(s.workerId).toBe(w.id);
  });

  it('distinguishes two names that share one derived slug', async () => {
    // The #991 pair: one mention token, one slug base, but distinct names —
    // so the NAME form must still address each unambiguously.
    const a = await cast('Mary Jane');
    const b = await cast('Mary-Jane');
    expect(a.slug).not.toBe(b.slug);
    expect((await start({ appRef: app.id, workerRef: 'Mary Jane' })).workerId).toBe(a.id);
    expect((await start({ appRef: app.id, workerRef: 'Mary-Jane' })).workerId).toBe(b.id);
  });

  it('still accepts the id and the URN forms', async () => {
    // Distinct workers per binding: re-binding one would hit WORKER_TAKEN,
    // which is the #940 contract doing its job, not a ref-resolution failure.
    const byId = await cast('Iris');
    const byUrn = await cast('Alex');
    const urn = await W.urn(byUrn, {}, ctx(admin.id));
    expect((await start({ appRef: app.id, workerRef: byId.id })).workerId).toBe(byId.id);
    expect((await start({ appRef: app.id, workerRef: urn })).workerId).toBe(byUrn.id);
  });
});

describe('#990 — shape dispatch, not fallback', () => {
  it('a malformed URN refuses instead of searching the roster for it', async () => {
    // A worker literally named like a broken URN must NOT be reachable by
    // passing that string: the scheme prefix routes it to URN resolution,
    // which fails, and nothing falls through to a name lookup.
    const weird = 'hrn:worker:nope';
    await cast(weird);
    await expectCode(start({ appRef: app.id, workerRef: weird }), 'WORKER_NOT_FOUND');
  });

  it('a well-formed URN for a nonexistent worker refuses', async () => {
    await cast('Iris');
    await expectCode(
      start({ appRef: app.id, workerRef: `hrn:worker:${org.urn}:wnr-team:ghost` }),
      'WORKER_NOT_FOUND',
    );
  });

  it('an unknown name refuses', async () => {
    await cast('Iris');
    await expectCode(start({ appRef: app.id, workerRef: 'Nobody' }), 'WORKER_NOT_FOUND');
  });
});

describe('#990 — a name needs App context', () => {
  it('binds the unique authorized name without App context (#1597)', async () => {
    const w = await cast('Iris');
    expect((await start({ workerRef: 'Iris' })).workerId).toBe(w.id);
  });

  it('but the id and URN forms still work without appRef', async () => {
    // They carry their own App: the worker's App becomes the session's.
    const byId = await cast('Iris');
    const byUrn = await cast('Alex');
    const urn = await W.urn(byUrn, {}, ctx(admin.id));
    const s1 = await start({ workerRef: byId.id });
    expect(s1.workerId).toBe(byId.id);
    expect(s1.appId).toBe(app.id);
    expect((await start({ workerRef: urn })).workerId).toBe(byUrn.id);
  });
});

describe('#990 — the staff read gate, and no roster oracle', () => {
  it('an outsider is refused at the APP gate, before any name is looked up', async () => {
    // `appRef` already requires isAppParticipant — the same predicate the
    // staff read gate uses — so an outsider never reaches the roster at all.
    // The in-branch gate is defense in depth for the App-key path, which
    // skips that membership branch.
    await cast('Iris');
    await expectCode(
      start({ appRef: app.id, workerRef: 'Iris' }, ctx(outsider.id)),
      'FORBIDDEN',
    );
  });

  it('reports an EXISTING and a nonexistent name identically to an outsider', async () => {
    await cast('Iris');
    // Thunks, not live promises: awaiting two in-flight rejections serially
    // leaves the second floating until its turn, which vitest reports as an
    // unhandled rejection.
    const attempts = [
      () => start({ appRef: app.id, workerRef: 'Iris' }, ctx(outsider.id)),
      () => start({ appRef: app.id, workerRef: 'Nobody' }, ctx(outsider.id)),
    ];
    // Same code AND same message — otherwise the pair is an existence oracle
    // over another tenant's roster.
    const codes: string[] = [];
    const messages: string[] = [];
    for (const attempt of attempts) {
      try {
        await attempt();
        expect.fail('expected rejection');
      } catch (e) {
        codes.push(String((e as GraphQLError).extensions?.code));
        messages.push((e as GraphQLError).message);
      }
    }
    expect(codes[0]).toBe(codes[1]);
    expect(messages[0]).toBe(messages[1]);
  });
});

describe('#990 — resolution is not authorization', () => {
  it('a retired worker resolves by name, then refuses the BINDING', async () => {
    // Retirement never frees the name (cor:agt:020:02), so the honest answer
    // is the specific WORKER_RETIRED — far more useful than "not found" for a
    // name the user can still see in the roster.
    const w = await cast('Iris');
    await M.retireWorker({}, { workerRef: w.id }, ctx(admin.id));
    await expectCode(start({ appRef: app.id, workerRef: 'Iris' }), 'WORKER_RETIRED');
  });

  it('a name in a DIFFERENT App than appRef does not resolve', async () => {
    const other = await db.app.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        name: 'WNR Other App',
        urn: `${org.urn}:wnr-other`,
      },
    });
    await db.appAgent.create({ data: { appId: other.id, agentId: roleAgent.id } });
    await M.castWorker({}, { appRef: other.id, agentRef: roleAgent.id, name: 'Iris' }, ctx(admin.id));
    // 'Iris' exists — but in the other App, so this App's lookup finds nothing.
    await expectCode(start({ appRef: app.id, workerRef: 'Iris' }), 'WORKER_NOT_FOUND');
  });

  it('each App resolves its OWN Iris', async () => {
    const mine = await cast('Iris');
    const other = await db.app.create({
      data: {
        id: generateId(),
        organizationId: org.id,
        name: 'WNR Other App',
        urn: `${org.urn}:wnr-other`,
      },
    });
    await db.appAgent.create({ data: { appId: other.id, agentId: roleAgent.id } });
    const theirs = await M.castWorker(
      {}, { appRef: other.id, agentRef: roleAgent.id, name: 'Iris' }, ctx(admin.id),
    );
    expect(mine.id).not.toBe(theirs.id);
    expect((await start({ appRef: app.id, workerRef: 'Iris' })).workerId).toBe(mine.id);
    expect((await start({ appRef: other.id, workerRef: 'Iris' })).workerId).toBe(theirs.id);
  });

  it('a WORKER_TAKEN refusal still applies to the name form', async () => {
    await cast('Iris');
    await start({ appRef: app.id, workerRef: 'Iris' });
    await expectCode(start({ appRef: app.id, workerRef: 'Iris' }), 'WORKER_TAKEN');
    // …and force still overrides it.
    const forced = await start({ appRef: app.id, workerRef: 'Iris', force: true });
    expect(forced.workerId).toBeTruthy();
  });
});

describe('#990 — App lifecycle is checked on the ctx.appId path (PR #996 review)', () => {
  // When appId comes from an App-key credential / MCP active-App SELECTION
  // rather than appRef, the name branch is the ONLY lifecycle check before
  // session.create. A stale selection must not open a session in a dead App.
  const appKeyCtx = (): Context => ({ db, appId: app.id, roles: ['READER'] });

  it('resolves a name on the App-key path while the App is healthy', async () => {
    const w = await cast('Iris');
    const s = await M.startSession(
      {}, { input: { id: generateId(), tool: 'vitest', workerRef: 'Iris' } }, appKeyCtx(),
    );
    expect(s.workerId).toBe(w.id);
  });

  it('refuses when the selected App is soft-deleted', async () => {
    await cast('Iris');
    await db.app.update({ where: { id: app.id }, data: { deletedAt: new Date() } });
    await expectCode(
      M.startSession({}, { input: { id: generateId(), tool: 'vitest', workerRef: 'Iris' } }, appKeyCtx()),
      'WORKER_NOT_FOUND',
    );
  });

  it('refuses when the selected App is uninstalled', async () => {
    await cast('Iris');
    await db.app.update({ where: { id: app.id }, data: { uninstalledAt: new Date() } });
    await expectCode(
      M.startSession({}, { input: { id: generateId(), tool: 'vitest', workerRef: 'Iris' } }, appKeyCtx()),
      'APP_UNINSTALLED',
    );
  });
});
