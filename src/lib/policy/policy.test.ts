/**
 * Spec 040 / cor:acl:040 shape — the conjunctive policy chain (D-2026-07-04-A).
 */

import { describe, it, expect } from 'vitest';
import { allows, evaluatePolicyChain, parsePolicyLink } from './index.js';

describe('parsePolicyLink', () => {
  it('accepts { allow: string[] } and rejects everything else', () => {
    expect(parsePolicyLink({ allow: ['run.execute'] })).toEqual({ allow: ['run.execute'] });
    expect(parsePolicyLink({ allow: [] })).toEqual({ allow: [] });
    expect(parsePolicyLink(null)).toBeNull();
    expect(parsePolicyLink(undefined)).toBeNull();
    expect(parsePolicyLink('allow-all')).toBeNull();
    expect(parsePolicyLink(['run.execute'])).toBeNull();
    expect(parsePolicyLink({ allow: 'run.execute' })).toBeNull();
    expect(parsePolicyLink({ allow: [42] })).toBeNull();
  });
});

describe('allows — default-deny over the allow-list', () => {
  it('exact match', () => {
    expect(allows({ allow: ['memory.write'] }, 'memory.write')).toBe(true);
    expect(allows({ allow: ['memory.write'] }, 'memory.read')).toBe(false);
  });

  it('prefix wildcard', () => {
    expect(allows({ allow: ['memory.*'] }, 'memory.write')).toBe(true);
    expect(allows({ allow: ['memory.*'] }, 'memory.read')).toBe(true);
    expect(allows({ allow: ['memory.*'] }, 'llm.invoke')).toBe(false);
    // Prefix must respect the dot boundary: `tool.*` ≠ `toolbox.…`.
    expect(allows({ allow: ['tool.*'] }, 'tool.search')).toBe(true);
  });

  it('star allows everything; empty list allows nothing', () => {
    expect(allows({ allow: ['*'] }, 'comm.outbound')).toBe(true);
    expect(allows({ allow: [] }, 'run.execute')).toBe(false);
  });
});

describe('evaluatePolicyChain — strict conjunction, absent layers unrestrictive', () => {
  it('every PRESENT link must allow (the delegation ceiling)', () => {
    const org = { allow: ['*'] };
    const app = { allow: ['run.execute', 'llm.invoke', 'memory.*'] };
    const run = { allow: ['run.execute', 'llm.invoke', 'memory.write'] };
    expect(evaluatePolicyChain('memory.write', [org, app, run])).toBe(true);
    // The run layer narrows: memory.read allowed by app but not by run.
    expect(evaluatePolicyChain('memory.read', [org, app, run])).toBe(false);
    // A broader run layer can NOT widen past the app layer.
    expect(evaluatePolicyChain('comm.outbound', [org, { allow: ['llm.invoke'] }, { allow: ['*'] }])).toBe(false);
  });

  it('absent layers contribute no restriction', () => {
    expect(evaluatePolicyChain('run.execute', [null, undefined])).toBe(true);
    expect(evaluatePolicyChain('run.execute', [])).toBe(true);
    expect(evaluatePolicyChain('run.execute', [null, { allow: ['run.execute'] }])).toBe(true);
    expect(evaluatePolicyChain('comm.outbound', [null, { allow: ['run.execute'] }])).toBe(false);
  });
});
