/**
 * hadron-server#5012 (Billing A5), pins R8 and R9: the service-user mode of
 * `admin:mint-token` (`--create-service-user <handle>`).
 *
 * Gate rulings: 10.3 the service user has `identityProvider` null and `name`
 * null, and its key is labelled `billing-service` unless `--label` is given;
 * 10.4 the script's audit actor is `host-script`. The handle check is the
 * pool-aware one, so an organization's name counts as taken.
 *
 * The module is imported per test so a missing export fails each pin on its own.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request } from 'express';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { resolveAuthContext, USER_API_KEY_PREFIX } from '../middleware/auth.js';
import * as core from './mint-bootstrap-token.js';

type Mod = typeof core & {
  mintServiceUser?: (
    db: unknown, input: { handle: string }, opts?: { label?: string | null },
  ) => Promise<{ rawKey: string; user: { id: string; handle: string | null } }>;
  parseMintTokenArgs?: (argv: string[]) => unknown;
};
const mod = core as Mod;

let logSpy: ReturnType<typeof vi.spyOn>;
const roleLines = () =>
  logSpy.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.startsWith('user.roles.changed'));

beforeEach(async () => {
  await cleanDb(db);
  logSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => logSpy.mockRestore());

describe('R8: mintServiceUser creates a BILLING-only user and a key', () => {
  it('creates the user, its principal, and a key that authenticates with roles [BILLING]', async () => {
    expect(typeof mod.mintServiceUser, 'mintServiceUser is exported').toBe('function');
    const { rawKey, user } = await mod.mintServiceUser!(db, { handle: 'pay-svc' });
    expect(rawKey).toMatch(new RegExp(`^${USER_API_KEY_PREFIX}[0-9a-f]{64}$`));

    const row = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row).toMatchObject({
      handle: 'pay-svc', email: null, name: null, identityProvider: null, roles: ['BILLING'], createdBy: null,
    });
    expect(row.principalId).not.toBeNull();

    const key = await db.userApiKey.findFirstOrThrow({ where: { userId: user.id } });
    expect(key).toMatchObject({ label: 'billing-service', issuedVia: 'admin' });

    const req = { headers: { authorization: `Bearer ${rawKey}` } } as unknown as Request;
    const ctx = await resolveAuthContext(req, db);
    expect(ctx).toMatchObject({ userId: user.id, roles: ['BILLING'] });

    expect(roleLines()).toEqual([`user.roles.changed actor=host-script target=${user.id} before= after=BILLING`]);
  });

  it('honours --label', async () => {
    expect(typeof mod.mintServiceUser).toBe('function');
    const { user } = await mod.mintServiceUser!(db, { handle: 'pay-svc' }, { label: 'stripe-prod' });
    expect((await db.userApiKey.findFirstOrThrow({ where: { userId: user.id } })).label).toBe('stripe-prod');
  });
});

describe('R9: refusals create no user', () => {
  async function refused(handle: string) {
    expect(typeof mod.mintServiceUser).toBe('function');
    const before = await db.user.count();
    await expect(mod.mintServiceUser!(db, { handle })).rejects.toBeInstanceOf(core.BootstrapTokenError);
    expect(await db.user.count()).toBe(before);
  }

  it('an existing user\'s handle', async () => {
    await db.user.create({ data: { id: generateId(), handle: 'pay-svc', email: 'p@example.com' } });
    await refused('pay-svc');
  });

  it('an organization\'s name used as the handle (the principal pool is shared)', async () => {
    await db.organization.create({ data: { id: generateId(), name: 'acme-pay', urn: 'acme-pay' } });
    // Organizations claim their name in the principal pool; mint the claim as the org paths do.
    const { ensureOrgPrincipal } = await import('../lib/principal/mintPrincipal.js');
    const org = await db.organization.findFirstOrThrow({ where: { urn: 'acme-pay' } });
    await ensureOrgPrincipal(db, org);
    await refused('acme-pay');
  });

  it('an illegal handle', async () => {
    await refused('Not A Handle!');
  });

  it('--create-service-user combined with a selector', () => {
    expect(typeof mod.parseMintTokenArgs, 'parseMintTokenArgs is exported').toBe('function');
    for (const extra of [['--email', 'a@example.com'], ['--user-id', 'u1'], ['--handle', 'alice']]) {
      expect(() => mod.parseMintTokenArgs!(['--create-service-user', 'pay-svc', ...extra]))
        .toThrow(core.BootstrapTokenError);
    }
  });

  it('parses --create-service-user with --label', () => {
    expect(typeof mod.parseMintTokenArgs).toBe('function');
    expect(mod.parseMintTokenArgs!(['--create-service-user', 'pay-svc', '--label', 'x'])).toMatchObject({
      serviceUserHandle: 'pay-svc', label: 'x',
    });
  });
});
