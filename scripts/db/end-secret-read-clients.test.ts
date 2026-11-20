/**
 * #4003 (S8 of #3991; R21, Bill's conditions in team chat #121979): ending every live read client after a restore.
 * Dry run writes nothing; --apply ends only secret.reveal grants, through the shared endGrant (revoked_at paired with
 * revoked_by, one REVOKE event each); a second run ends nothing; the revoker must be an existing user; output is counts only.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/integrations/db/client.js';
import { cleanDb } from '../../src/test/helpers.js';
import { generateId } from '../../src/lib/id.js';
import { upsertPlatformActions } from '../../src/lib/grants/actions.js';
import { resolvers, type Context } from '../../src/api/graphql/schema/resolvers.js';
import { endLiveSecretReadClients, READ_CLIENT_GRANT_ACTIONS, UnknownRevokerError } from '../../src/lib/secrets/endReadClients.js';
import { main } from './end-secret-read-clients.js';

let ownerId: string; let operatorId: string; let appId: string; let secretId: string;
let liveGrant: string; let pendingGrant: string; let otherActionGrant: string; let deadAppGrant: string;
let lines: string[] = [];
const ctxOf = (userId: string): Context => ({ db, userId, roles: [] } as unknown as Context);
const io = (env: NodeJS.ProcessEnv = process.env) => ({ env, log: (l: string) => lines.push(l) });
const issue = async (app: string, secret: string) => ((await resolvers.Mutation.issueSecretReadClient({}, {
  input: { secretRef: secret, holderKind: 'USER', autoDelete: false, maxReads: 3, reason: 'need it' },
}, ctxOf(ownerId))) as { grantId: string }).grantId;
const grant = (id: string) => db.grant.findUniqueOrThrow({ where: { id }, select: { revokedAt: true, revokedBy: true } });
const revokes = () => db.grantEvent.count({ where: { action: 'REVOKE' } });

async function activate(id: string) {
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE grants DISABLE TRIGGER grants_guard');
    await tx.$executeRawUnsafe(`UPDATE grants SET activated_at = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 minute', verification_kind = 'passkey', verified_by = $2, issuer_user_id = $2 WHERE id = $1`, id, ownerId);
    await tx.$executeRawUnsafe('ALTER TABLE grants ENABLE TRIGGER grants_guard');
  });
}

beforeEach(async () => {
  process.env.HADRON_ENCRYPTION_KEY = '11'.repeat(32);
  process.env.SECRET_ROOT_KEY = '22'.repeat(32);
  await cleanDb(db); await upsertPlatformActions(db);
  lines = [];
  ownerId = (await db.user.create({ data: { email: `${generateId()}@s8e.test` } })).id;
  operatorId = (await db.user.create({ data: { email: `${generateId()}@s8e.test` } })).id;
  appId = (await db.app.create({ data: { name: 'S8e', ownerUserId: ownerId, urn: `${generateId().toLowerCase()}:ec` } })).id;
  secretId = (await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: appId, name: 'tok', kind: 'generic', value: 'hunter2' }, ctxOf(ownerId))).id;
  liveGrant = await issue(appId, secretId); await activate(liveGrant);
  pendingGrant = await issue(appId, secretId);
  // A grant of another action in the same App: never touched.
  otherActionGrant = generateId();
  await db.$executeRaw`INSERT INTO grants (id, app_id, user_id, action, action_values, reason, created_at, updated_at)
    VALUES (${otherActionGrant}, ${appId}, ${ownerId}, 'schedule.create', ${JSON.stringify({ entryNode: 'x' })}::jsonb, 'because',
            (clock_timestamp() AT TIME ZONE 'UTC'), (clock_timestamp() AT TIME ZONE 'UTC'))`;
  // A read client of a soft-deleted App: endGrant refuses such a row, so it is not a candidate.
  const dead = (await db.app.create({ data: { name: 'S8d', ownerUserId: ownerId, urn: `${generateId().toLowerCase()}:ed` } })).id;
  const deadSecret = (await resolvers.Mutation.createSecret({}, { ownerType: 'app', ownerRef: dead, name: 'tok', kind: 'generic', value: 'x' }, ctxOf(ownerId))).id;
  deadAppGrant = await issue(dead, deadSecret);
  await db.app.update({ where: { id: dead }, data: { deletedAt: new Date() } });
});

describe('endLiveSecretReadClients', () => {
  it('a dry run counts and writes nothing', async () => {
    const before = await db.grant.findMany({ orderBy: { id: 'asc' } });
    expect(await endLiveSecretReadClients(db, { revokedBy: operatorId, apply: false })).toEqual({ applied: false, candidates: 2, ended: 0 });
    expect(await db.grant.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    expect(await revokes()).toBe(0);
  });

  it('apply ends every live or pending secret.reveal grant, revoked_by paired with revoked_at, one REVOKE event each, and nothing else', async () => {
    expect(await endLiveSecretReadClients(db, { revokedBy: operatorId, apply: true })).toEqual({ applied: true, candidates: 2, ended: 2 });
    for (const id of [liveGrant, pendingGrant]) {
      const g = await grant(id);
      expect(g.revokedAt).not.toBeNull(); expect(g.revokedBy).toBe(operatorId);
      expect(await db.grantEvent.count({ where: { grantId: id, action: 'REVOKE', actorUserId: operatorId } })).toBe(1);
    }
    expect((await grant(otherActionGrant)).revokedAt).toBeNull();
    expect((await grant(deadAppGrant)).revokedAt).toBeNull();
    expect(await revokes()).toBe(2);
  });

  it('a second run ends nothing and writes no event', async () => {
    await endLiveSecretReadClients(db, { revokedBy: operatorId, apply: true });
    expect(await endLiveSecretReadClients(db, { revokedBy: operatorId, apply: true })).toEqual({ applied: true, candidates: 0, ended: 0 });
    expect(await revokes()).toBe(2);
  });

  it('leaves an already spent grant alone (the first end stands)', async () => {
    await db.$executeRaw`UPDATE grants SET use_count = use_count + 1 WHERE id = ${liveGrant}`;
    await db.$executeRaw`UPDATE grants SET use_count = use_count + 1 WHERE id = ${liveGrant}`;
    await db.$executeRaw`UPDATE grants SET use_count = use_count + 1 WHERE id = ${liveGrant}`;
    expect(await endLiveSecretReadClients(db, { revokedBy: operatorId, apply: true })).toMatchObject({ candidates: 1, ended: 1 });
    expect((await grant(liveGrant)).revokedAt).toBeNull();
  });

  it('an unknown or erased revoker refuses and writes nothing', async () => {
    await expect(endLiveSecretReadClients(db, { revokedBy: 'nobody', apply: true })).rejects.toBeInstanceOf(UnknownRevokerError);
    await db.user.update({ where: { id: operatorId }, data: { deletedAt: new Date() } });
    await expect(endLiveSecretReadClients(db, { revokedBy: operatorId, apply: true })).rejects.toBeInstanceOf(UnknownRevokerError);
    expect((await grant(liveGrant)).revokedAt).toBeNull();
    expect(await revokes()).toBe(0);
  });
});

describe('the read-client grant actions are one list (Bill, team chat #122006)', () => {
  it('is secret.reveal today, a registered platform action; S5 (#4000) adds secret.use to it', async () => {
    expect([...READ_CLIENT_GRANT_ACTIONS]).toEqual(['secret.reveal']);
    for (const name of READ_CLIENT_GRANT_ACTIONS) expect(await db.action.findUnique({ where: { name } })).not.toBeNull();
  });
  it('is the one place: the module names no action outside the list', () => {
    const src = readFileSync(new URL('../../src/lib/secrets/endReadClients.ts', import.meta.url), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code.match(/'secret\.[a-z-]+'/g)).toEqual(['\'secret.reveal\'']);
    expect(code).toMatch(/g\.action IN \(\$\{Prisma\.join\(READ_CLIENT_GRANT_ACTIONS\)\}\)/);
  });
});

describe('end-secret-read-clients tool', () => {
  it.each([[[]], [['--revoked-by']], [['--revoked-by', '--apply']], [['--apply']], [['--revoked-by', 'a', 'b']], [['--revoked-by', 'a', '--apply', '--apply']], [['--x']]])('usage %j exits 2', async (argv) => {
    expect(await main(argv as string[], io())).toBe(2);
  });

  it('no DATABASE_URL exits 2', async () => {
    expect(await main(['--revoked-by', operatorId], io({}))).toBe(2);
  });

  it('without --apply: exits 0, prints the dry-run count, writes nothing', async () => {
    expect(await main(['--revoked-by', operatorId], io())).toBe(0);
    expect(lines).toEqual(['db.secret_read_clients_end dry_run candidates=2 (pass --apply to end them)']);
    expect(await revokes()).toBe(0);
  });

  it('with --apply: exits 0 and prints counts only, never an id', async () => {
    expect(await main(['--revoked-by', operatorId, '--apply'], io())).toBe(0);
    expect(lines).toEqual(['db.secret_read_clients_end ok candidates=2 ended=2']);
    for (const id of [liveGrant, pendingGrant, secretId, appId, operatorId]) expect(lines.join('\n')).not.toContain(id);
    expect(await revokes()).toBe(2);
  });

  it('an unknown revoker exits 1 with fixed text that does not echo it', async () => {
    expect(await main(['--revoked-by', 'not-a-user-SENTINEL', '--apply'], io())).toBe(1);
    expect(lines.join('\n')).not.toContain('SENTINEL');
    expect(await revokes()).toBe(0);
  });
});
