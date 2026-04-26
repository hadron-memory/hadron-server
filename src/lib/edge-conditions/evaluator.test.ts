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
