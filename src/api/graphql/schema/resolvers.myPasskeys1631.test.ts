/**
 * #1631 PR3 (cor:aut:040:05 "Who owns it and who can see it"): only the owner sees their passkey records, the cancel
 * record included. Reading needs no ceremony (only registering and revoking do), but an App key, an impersonation
 * session or anyone else gets nothing. Dark with the registration switch (#1895).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../integrations/db/client.js';
import { cleanDb } from '../../../test/helpers.js';
import { insertSoftPasskey, softPasskey } from '../../../test/softPasskey.js';
import { cancelFirstPasskey, issueCancelToken } from '../../../lib/passkeys/cancel.js';
import { resolvers } from './resolvers.js';
import type { Context } from './resolvers.helpers.js';

const Q = resolvers.Query as any;
let ana: string;
let bea: string;
let anaKey: string;
let anaFirst: string;

const ctx = (over: Partial<Context>): Context => ({ db, roles: ['READER'], ...over } as Context);

beforeEach(async () => {
  await cleanDb(db);
  ana = (await db.user.create({ data: { handle: 'list-ana', roles: [] } })).id;
  bea = (await db.user.create({ data: { handle: 'list-bea', roles: [] } })).id;
  anaKey = await insertSoftPasskey(db, ana, softPasskey(), { label: 'Laptop' });
  anaFirst = await insertSoftPasskey(db, ana, softPasskey(), { firstWindow: true, label: 'Phone' });
  await insertSoftPasskey(db, bea, softPasskey(), { label: 'Bea key' });
  const token = await db.$transaction((tx) => issueCancelToken(tx, anaFirst));
  await cancelFirstPasskey(db, { token, ip: '203.0.113.4', userAgent: 'MailApp/9' });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('myPasskeys', () => {
  it('lists the owner\'s own records, with the window and the cancel record, and nobody else\'s', async () => {
    const list = await Q.myPasskeys({}, {}, ctx({ userId: ana }));
    expect(list.map((p: any) => p.label).sort()).toEqual(['Laptop', 'Phone']);
    const phone = list.find((p: any) => p.label === 'Phone');
    expect(phone.revokedAt).not.toBeNull();
    expect(phone.window).toMatchObject({ outcome: 'cancelled' });
    expect(phone.cancel.at).toBeInstanceOf(Date);
    // Rook §10 (6325976373): the bearer list carries no cancel IP/UA (where the canceller was) and no credential ids
    // (a bearer-holding agent could spend each one's sign-in budget). Those are shown only after an interactive proof.
    expect(phone.cancel).not.toHaveProperty('ip');
    expect(phone.cancel).not.toHaveProperty('userAgent');
    for (const p of list) expect(p).not.toHaveProperty('credentialId');
    const laptop = list.find((p: any) => p.label === 'Laptop');
    expect(laptop.window).toBeNull();
    expect(laptop.cancel).toBeNull();
    expect((await Q.myPasskeys({}, {}, ctx({ userId: bea }))).map((p: any) => p.label)).toEqual(['Bea key']);
  });

  // Each arm names the refusal that must fire, so a later failure (or a resolver that stopped checking) cannot pass
  // for the guard. The App key and impersonation arms carry the owner's real id and a real principal (Rook §10 P3-1).
  it.each([
    ['no user', {}, 'UNAUTHENTICATED'],
    ['an App key, even one acting for the owner', { userId: () => ana, appId: 'some-app' }, 'UNAUTHENTICATED'],
    ['an impersonation session', { userId: () => ana, impersonation: () => ({ adminUserId: bea }) }, 'FORBIDDEN'],
  ])('refuses %s', async (_c, over, code) => {
    const resolved = Object.fromEntries(Object.entries(over).map(([k, v]) => [k, typeof v === 'function' ? (v as () => unknown)() : v]));
    await expect(Q.myPasskeys({}, {}, ctx(resolved as Partial<Context>))).rejects.toMatchObject({ extensions: { code } });
  });
});

describe('dark with the registration switch (#1895)', () => {
  it('the SDL carries myPasskeys and its types only when registration is on', async () => {
    const { deploymentSchema } = await import('./deploymentSchema.js');
    vi.stubEnv('PASSKEY_SIGNING_ENABLED', 'true');
    vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', 'true');
    const on = deploymentSchema();
    expect(on.typeDefs).toMatch(/myPasskeys: \[PasskeyCredential!\]!/);
    const credentialType = /type PasskeyCredential \{[\s\S]*?\n  \}/.exec(on.typeDefs)![0];
    expect(credentialType).not.toMatch(/credentialId/);
    expect(/type PasskeyCancelRecord \{[\s\S]*?\n  \}/.exec(on.typeDefs)![0]).not.toMatch(/ip|userAgent/);
    vi.stubEnv('PASSKEY_REGISTRATION_ENABLED', 'false');
    const off = deploymentSchema();
    expect(off.typeDefs).not.toContain('myPasskeys');
    expect(off.typeDefs).not.toContain('PasskeyCredential');
    expect((off.resolvers.Query as Record<string, unknown>).myPasskeys).toBeUndefined();
  });
});
