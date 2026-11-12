import { describe, it, expect } from 'vitest';
import { evaluateEdgeCondition, type EvaluateRequest } from './evaluator.js';
import type { MemoryLayerHandle } from './scope-resolver.js';
import type { EncryptedMemoryError } from './errors.js';

/**
 * In-memory layer that resolves dotted paths against a flat object.
 * Useful for unit tests; the real edge-resolver call site builds layers
 * over Prisma reads.
 */
function inMemoryLayer(
  name: string,
  data: Record<string, unknown>,
): MemoryLayerHandle {
  return {
    layerName: name,
    async read(path: string) {
      const parts = path.split('.');
      let cur: unknown = data;
      for (const part of parts) {
        if (cur === null || cur === undefined || typeof cur !== 'object') {
          return { ok: true, value: undefined };
        }
        cur = (cur as Record<string, unknown>)[part];
      }
      return { ok: true, value: cur };
    },
  };
}

function failingLayer(memoryUrn: string): MemoryLayerHandle {
  return {
    layerName: 'encrypted',
    async read() {
      const error: EncryptedMemoryError = {
        reason: 'key_unavailable',
        memoryUrn,
      };
      return { ok: false, error };
    },
  };
}

function baseRequest(over: Partial<EvaluateRequest>): EvaluateRequest {
  return {
    condition: null,
    edge: { id: 'edge-test', sourceNodeUrn: 'urn:test:node' },
    memoryLayers: [],
    agent: {},
    ...over,
  };
}

describe('edge-conditions / evaluateEdgeCondition', () => {
  describe('null condition', () => {
    it('fires unconditionally when condition is null', async () => {
      const result = await evaluateEdgeCondition(baseRequest({ condition: null }));
      expect(result).toEqual({ ok: true, fired: true });
    });

    it('fires unconditionally when condition is undefined', async () => {
      const result = await evaluateEdgeCondition(baseRequest({ condition: undefined }));
      expect(result).toEqual({ ok: true, fired: true });
    });
  });

  describe('comparison operators', () => {
    it('==', async () => {
      const result = await evaluateEdgeCondition(baseRequest({
        condition: { '==': [{ var: 'memory.business_type' }, 'tech'] },
        memoryLayers: [inMemoryLayer('edge', { business_type: 'tech' })],
      }));
      expect(result).toEqual({ ok: true, fired: true });
    });

    it('< returns false when not satisfied', async () => {
      const result = await evaluateEdgeCondition(baseRequest({
        condition: { '<': [{ var: 'memory.runway_months' }, 3] },
        memoryLayers: [inMemoryLayer('edge', { runway_months: 6 })],
      }));
      expect(result).toEqual({ ok: true, fired: false });
    });
  });

  describe('logical operators', () => {
    it('and: both clauses true', async () => {
      const result = await evaluateEdgeCondition(baseRequest({
        condition: {
          and: [
            { missing: ['memory.business_type'] },
            { '>': [{ var: 'chat.message_count' }, 20] },
          ],
        },
        memoryLayers: [inMemoryLayer('edge', {})],
        chat: { message_count: 23 },
      }));
      expect(result).toEqual({ ok: true, fired: true });
    });

    it('or: short-circuits', async () => {
      const result = await evaluateEdgeCondition(baseRequest({
        condition: {
          or: [
            { '==': [{ var: 'memory.revenue_status' }, 'struggling' ] },
            { '<': [{ var: 'memory.runway_months' }, 3] },
          ],
        },
        memoryLayers: [inMemoryLayer('edge', { runway_months: 2 })],
      }));
      expect(result).toEqual({ ok: true, fired: true });
    });

    it('!: negation', async () => {
      const result = await evaluateEdgeCondition(baseRequest({
        condition: { '!': { '==': [{ var: 'memory.stage' }, 'idea'] } },
        memoryLayers: [inMemoryLayer('edge', { stage: 'growth' })],
      }));
      expect(result).toEqual({ ok: true, fired: true });
    });
  });

  describe('membership and missing', () => {
    it('in: value found', async () => {
      const result = await evaluateEdgeCondition(baseRequest({
        condition: { in: [{ var: 'memory.industry' }, ['tech', 'healthcare', 'retail']] },
        memoryLayers: [inMemoryLayer('edge', { industry: 'healthcare' })],
      }));
      expect(result).toEqual({ ok: true, fired: true });
    });

    it('missing: returns the array of missing fields (truthy if any missing)', async () => {
      const result = await evaluateEdgeCondition(baseRequest({
        condition: { missing: ['memory.business_type', 'memory.team_size'] },
        memoryLayers: [inMemoryLayer('edge', { business_type: 'tech' })],
      }));
      expect(result).toEqual({ ok: true, fired: true });
    });
  });

  // #4056 / V85: the FINAL result fires exactly when jsonLogic.truthy(result). `missing` / `missing_some` return an
  // array, and JSONLogic's empty array is falsy; `and` / `or` hand their operand back raw, so `[]` can arrive
  // at the final coercion. Only `[]` changes versus Boolean(result); validation and refusals are untouched.
  describe('final-result truthiness (#4056, V85)', () => {
    const mem = { a: 'x' };
    const run = (condition: unknown, data: Record<string, unknown> = mem) =>
      evaluateEdgeCondition(baseRequest({ condition, memoryLayers: [inMemoryLayer('edge', data)] }));
    const M_A = { missing: ['memory.a'] };
    const M_B = { missing: ['memory.b'] };
    const rows: Array<[label: string, condition: unknown, fired: boolean]> = [
      ['1 bare missing, field present ([])', M_A, false],
      ['2 bare missing, field absent (["b"])', M_B, true],
      ['3 missing_some, enough present ([])', { missing_some: [1, ['memory.a', 'memory.b']] }, false],
      ['4 missing_some, too few present (["b"])', { missing_some: [2, ['memory.a', 'memory.b']] }, true],
      ['5 and [true, missing-nothing]', { and: [true, M_A] }, false],
      ['6 or [false, missing-nothing]', { or: [false, M_A] }, false],
      ['8 and [missing-nothing, missing-something] (fixture-24 shape)', { and: [M_A, M_B] }, false],
      ['9 not of missing-nothing', { '!': M_A }, true],
      ['10 and [missing-b, missing-c] (last operand non-empty)', { and: [M_B, { missing: ['memory.c'] }] }, true],
      ['11a final 0', 0, false],
      ['11b final ""', '', false],
      ['11c final null var (absent path)', { var: 'memory.z' }, false],
      ['12a final "0"', '0', true],
      ['12b final 1', 1, true],
      ['13 final [0] (non-empty array)', [0], true],
      ['14 final {} (empty object)', {}, true],
      ['15 final [] literal', [], false],
    ];
    it.each(rows)('%s', async (_label, condition, fired) => {
      expect(await run(condition)).toEqual({ ok: true, fired });
    });
    it('row 7 is moot: `if` is outside the v1 allowlist, so validation still refuses it (unchanged by V85)', async () => {
      const r = await run({ if: [true, M_A, true] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('DISALLOWED_OPERATOR');
    });
    it('an absent condition still fires, and a validation refusal is still a refusal, never "does not fire"', async () => {
      expect(await run(null)).toEqual({ ok: true, fired: true });
      const bad = await run({ cat: ['a', 'b'] });
      expect(bad.ok).toBe(false);
    });
    it('a failing (encrypted) memory layer still refuses rather than firing or not firing', async () => {
      const r = await evaluateEdgeCondition(baseRequest({ condition: M_A, memoryLayers: [failingLayer('hadronmemory.com:secureid:u1')] }));
      expect(r.ok).toBe(false);
    });
  });

  describe('arithmetic', () => {
    it('multiplication inside a comparison', async () => {
      const result = await evaluateEdgeCondition(baseRequest({
        condition: { '<': [{ var: 'memory.cumulative.protein' }, { '*': [{ var: 'memory.targets.protein' }, 0.8] }] },
        memoryLayers: [inMemoryLayer('edge', {
          cumulative: { protein: 50 },
          targets: { protein: 100 },
        })],
      }));
      expect(result).toEqual({ ok: true, fired: true });
    });
  });

  describe('time builtins', () => {
    it('now() resolves from injected clock', async () => {
      const fixed = new Date('2026-04-26T10:00:00.000Z');
      const result = await evaluateEdgeCondition(baseRequest({
        condition: { '<': [{ var: 'now()' }, '2027-01-01T00:00:00.000Z'] },
        memoryLayers: [],
        clock: () => fixed,
      }));
      expect(result).toEqual({ ok: true, fired: true });
    });

    it('today() returns the YYYY-MM-DD slice from the clock', async () => {
      const fixed = new Date('2026-04-26T10:00:00.000Z');
      const result = await evaluateEdgeCondition(baseRequest({
        condition: { '==': [{ var: 'today()' }, '2026-04-26'] },
        memoryLayers: [],
        clock: () => fixed,
      }));
      expect(result).toEqual({ ok: true, fired: true });
    });
  });

  describe('agent and chat scopes', () => {
    it('agent.config dot-path resolution', async () => {
      const result = await evaluateEdgeCondition(baseRequest({
        condition: { '>=': [{ var: 'message.data.confidence' }, { var: 'agent.config.confidence_threshold' }] },
        memoryLayers: [],
        agent: { config: { confidence_threshold: 0.85 } },
        messageData: { confidence: 0.9 },
      }));
      expect(result).toEqual({ ok: true, fired: true });
    });

    it('chat scope absent when ctx has no chat', async () => {
      const result = await evaluateEdgeCondition(baseRequest({
        condition: { missing: ['chat.message_count'] },
        memoryLayers: [],
      }));
      expect(result).toEqual({ ok: true, fired: true });
    });
  });

  describe('two-layer cascade (US3)', () => {
    it('user-memory layer overrides edge-memory layer when both have the field', async () => {
      const result = await evaluateEdgeCondition(baseRequest({
        condition: { '<': [{ var: 'memory.threshold' }, 5] },
        memoryLayers: [
          inMemoryLayer('edge', { threshold: 6 }),  // default = 6 (would not satisfy <5)
          inMemoryLayer('user', { threshold: 3 }),  // override = 3 (satisfies <5)
        ],
      }));
      expect(result).toEqual({ ok: true, fired: true });
    });

    it('falls back to edge-memory when user-memory does not have the field', async () => {
      const result = await evaluateEdgeCondition(baseRequest({
        condition: { '==': [{ var: 'memory.greeting' }, 'hello'] },
        memoryLayers: [
          inMemoryLayer('edge', { greeting: 'hello' }),
          inMemoryLayer('user', {}),                // user has nothing
        ],
      }));
      expect(result).toEqual({ ok: true, fired: true });
    });

    it('user-memory completely missing the path leaves edge-memory value intact', async () => {
      const result = await evaluateEdgeCondition(baseRequest({
        condition: { '==': [{ var: 'memory.locale' }, 'en'] },
        memoryLayers: [
          inMemoryLayer('edge', { locale: 'en' }),
          inMemoryLayer('user', { other_field: 'unrelated' }),
        ],
      }));
      expect(result).toEqual({ ok: true, fired: true });
    });

    it('three-layer cascade: deepest wins', async () => {
      // Models the future case where additional layers (e.g., per-team
      // overrides) might be inserted between edge-memory and user-memory.
      // The contract guarantees later layers win.
      const result = await evaluateEdgeCondition(baseRequest({
        condition: { '==': [{ var: 'memory.role' }, 'owner'] },
        memoryLayers: [
          inMemoryLayer('edge', { role: 'reader' }),
          inMemoryLayer('team', { role: 'contributor' }),
          inMemoryLayer('user', { role: 'owner' }),
        ],
      }));
      expect(result).toEqual({ ok: true, fired: true });
    });

    it('single-layer (no user memory) still works for single-user agents', async () => {
      const result = await evaluateEdgeCondition(baseRequest({
        condition: { '==': [{ var: 'memory.greeting' }, 'hi'] },
        memoryLayers: [inMemoryLayer('edge', { greeting: 'hi' })],
      }));
      expect(result).toEqual({ ok: true, fired: true });
    });
  });

  describe('encrypted memory', () => {
    it('surfaces MEMORY_ENCRYPTED_NO_KEY when a layer cannot read', async () => {
      const result = await evaluateEdgeCondition(baseRequest({
        condition: { '==': [{ var: 'memory.relationships.has_partner' }, true] },
        memoryLayers: [failingLayer('hadronmemory.com:secureid:user-1')],
      }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_ENCRYPTED_NO_KEY');
        expect(result.error.detail.edgeId).toBe('edge-test');
        expect(result.error.detail.field).toBe('memory.relationships.has_partner');
        expect(result.error.detail.memoryUrn).toBe('hadronmemory.com:secureid:user-1');
      }
    });
  });

  describe('validation errors surface through evaluate', () => {
    it('DISALLOWED_OPERATOR carries edgeId in detail', async () => {
      const result = await evaluateEdgeCondition(baseRequest({
        condition: { cat: ['a', 'b'] },
      }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('DISALLOWED_OPERATOR');
        expect(result.error.detail.edgeId).toBe('edge-test');
        expect(result.error.detail.operator).toBe('cat');
      }
    });
  });
});
