/**
 * Conformance test (SC-001): every grounded condition from the
 * brainstorming evaluates to its expected boolean against a synthesized
 * runtime context. The fixture itself lives in fixture-24.ts and is
 * imported by both the unit-level tests (here) and the US-level
 * integration tests (when those land).
 *
 * For US1 scope, we run every fixture entry — the evaluator already
 * supports all five scopes and the single-layer cascade. Multi-layer
 * cascade and encrypted-memory failures are exercised in their own
 * dedicated tests (US3, US4) when they land.
 */

import { describe, it, expect } from 'vitest';
import { evaluateEdgeCondition } from './evaluator.js';
import type { MemoryLayerHandle } from './scope-resolver.js';
import { FIXTURE_24, type FixtureContext } from './fixture-24.js';

function buildLayer(name: string, data: Record<string, unknown> | undefined): MemoryLayerHandle {
  return {
    layerName: name,
    async read(path: string) {
      if (!data) return { ok: true, value: undefined };
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

function buildLayers(ctx: FixtureContext): MemoryLayerHandle[] {
  const layers: MemoryLayerHandle[] = [];
  if (ctx.edgeMemory !== undefined) layers.push(buildLayer('edge', ctx.edgeMemory));
  if (ctx.userMemory !== undefined) layers.push(buildLayer('user', ctx.userMemory));
  return layers;
}

describe('edge-conditions / 24-condition conformance fixture', () => {
  it('contains exactly 24 entries', () => {
    expect(FIXTURE_24).toHaveLength(24);
  });

  it.each(FIXTURE_24)('#$id [$agent]: $description', async (entry) => {
    const result = await evaluateEdgeCondition({
      condition: entry.condition,
      edge: { id: `edge-fixture-${entry.id}`, sourceNodeUrn: 'urn:test' },
      memoryLayers: buildLayers(entry.context),
      chat: entry.context.chat,
      agent: entry.context.agent ?? {},
      messageData: entry.context.messageData,
      clock: entry.context.clockIso ? () => new Date(entry.context.clockIso!) : undefined,
    });

    expect(result.ok, `evaluator error: ${JSON.stringify(result.ok ? null : result.error)}`).toBe(true);
    if (result.ok) {
      expect(result.fired).toBe(entry.expected);
    }
  });
});
