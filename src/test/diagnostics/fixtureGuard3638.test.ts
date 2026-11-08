import { expect, it, vi } from 'vitest';
import { guardFixtureClient3638 } from './fixtureGuard3638.js';
it('refuses model and raw calls during a span, including methods captured before it', async () => {
    let active = false;
    const query = vi.fn(async () => []);
    const client = guardFixtureClient3638({ agent: { findMany: query }, $queryRaw: query }, () => active);
    const captured = client.agent.findMany;
    await captured();
    active = true;
    expect(() => captured()).toThrow('unmeasured fixture/global client');
    expect(() => client.$queryRaw()).toThrow('unmeasured fixture/global client');
    expect(query).toHaveBeenCalledTimes(1);
    active = false;
    await client.$queryRaw();
    expect(query).toHaveBeenCalledTimes(2);
});
it('preserves delegate method binding and non-function properties outside spans', () => {
    const client = guardFixtureClient3638({ agent: { label: 'agents', name() { return this.label; } } }, () => false);
    expect(client.agent.label).toBe('agents');
    expect(client.agent.name()).toBe('agents');
});
