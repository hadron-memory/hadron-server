/** #3107 retained-state startup regression; #3082 retires the team-tool-only #2123 cases. */
import { describe, it, expect } from 'vitest';
import { createServer } from '../server.js';
import { assertRateReadiness, RateConfigurationError } from '../lib/rateLimit/index.js';
import { readRateKeys } from '../lib/rateLimit/config.js';
import { db } from '../integrations/db/client.js';
import { cleanDb } from '../test/helpers.js';

async function startRequestSessionFixture() {
  await cleanDb(db);
  return createServer();
}

describe('startup fixture ownership (#3107)', () => {
  it('cleans a retained missing-key manifest before boot while raw startup refuses it', async () => {
    const savedRing = process.env.RATE_LIMIT_KEYRING;
    const restoreRing = () => {
      if (savedRing === undefined) delete process.env.RATE_LIMIT_KEYRING;
      else process.env.RATE_LIMIT_KEYRING = savedRing;
    };
    try {
      // Simulate an earlier file restoring its environment but leaving persisted state.
      try {
        process.env.RATE_LIMIT_KEYRING = JSON.stringify({ current: 'previous-file-3107', keys: { 'previous-file-3107': '3'.repeat(64) } });
        await assertRateReadiness(db);
      } finally {
        restoreRing();
      }
      const before = await db.rateLimitManifest.findUniqueOrThrow({ where: { id: 'global' } });
      expect(before.keyIds).toEqual(['previous-file-3107']);
      expect(before.keyIds.filter(id => readRateKeys().keys.has(id))).toEqual([]);
      await expect(createServer()).rejects.toBeInstanceOf(RateConfigurationError);
      const after = await db.rateLimitManifest.findUniqueOrThrow({ where: { id: 'global' } });
      expect(JSON.stringify(after) === JSON.stringify(before)).toBe(true);
      await expect(startRequestSessionFixture()).resolves.toBeDefined();
      expect((await db.rateLimitManifest.findUniqueOrThrow({ where: { id: 'global' } })).keyIds).toEqual([readRateKeys().current]);
    } finally {
      restoreRing();
      await cleanDb(db);
    }
  });
});
