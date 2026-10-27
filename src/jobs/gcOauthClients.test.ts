/**
 * #155: the GC for unused DCR OAuth clients. It soft-deletes a client 7 days
 * past its `expiresAt`, never touches a client that never expires (NULL),
 * never rewrites an existing deletion, and is a dry run until
 * OAUTH_CLIENT_GC_ENABLED=true (R220).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Client } from 'pg';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';
import { waitForLockWaiters } from '../test/lockWait.js';
import { generateId } from '../lib/id.js';
import { gcOauthClients, OAUTH_CLIENT_GC_GRACE_MS } from './gcOauthClients.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-01T00:00:00Z');
let seq = 0;

async function mkClient(expiresAt: Date | null, extra: { deletedAt?: Date; deletedBy?: string } = {}): Promise<string> {
  seq += 1;
  const clientId = `dcr_${seq.toString(16).padStart(32, '0')}`;
  await db.oAuthClient.create({
    data: { clientId, clientName: `c${seq}`, redirectUris: ['https://client.example/cb'], expiresAt, ...extra },
  });
  return clientId;
}

const row = (clientId: string) => db.oAuthClient.findUniqueOrThrow({ where: { clientId } });

let savedEnv: string | undefined;
beforeEach(async () => {
  await cleanDb(db);
  savedEnv = process.env.OAUTH_CLIENT_GC_ENABLED;
  delete process.env.OAUTH_CLIENT_GC_ENABLED;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.OAUTH_CLIENT_GC_ENABLED;
  else process.env.OAUTH_CLIENT_GC_ENABLED = savedEnv;
});

describe('gcOauthClients (apply)', () => {
  it('collects a client past the 7-day grace and records system:gc', async () => {
    const id = await mkClient(new Date(NOW.getTime() - 8 * DAY));
    const out = await gcOauthClients(db, { now: NOW, apply: true });
    expect(out).toMatchObject({ dryRun: false, collected: 1 });
    const r = await row(id);
    expect(r.deletedAt?.getTime()).toBe(NOW.getTime());
    expect(r.deletedBy).toBe('system:gc');
  });

  it('spares a client inside the grace, and one exactly at its edge', async () => {
    const inside = await mkClient(new Date(NOW.getTime() - 3 * DAY));
    const edge = await mkClient(new Date(NOW.getTime() - OAUTH_CLIENT_GC_GRACE_MS));
    expect((await gcOauthClients(db, { now: NOW, apply: true })).collected).toBe(0);
    expect((await row(inside)).deletedAt).toBeNull();
    expect((await row(edge)).deletedAt).toBeNull();
  });

  it('never touches a client that never expires', async () => {
    const id = await mkClient(null);
    await gcOauthClients(db, { now: NOW, apply: true });
    expect((await row(id)).deletedAt).toBeNull();
  });

  it('does not rewrite an existing deletion', async () => {
    const earlier = new Date('2026-01-01T00:00:00Z');
    const id = await mkClient(new Date(NOW.getTime() - 90 * DAY), { deletedAt: earlier, deletedBy: 'admin' });
    expect((await gcOauthClients(db, { now: NOW, apply: true })).collected).toBe(0);
    const r = await row(id);
    expect(r.deletedAt?.getTime()).toBe(earlier.getTime());
    expect(r.deletedBy).toBe('admin');
  });

  it('works in bounded batches: at most batchSize x maxPasses per run', async () => {
    for (let i = 0; i < 8; i++) await mkClient(new Date(NOW.getTime() - 30 * DAY));
    expect((await gcOauthClients(db, { now: NOW, apply: true, batchSize: 3, maxPasses: 2 })).collected).toBe(6);
    expect(await db.oAuthClient.count({ where: { deletedAt: null } })).toBe(2);
    expect((await gcOauthClients(db, { now: NOW, apply: true, batchSize: 3, maxPasses: 2 })).collected).toBe(2);
  });

  it('keeps the auth codes of a collected client (soft delete, no cascade)', async () => {
    const id = await mkClient(new Date(NOW.getTime() - 30 * DAY));
    const user = await db.user.create({ data: { id: generateId(), handle: 'gc155', githubId: 155155 } });
    await db.authCode.create({
      data: {
        codeHash: `h155-${generateId()}`, clientId: id, userId: user.id, redirectUri: 'https://client.example/cb',
        codeChallenge: 'x'.repeat(43), resource: ['https://hadron.example/mcp'], oauthScopes: ['mcp'],
        expiresAt: new Date(NOW.getTime() + DAY), createdBy: user.id,
      },
    });
    expect((await gcOauthClients(db, { now: NOW, apply: true })).collected).toBe(1);
    expect(await db.authCode.count({ where: { clientId: id } })).toBe(1);
  });

  it('re-checks the expiry under the row lock: a redemption that extends the client first wins', async () => {
    const id = await mkClient(new Date(NOW.getTime() - 30 * DAY));
    // A second connection plays the redemption: it holds the row and pushes
    // the expiry forward; the GC must wait and then see the new value.
    const redeemer = new Client({ connectionString: process.env.DATABASE_URL });
    await redeemer.connect();
    try {
      await redeemer.query('BEGIN');
      await redeemer.query('SELECT client_id FROM oauth_clients WHERE client_id = $1 FOR UPDATE', [id]);
      const run = gcOauthClients(db, { now: NOW, apply: true });
      await waitForLockWaiters(db);
      await redeemer.query('UPDATE oauth_clients SET expires_at = $2 WHERE client_id = $1', [
        id, new Date(NOW.getTime() + 30 * DAY),
      ]);
      await redeemer.query('COMMIT');
      expect((await run).collected).toBe(0);
      expect((await row(id)).deletedAt).toBeNull();
    } finally {
      await redeemer.end();
    }
  });
});

describe('gcOauthClients (dry run, R220)', () => {
  it('is a dry run unless OAUTH_CLIENT_GC_ENABLED=true: it counts and changes nothing', async () => {
    const id = await mkClient(new Date(NOW.getTime() - 30 * DAY));
    await mkClient(new Date(NOW.getTime() - 3 * DAY));
    await mkClient(null);
    process.env.OAUTH_CLIENT_GC_ENABLED = 'yes';
    const out = await gcOauthClients(db, { now: NOW });
    expect(out).toEqual({ dryRun: true, collectable: 1, collected: 0 });
    expect((await row(id)).deletedAt).toBeNull();
  });

  it('collects when OAUTH_CLIENT_GC_ENABLED=true', async () => {
    const id = await mkClient(new Date(NOW.getTime() - 30 * DAY));
    process.env.OAUTH_CLIENT_GC_ENABLED = 'true';
    expect(await gcOauthClients(db, { now: NOW })).toMatchObject({ dryRun: false, collected: 1 });
    expect((await row(id)).deletedBy).toBe('system:gc');
  });
});
