/**
 * #442: first-contact user provisioning under a lost unique race. The injected
 * P2002 tests are deterministic (the engine's own race can't be forced to
 * land on the catch); the concurrent tests prove the end state on a real DB.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { provisionEmailUser, provisionGithubUser, isUniqueViolationOn } from './userProvision.js';
import { RootNameTakenError } from '../lib/principal/mintPrincipal.js';

function p2002(target: unknown): Error {
  return Object.assign(new Error('Unique constraint failed'), {
    code: 'P2002',
    meta: target === undefined ? {} : { target },
  });
}

/** `db` whose first `failures.length` interactive transactions throw before running the callback. */
function failingFirst(failures: Error[]) {
  const calls = { n: 0 };
  const wrapped = new Proxy(db, {
    get(t, p) {
      if (p === '$transaction') {
        return (...args: unknown[]) => {
          const f = failures[calls.n++];
          if (f) return Promise.reject(f);
          return (t.$transaction as (...a: unknown[]) => unknown).apply(t, args);
        };
      }
      const v = Reflect.get(t, p, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  }) as typeof db;
  return { wrapped, calls };
}

const gh = (over: Partial<{ id: number; login: string; name: string | null }> = {}) => ({
  id: 4420001,
  login: 'racer442',
  name: 'Racer',
  avatar_url: 'https://example.test/a.png',
  ...over,
});

beforeEach(async () => {
  await cleanDb(db);
});

describe('isUniqueViolationOn', () => {
  it('matches only the named targets, in either spelling or as a constraint name', () => {
    expect(isUniqueViolationOn(p2002(['email']), ['email'])).toBe(true);
    expect(isUniqueViolationOn(p2002('users_email_key'), ['users_email_key'])).toBe(true);
    expect(isUniqueViolationOn(p2002(['handle']), ['email'])).toBe(false);
    expect(isUniqueViolationOn(p2002(undefined), ['email'])).toBe(false);
    expect(isUniqueViolationOn(Object.assign(new Error('x'), { code: 'P2003' }), ['email'])).toBe(false);
    expect(isUniqueViolationOn(null, ['email'])).toBe(false);
  });
});

describe('provisionEmailUser', () => {
  it('creates one user and one principal on first contact', async () => {
    const u = await provisionEmailUser(db, 'first@442.test');
    expect(u.email).toBe('first@442.test');
    const row = await db.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.principalId).not.toBeNull();
  });

  it('converges under concurrent first contacts: one user, one principal', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => provisionEmailUser(db, 'conc@442.test')));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await db.user.count({ where: { email: 'conc@442.test' } })).toBe(1);
    const row = await db.user.findUniqueOrThrow({ where: { id: results[0].id } });
    expect(row.principalId).not.toBeNull();
    expect(await db.principal.count({ where: { id: row.principalId! } })).toBe(1);
  });

  it('retries the whole transaction once when the email unique is lost, and the retry is usable', async () => {
    const winner = await db.user.create({ data: { email: 'lost@442.test', identityProvider: 'EMAIL' } });
    const { wrapped, calls } = failingFirst([p2002(['email'])]);
    const u = await provisionEmailUser(wrapped, 'lost@442.test');
    expect(calls.n).toBe(2);
    expect(u.id).toBe(winner.id);
    const row = await db.user.findUniqueOrThrow({ where: { id: winner.id } });
    expect(row.principalId).not.toBeNull(); // the principal mint ran in the committed retry
  });

  it('accepts the snake-case constraint name as the email unique', async () => {
    const { wrapped, calls } = failingFirst([p2002('users_email_key')]);
    await provisionEmailUser(wrapped, 'snake@442.test');
    expect(calls.n).toBe(2);
  });

  it('rethrows a P2002 on another unique, a missing target, and other codes: no retry', async () => {
    for (const err of [
      p2002(['handle']),
      p2002(undefined),
      Object.assign(new Error('fk'), { code: 'P2003' }),
      new Error('boom'),
    ]) {
      const { wrapped, calls } = failingFirst([err]);
      await expect(provisionEmailUser(wrapped, 'other@442.test')).rejects.toBe(err);
      expect(calls.n).toBe(1);
    }
  });

  it('is bounded to one retry', async () => {
    const second = p2002(['email']);
    const { wrapped, calls } = failingFirst([p2002(['email']), second]);
    await expect(provisionEmailUser(wrapped, 'twice@442.test')).rejects.toBe(second);
    expect(calls.n).toBe(2);
  });
});

describe('provisionGithubUser', () => {
  it('creates one user and one principal on first contact', async () => {
    const u = await provisionGithubUser(db, gh());
    const row = await db.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.githubId).toBe(4420001);
    expect(row.principalId).not.toBeNull();
  });

  it('converges under concurrent first contacts: one user, one principal', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => provisionGithubUser(db, gh({ id: 4420002, login: 'conc442' }))));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await db.user.count({ where: { githubId: 4420002 } })).toBe(1);
    const row = await db.user.findUniqueOrThrow({ where: { id: results[0].id } });
    expect(row.principalId).not.toBeNull();
  });

  it.each([['githubId'], ['github_id'], ['users_github_id_key']])(
    'a lost githubId race (%s) retries once and runs the real update branch',
    async (target) => {
      const winner = await db.user.create({
        data: { githubId: 4420003, githubUsername: 'old442', name: 'Old', identityProvider: 'GITHUB' },
      });
      const { wrapped, calls } = failingFirst([p2002([target])]);
      const u = await provisionGithubUser(wrapped, gh({ id: 4420003, login: 'new442', name: 'New' }));
      expect(calls.n).toBe(2);
      expect(u.id).toBe(winner.id);
      const row = await db.user.findUniqueOrThrow({ where: { id: winner.id } });
      expect(row.githubUsername).toBe('new442'); // the update was applied, not swallowed
      expect(row.name).toBe('New');
      expect(row.principalId).not.toBeNull();
    },
  );

  it('rethrows other constraints and unknown targets without retrying', async () => {
    for (const err of [p2002(['githubUsername']), p2002(undefined), Object.assign(new Error('fk'), { code: 'P2003' })]) {
      const { wrapped, calls } = failingFirst([err]);
      await expect(provisionGithubUser(wrapped, gh({ id: 4420004, login: 'other442' }))).rejects.toBe(err);
      expect(calls.n).toBe(1);
    }
  });

  it('bounds the githubId retry to one', async () => {
    const second = p2002(['githubId']);
    const { wrapped, calls } = failingFirst([p2002(['githubId']), second]);
    await expect(provisionGithubUser(wrapped, gh({ id: 4420005, login: 'twice442' }))).rejects.toBe(second);
    expect(calls.n).toBe(2);
  });

  it('keeps the handle-collision retry (once) and the pool-name retry (once)', async () => {
    await db.user.create({ data: { handle: 'taken442', identityProvider: 'GITHUB', githubId: 4420006 } });
    // P2002 on handle only retries when the handle IS taken; a free handle rethrows.
    const free = p2002(['handle']);
    const f = failingFirst([free]);
    await expect(provisionGithubUser(f.wrapped, gh({ id: 4420007, login: 'free442' }))).rejects.toBe(free);
    expect(f.calls.n).toBe(1);

    const pool = new RootNameTakenError('x');
    const p = failingFirst([pool]);
    await provisionGithubUser(p.wrapped, gh({ id: 4420008, login: 'pool442' }));
    expect(p.calls.n).toBe(2);
    const p2 = failingFirst([pool, pool]);
    await expect(provisionGithubUser(p2.wrapped, gh({ id: 4420009, login: 'pool2442' }))).rejects.toBe(pool);
    expect(p2.calls.n).toBe(2);
  });

  it('combined collisions stay finite: githubId race then pool race then githubId again rethrows', async () => {
    const again = p2002(['githubId']);
    const { wrapped, calls } = failingFirst([p2002(['githubId']), new RootNameTakenError('x'), again]);
    await expect(provisionGithubUser(wrapped, gh({ id: 4420010, login: 'combo442' }))).rejects.toBe(again);
    expect(calls.n).toBe(3);
  });
});
