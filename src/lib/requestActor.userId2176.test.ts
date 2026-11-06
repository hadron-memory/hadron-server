/**
 * #2176 — the validated user rides the RequestActor holder beside the Worker / Agent.
 * Pure holder semantics; the writes and the wire are pinned in
 * src/mcp/server.updatedByUser2176.test.ts and resolvers.nodeUpdatedByUser2176.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  currentActor, emptyActor, publishActor, publishUser, requestActorStorage,
  runAsActor, runAsSystem, runInChildActorScope,
} from './requestActor.js';

const inRequest = <T>(fn: () => Promise<T>) => requestActorStorage.run(emptyActor(), fn);
const tick = () => new Promise((r) => setTimeout(r, 1));

describe('RequestActor.userId (#2176)', () => {
  it('is nobody outside a request and inside an empty holder', async () => {
    expect(currentActor().userId ?? null).toBeNull();
    await inRequest(async () => { expect(currentActor().userId ?? null).toBeNull(); });
  });

  it('publishUser sets it; publishActor (naming or un-naming a session) never touches it', async () => {
    await inRequest(async () => {
      publishUser('u1');
      publishActor({ workerId: 'w', agentId: 'a' });
      expect(currentActor().userId).toBe('u1');
      publishActor({ workerId: null, agentId: null });
      expect(currentActor().userId).toBe('u1');
    });
  });

  it('a child scope inherits the user and its own publishes stay inside it', async () => {
    await inRequest(async () => {
      publishUser('u1');
      await runInChildActorScope(async () => {
        expect(currentActor().userId).toBe('u1');
        publishUser('u2');
        expect(currentActor().userId).toBe('u2');
      });
      expect(currentActor().userId).toBe('u1');
    });
  });

  it('concurrent sibling scopes (a JSON-RPC batch) each keep their own user', async () => {
    for (let round = 0; round < 5; round++) {
      await inRequest(async () => {
        publishUser('parent');
        const seen = await Promise.all(['a', 'b', 'c', 'd'].map((u, i) => runInChildActorScope(async () => {
          publishUser(u);
          await tick();
          if (i % 2) await tick();
          return currentActor().userId;
        })));
        expect(seen).toEqual(['a', 'b', 'c', 'd']);
        expect(currentActor().userId).toBe('parent');
      });
    }
  });

  it('two overlapping requests never see each other\'s user', async () => {
    const run = (u: string) => inRequest(async () => { publishUser(u); await tick(); return currentActor().userId; });
    expect(await Promise.all([run('x'), run('y'), run('z')])).toEqual(['x', 'y', 'z']);
  });

  it('runAsSystem clears the user inside, and only inside', async () => {
    await inRequest(async () => {
      publishUser('u1');
      await runAsSystem(async () => { expect(currentActor().userId ?? null).toBeNull(); });
      expect(currentActor().userId).toBe('u1');
    });
  });

  it('runAsActor inherits the surrounding user unless the actor names one', async () => {
    await inRequest(async () => {
      publishUser('u1');
      await runAsActor({ workerId: 'w', agentId: 'a' }, async () => { expect(currentActor().userId).toBe('u1'); });
      await runAsActor({ workerId: 'w', agentId: 'a', userId: null }, async () => { expect(currentActor().userId ?? null).toBeNull(); });
      await runAsActor({ workerId: 'w', agentId: 'a', userId: 'u9' }, async () => { expect(currentActor().userId).toBe('u9'); });
    });
    // a headless run with no surrounding request has no user
    await runAsActor({ workerId: 'w', agentId: 'a' }, async () => { expect(currentActor().userId ?? null).toBeNull(); });
  });

  it('publishUser is a no-op outside a holder', () => {
    publishUser('u1');
    expect(currentActor().userId ?? null).toBeNull();
  });
});
