/**
 * hadron-server#5012 (Billing A5), pin R3: the auth middleware carries a stored
 * BILLING role into the request context on every path that reads `User.roles`
 * (an `hdr_user_` key, a sign-in JWT, and `getCurrentUserRoles`, the per-request
 * refresh of a long-lived MCP transport), and its allowed set is the generated
 * `Role` enum itself, so a value added to the enum can never be dropped again.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { SignJWT } from 'jose';
import type { Request } from 'express';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { generateId } from '../lib/id.js';
import { Role } from '../generated/prisma/index.js';
import * as auth from './auth.js';

const makeReq = (authorization: string) => ({ headers: { authorization } }) as unknown as Request;

let billingUser: string;

beforeEach(async () => {
  await cleanDb(db);
  billingUser = (await db.user.create({
    data: { id: generateId(), githubId: 50_129, githubUsername: 'r3-bill', handle: 'r3-bill', roles: ['BILLING'] },
  })).id;
});

describe('R3: the middleware carries BILLING', () => {
  it('through an hdr_user_ key', async () => {
    const { rawKey } = await auth.mintUserApiKey(db, {
      userId: billingUser, label: 'billing-service', createdBy: billingUser, issuedVia: 'admin',
    });
    const ctx = await auth.resolveAuthContext(makeReq(`Bearer ${rawKey}`), db);
    expect(ctx.userId).toBe(billingUser);
    expect(ctx.roles).toEqual(['BILLING']);
  });

  it('through a sign-in JWT (roles re-read from the row, not the claim)', async () => {
    const token = await new SignJWT({ sub: billingUser, githubUsername: 'r3-bill', githubId: 50_129, roles: [] })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('hadron-server')
      .setAudience('hadron')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET!));
    const ctx = await auth.resolveAuthContext(makeReq(`Bearer ${token}`), db);
    expect(ctx.userId).toBe(billingUser);
    expect(ctx.roles).toEqual(['BILLING']);
  });

  it('through getCurrentUserRoles (the MCP per-request refresh), and a demotion takes effect', async () => {
    expect(await auth.getCurrentUserRoles(db, { userId: billingUser })).toEqual(['BILLING']);
    await db.user.update({ where: { id: billingUser }, data: { roles: [] } });
    expect(await auth.getCurrentUserRoles(db, { userId: billingUser })).toEqual([]);
  });

  it('the allowed set is exactly the generated Role enum', () => {
    const allowed = (auth as unknown as { ALLOWED_ROLES?: ReadonlySet<string> }).ALLOWED_ROLES;
    expect(allowed, 'ALLOWED_ROLES is exported').toBeDefined();
    expect([...allowed!].sort()).toEqual(Object.values(Role).sort());
  });
});
