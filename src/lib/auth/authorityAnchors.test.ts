import { describe, expect, it } from 'vitest';
import { db } from '../../integrations/db/client.js';
import { waitForLockWaitersOfType } from '../../test/lockWait.js';
import { lockAuthorityAnchors } from './authorityAnchors.js';

describe('authorization anchor locks', () => {
  it.each(['org', 'memory', 'app', 'user', 'connection', 'agent', 'invitation'] as const)(
    'makes a %s revoker wait for an in-flight grant transaction', async (kind) => {
    const anchor = { kind, id: `anchor-${Date.now()}-${Math.random()}` };
    let held!: () => void;
    let release!: () => void;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const grant = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [anchor], 'shared');
      held();
      await gate;
    }, { timeout: 15_000 });
    await holding;

    let revoked = false;
    const revoke = db.$transaction(async (tx) => {
      await lockAuthorityAnchors(tx, [anchor], 'exclusive');
      revoked = true;
    }, { timeout: 15_000 });
    try {
      await waitForLockWaitersOfType(db, 'advisory', 1, 2_000);
      expect(revoked).toBe(false);
    } finally {
      release();
      await Promise.allSettled([grant, revoke]);
    }
    expect(revoked).toBe(true);
  });
});
