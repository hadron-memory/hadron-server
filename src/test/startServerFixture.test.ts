/** #3066: the shared start-the-app helper and its teardown. */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from '../server.js';
import { db } from '../integrations/db/client.js';
import { assertRateReadiness, RateConfigurationError } from '../lib/rateLimit/index.js';
import { readRateKeys } from '../lib/rateLimit/config.js';
import { cleanDb } from './helpers.js';
import { closeServerIfStarted, createServerOnCleanDb } from './startServerFixture.js';

const savedRing = process.env.RATE_LIMIT_KEYRING;
const restoreRing = () => {
  if (savedRing === undefined) delete process.env.RATE_LIMIT_KEYRING;
  else process.env.RATE_LIMIT_KEYRING = savedRing;
};
afterEach(async () => { restoreRing(); await cleanDb(db); });

/** An earlier file restored its environment but left the manifest it planted. */
async function retainForeignManifest(keyId: string, keyHex: string) {
  try {
    process.env.RATE_LIMIT_KEYRING = JSON.stringify({ current: keyId, keys: { [keyId]: keyHex } });
    await cleanDb(db);
    await assertRateReadiness(db);
  } finally {
    restoreRing();
  }
}

describe('createServerOnCleanDb (#3066)', () => {
  it('boots over a retained manifest whose key is gone, where raw startup refuses it', async () => {
    await retainForeignManifest('previous-file-3066', '5'.repeat(64));
    expect(readRateKeys().keys.has('previous-file-3066')).toBe(false);
    await expect(createServer()).rejects.toBeInstanceOf(RateConfigurationError); // the unhardened shape is red
    expect(typeof await createServerOnCleanDb()).toBe('function'); // the Express app
    // The valid seeded state is restored, not stubbed: the manifest now names the real ring.
    expect((await db.rateLimitManifest.findUniqueOrThrow({ where: { id: 'global' } })).keyIds).toEqual([readRateKeys().current]);
  });

  it('boots over a retained manifest holding this key id under another secret (fingerprint mismatch)', async () => {
    const { current } = readRateKeys();
    await retainForeignManifest(current, '6'.repeat(64));
    await expect(createServer()).rejects.toBeInstanceOf(RateConfigurationError);
    await expect(createServerOnCleanDb()).resolves.toBeDefined();
  });

  it('still refuses an invalid configuration (control: the helper does not stub readiness)', async () => {
    process.env.RATE_LIMIT_KEYRING = 'not-a-keyring';
    await expect(createServerOnCleanDb()).rejects.toThrow();
  });

  it('still refuses a manifest whose keys are missing when the cleanup is bypassed', async () => {
    await retainForeignManifest('previous-file-3066-b', '7'.repeat(64));
    await expect(createServer()).rejects.toBeInstanceOf(RateConfigurationError);
  });
});

describe('closeServerIfStarted (#3066)', () => {
  it('is a no-op when the server was never assigned, so the startup error stays primary', async () => {
    await expect(closeServerIfStarted(undefined)).resolves.toBeUndefined();
  });

  it('does not reject for a server that was created but never listened', async () => {
    await expect(closeServerIfStarted(createHttpServer())).resolves.toBeUndefined();
  });

  it('closes a listening server', async () => {
    const server = createHttpServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    await closeServerIfStarted(server);
    expect(server.listening).toBe(false);
  });
});
