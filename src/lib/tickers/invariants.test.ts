import { WORKER_SIGNATURE_DEFAULTS } from '../workerSignature.js';
/**
 * #1747 — prisma/ticker-invariants.sql is the single source for the ticker
 * facts Prisma cannot model; the migration carries a byte-identical copy and
 * post-push.sql includes the file. The database facts themselves are exercised
 * through the resolvers (resolvers.ticker.test.ts); here, the ones no resolver
 * path reaches.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { db } from '../../integrations/db/client.js';
import { cleanDb } from '../../test/helpers.js';
import { generateId } from '../id.js';

describe('ticker-invariants.sql (#1747)', () => {
  it('the migration carries a byte-identical copy of the invariants file', () => {
    const source = readFileSync(new URL('../../../prisma/ticker-invariants.sql', import.meta.url), 'utf8');
    const migration = readFileSync(new URL('../../../prisma/migrations/20261011020000_tickers/migration.sql', import.meta.url), 'utf8');
    expect(migration.endsWith(source)).toBe(true);
  });

  it('post-push.sql includes the invariants file', () => {
    const post = readFileSync(new URL('../../../prisma/post-push.sql', import.meta.url), 'utf8');
    expect(post).toContain('\\ir ticker-invariants.sql');
  });

  describe('constraints', () => {
    let appId: string;
    let workerId: string;
    let tickerId: string;
    beforeEach(async () => {
      await cleanDb(db);
      const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`;
      const org = await db.organization.create({ data: { id: generateId(), name: 'ti-org', urn: `ti-org-${suffix}.com` } });
      const user = await db.user.create({ data: { id: generateId(), githubId: 95_000, githubUsername: `ti-${suffix}`, roles: ['READER'] } });
      const agent = await db.agent.create({ data: { id: generateId(), name: 'A', organizationId: org.id, urn: `${org.urn}:a` } as never });
      appId = (await db.app.create({ data: { id: generateId(), organizationId: org.id, name: 'T', urn: `${org.urn}:t` } })).id;
      workerId = (await db.worker.create({ data: { ...WORKER_SIGNATURE_DEFAULTS, id: generateId(), appId, agentId: agent.id, name: 'W', slug: 'w' } })).id;
      tickerId = (await db.ticker.create({ data: { tickCode: 'tick.fixture', appId, name: 'E', slug: 'e', cadenceSeconds: 600, ownerUserId: user.id } })).id;
    });

    const bad = (p: Promise<unknown>, re: RegExp) => expect(p).rejects.toThrow(re);

    it('a ticker has exactly one owner and a bounded cadence, a closed relevance, a well-formed slug', async () => {
      const base = { tickCode: 'tick.fixture', appId, name: 'X', slug: 'x', cadenceSeconds: 600 };
      await bad(db.ticker.create({ data: base }), /chk_tickers_shape/);
      await bad(db.ticker.create({ data: { ...base, ownerUserId: 'u', ownerWorkerId: workerId } }), /chk_tickers_shape/);
      await bad(db.ticker.create({ data: { ...base, ownerWorkerId: workerId, cadenceSeconds: 86_401 } }), /chk_tickers_shape/);
      await bad(db.ticker.create({ data: { ...base, ownerWorkerId: workerId, relevance: 'SOME' } }), /chk_tickers_shape/);
      await bad(db.ticker.create({ data: { ...base, ownerWorkerId: workerId, slug: 'Bad Slug' } }), /chk_tickers_shape/);
    });

    it('a live name is unique ignoring case; the slug is unique forever', async () => {
      const mk = (name: string, slug: string, extra: Record<string, unknown> = {}) =>
        db.ticker.create({ data: { tickCode: 'tick.fixture', appId, name, slug, cadenceSeconds: 600, ownerWorkerId: workerId, ...extra } });
      await bad(mk('e', 'other'), /Unique constraint|tickers_app_name_live_uniq/);
      await db.ticker.update({ where: { id: tickerId }, data: { deletedAt: new Date() } });
      await expect(mk('E', 'e2')).resolves.toBeTruthy();
      // The deleted ticker still holds its slug.
      await bad(mk('Fresh', 'e'), /Unique constraint|tickers_app_slug_uniq/);
    });

    it('one live subscription per ticker and worker; an ended one needs a reason from the closed list', async () => {
      await db.tickerSubscription.create({ data: { tickerId, workerId } });
      await bad(db.tickerSubscription.create({ data: { tickerId, workerId } }), /Unique constraint|ticker_subscriptions_live_uniq/);
      const live = await db.tickerSubscription.findFirstOrThrow({ where: { tickerId, workerId } });
      await bad(db.tickerSubscription.update({ where: { id: live.id }, data: { endedAt: new Date() } }), /chk_ticker_subscriptions_shape/);
      await bad(db.tickerSubscription.update({ where: { id: live.id }, data: { endedAt: new Date(), endedReason: 'DORMANT' } }), /chk_ticker_subscriptions_shape/);
      await bad(db.tickerSubscription.update({ where: { id: live.id }, data: { endedReason: 'UNSUBSCRIBED' } }), /chk_ticker_subscriptions_shape/);
      await expect(db.tickerSubscription.update({ where: { id: live.id }, data: { endedAt: new Date(), endedReason: 'UNSUBSCRIBED' } })).resolves.toBeTruthy();
    });

    it('wake settings come from the closed list; there is no ON_TICK', async () => {
      await bad(db.workerWakeSettings.create({ data: { workerId, mentions: 'ON_TICK' } }), /chk_worker_wake_settings_shape/);
    });

    it('the App ticker settings are bounded in the database too', async () => {
      await bad(db.app.update({ where: { id: appId }, data: { tickerMinCadenceSeconds: 59 } }), /chk_apps_ticker_settings/);
      await bad(db.app.update({ where: { id: appId }, data: { tickerLiveCap: 101 } }), /chk_apps_ticker_settings/);
      await bad(db.app.update({ where: { id: appId }, data: { tickerSelfSubscribeCadenceSeconds: 100 } }), /chk_apps_ticker_settings/);
    });

    it('the delivery-record tables key on their natural keys and cascade with the worker', async () => {
      const ch = { workerId, channelId: generateId(), deliveredThroughSeq: 3, deliveredAt: new Date() };
      await db.workerDeliveryChannel.create({ data: ch });
      await db.workerDeliveryTick.create({ data: { workerId, tickerId, lastAckedTick: 2, ackedAt: new Date() } });
      await db.worker.delete({ where: { id: workerId } });
      expect(await db.workerDeliveryChannel.count()).toBe(0);
      expect(await db.workerDeliveryTick.count()).toBe(0);
    });
  });
});
