/**
 * Grammar-v2 URN emission helpers (#697 Stage 2). Pure — no DB.
 */
import { describe, it, expect } from 'vitest';
import {
  emitEntityUrnV2,
  emitNodeUrnV2,
  emitEdgeUrnV2,
  emitAssetUrnV2,
  emitInstalledAgentUrnV2,
} from './urnEmit.js';

describe('urnEmit (v2 emission)', () => {
  it('emits memory with the `mem` type word, single colon', () => {
    expect(emitEntityUrnV2('memory', 'baragaun.com:secureid')).toBe('hrn:mem:baragaun.com:secureid');
  });

  it('strips a legacy `@` owner sigil', () => {
    expect(emitEntityUrnV2('memory', '@holger:notes')).toBe('hrn:mem:holger:notes');
    expect(emitEntityUrnV2('agent', '@holger:helper')).toBe('hrn:agent:holger:helper');
  });

  it('collapses a residual `::` stored form', () => {
    expect(emitEntityUrnV2('memory', 'acme.com::specs')).toBe('hrn:mem:acme.com:specs');
  });

  it('emits org / agent / app with unchanged type words', () => {
    expect(emitEntityUrnV2('org', 'baragaun.com')).toBe('hrn:org:baragaun.com');
    expect(emitEntityUrnV2('agent', 'acme.com:coder')).toBe('hrn:agent:acme.com:coder');
    expect(emitEntityUrnV2('app', 'acme.com:ops')).toBe('hrn:app:acme.com:ops');
  });

  it('emits node / edge as flat root:mem:loc', () => {
    expect(emitNodeUrnV2('acme.com:mmdata', 'review:sort-imports')).toBe(
      'hrn:node:acme.com:mmdata:review:sort-imports',
    );
    expect(emitEdgeUrnV2('acme.com:mmdata', 'intro:next')).toBe('hrn:edge:acme.com:mmdata:intro:next');
  });

  it('emits the v2 asset shape', () => {
    expect(emitAssetUrnV2('acme.com:mmdata', 'cl0abc')).toBe('hrn:asset:acme.com:mmdata:assets:cl0abc');
  });

  it('emits an installed agent as its author-rooted v2 URN (D10, no install chain)', () => {
    expect(emitInstalledAgentUrnV2('acme.com:coder')).toBe('hrn:agent:acme.com:coder');
  });

  it('throws on a corrupt (rootless) stored form so callers can fall back', () => {
    expect(() => emitEntityUrnV2('memory', '')).toThrow();
  });
});
