/** #4065 — the audience-gated signing reads retry a Postgres serialization abort (40001, incl. Prisma P2010) instead of answering INTERNAL. */
import { beforeEach, describe, expect, it } from 'vitest';
import { Prisma } from '../../../generated/prisma/index.js';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { generateId } from '../../../lib/id.js';
import { SERIALIZATION_RETRIES } from '../../../lib/serializableRetry.js';
import { resolvers, type Context } from './resolvers.js';

const Q = resolvers.Query!;
const M = resolvers.Mutation!;
let orgId: string, adminId: string, memberId: string;

const abort = (sqlstate = '40001') => new Prisma.PrismaClientKnownRequestError('synthetic abort', { code: 'P2010', clientVersion: 'test', meta: { code: sqlstate } });

/** A db whose `$transaction` throws `error` for its first `failures` calls, then delegates. */
function flaky(failures: number, error: () => Error = abort) {
  const state = { attempts: 0, thrown: [] as Error[] };
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === '$transaction') {
        return (...args: unknown[]) => {
          state.attempts += 1;
          if (state.attempts <= failures) {
            const e = error();
            state.thrown.push(e);
            return Promise.reject(e);
          }
          return (target.$transaction as (...a: unknown[]) => Promise<unknown>)(...args);
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { state, ctx: (userId = adminId): Context => ({ db: proxy as typeof db, userId, roles: [] }) };
}

/**
 * A db whose FIRST `$transaction` runs its callback for real, then (still inside the aborted attempt) lets `between`
 * change the world and reports a 40001 abort; later calls delegate. This is the abort-inside-the-callback case: the
 * retried attempt must re-read the state the first attempt did not see.
 */
function abortAfterFirstRun(between: () => Promise<unknown>) {
  const state = { attempts: 0 };
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === '$transaction') {
        return async (...args: unknown[]) => {
          state.attempts += 1;
          const run = target.$transaction as (...a: unknown[]) => Promise<unknown>;
          if (state.attempts > 1) return run.apply(target, args);
          await run.apply(target, args);
          await between();
          throw abort();
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { state, ctx: (userId = adminId): Context => ({ db: proxy as typeof db, userId, roles: [] }) };
}

beforeEach(async () => {
  await cleanDb(db);
  const suffix = generateId().slice(0, 10).toLowerCase();
  const org = await db.organization.create({ data: { name: 'Org', urn: `retry-${suffix}.example` } }); orgId = org.id;
  adminId = (await db.user.create({ data: { githubId: 406501, githubUsername: `admin-${suffix}` } })).id;
  memberId = (await db.user.create({ data: { githubId: 406502, githubUsername: `member-${suffix}` } })).id;
  await db.orgMember.createMany({ data: [
    { organizationId: orgId, userId: adminId, role: 'ADMIN' },
    { organizationId: orgId, userId: memberId, role: 'CONTRIBUTOR' },
  ] });
});

const preview = (ctx: Context) => Q.orgBootPromptSigningPreview!({}, { org: orgId }, ctx) as Promise<any>;
const status = (ctx: Context) => Q.orgBootPromptSigning!({}, { org: orgId }, ctx) as Promise<any>;

describe('#4065 signing reads retry a serialization abort', () => {
  it.each([['preview', preview], ['status', status]] as const)('%s completes after transient 40001 aborts', async (_n, read) => {
    const f = flaky(2);
    const out = await read(f.ctx());
    expect(out).toMatchObject({ enforced: false });
    expect(f.state.attempts).toBe(3);
  });

  it('answers with the original error once the retry budget is spent', async () => {
    const f = flaky(Infinity);
    const err = await preview(f.ctx()).then(() => null, (e: unknown) => e);
    expect(f.state.attempts).toBe(SERIALIZATION_RETRIES + 1);
    expect(f.state.thrown).toHaveLength(SERIALIZATION_RETRIES + 1);
    // the exact instance the last attempt threw, not a look-alike with the same fields
    expect(err).toBe(f.state.thrown[f.state.thrown.length - 1]);
  });

  it('does not retry a P2010 carrying a different database code', async () => {
    const f = flaky(Infinity, () => abort('40P01'));
    await expect(preview(f.ctx())).rejects.toMatchObject({ code: 'P2010', meta: { code: '40P01' } });
    expect(f.state.attempts).toBe(1);
  });

  it('judges the refusal on the retried attempt: a non-admin still gets Forbidden, never a success or an internal error', async () => {
    const f = flaky(1);
    await expect(preview(f.ctx(memberId))).rejects.toMatchObject({ message: 'Forbidden', extensions: { code: 'FORBIDDEN' } });
    expect(f.state.attempts).toBe(2);
  });

  // cor:agt:040:09: a retried attempt is a fresh decision. A caller who lost membership between attempts is no longer
  // current and gets the SAME refusal a non-member gets on a first attempt, whichever attempt the refusal lands on.
  it.each([['preview', preview], ['status', status]] as const)('%s: a caller revoked between attempts is refused as a non-member is', async (_n, read) => {
    const strangerId = (await db.user.create({ data: { githubId: 406503, githubUsername: `stranger-${generateId().slice(0, 8).toLowerCase()}` } })).id;
    const firstAttempt = await read({ db, userId: strangerId, roles: [] }).then(() => null, (e: any) => e);
    expect(firstAttempt).toMatchObject({ extensions: { code: 'FORBIDDEN' } });

    const f = abortAfterFirstRun(() => db.orgMember.updateMany({ where: { organizationId: orgId, userId: adminId }, data: { deletedAt: new Date() } }));
    const retried = await read(f.ctx()).then(() => null, (e: any) => e);
    expect(f.state.attempts).toBe(2);
    expect(retried).toMatchObject({ message: firstAttempt.message, extensions: { code: firstAttempt.extensions.code } });
  });

  it('leaves the switch off when turning it on keeps aborting', async () => {
    const f = flaky(Infinity);
    await expect(M.setOrgBootPromptSigning!({}, { org: orgId, required: true }, f.ctx())).rejects.toBeDefined();
    expect((await db.organization.findUniqueOrThrow({ where: { id: orgId }, select: { bootPromptSigningRequired: true } })).bootPromptSigningRequired).toBe(false);
  });
});
