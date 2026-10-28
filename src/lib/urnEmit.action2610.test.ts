/**
 * RED-FIRST pins for hadron-server#2610 — `emitActionUrnV2` in src/lib/urnEmit.ts
 * (Vera's Proposed cor:urn:010:01 amendment, issue comment 6447611964; the attach's
 * emit bullet: `emitActionUrnV2(agentBareUrn, code)`, code validated against the slug
 * charset and 64 characters — an invalid code emits nothing and is refused).
 *
 * Dynamic import on purpose: the export does not exist yet (urn-lib-js 0.0.18 is
 * dependency-held), and a static named import would fail the whole module load
 * instead of failing these tests cleanly.
 */

import { describe, it, expect } from 'vitest';

describe('#2610 emitActionUrnV2', () => {
  it('exists and composes hrn:action:<root>:<agent-slug>:<code> from the Agent\'s bare urn', async () => {
    const mod: any = await import('./urnEmit.js');
    expect(typeof mod.emitActionUrnV2).toBe('function');
    expect(mod.emitActionUrnV2('acme.example:team-agent', 'task.finish.open-children')).toBe(
      'hrn:action:acme.example:team-agent:task.finish.open-children',
    );
    // a stored urn carrying a legacy `@` sigil still composes (bareAtoms strips it)
    expect(mod.emitActionUrnV2('@acme.example:team-agent', 'alarm.ack')).toBe(
      'hrn:action:acme.example:team-agent:alarm.ack',
    );
  });

  it('refuses an invalid code atom (charset, length, empty) instead of emitting', async () => {
    const mod: any = await import('./urnEmit.js');
    if (typeof mod.emitActionUrnV2 !== 'function') {
      throw new Error('emitActionUrnV2 missing (RED: the #2610 emitter is not implemented)');
    }
    expect(() => mod.emitActionUrnV2('acme.example:team-agent', 'bad code!')).toThrow();
    expect(() => mod.emitActionUrnV2('acme.example:team-agent', 'áccent')).toThrow();
    expect(() => mod.emitActionUrnV2('acme.example:team-agent', 'x'.repeat(65))).toThrow();
    expect(() => mod.emitActionUrnV2('acme.example:team-agent', '')).toThrow();
  });
});
