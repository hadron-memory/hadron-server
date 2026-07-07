/**
 * Production RunExecutionDeps (spec 040 plan §6 + plan-multi-node §4) — the
 * seams between the run kernel and the platform:
 *
 *  - assemble: delegates to the runTask resolver with a synthesized Context
 *    (the MCP delegation pattern) — placeholder substitution, dependency
 *    inlining, and the usage event come for free, and read authorization
 *    runs under the run's principal. Multi-node: called per flow node with
 *    the merged view (eventData + envelope) as template args, so templates
 *    and edge conditions never disagree about a field's value (D-MN-1).
 *  - loadNodeSpec: the flow-relevant slice of a node's data — extraction
 *    spec (validated against the reserved namespace) + output flag.
 *  - selectNext: the D7/D-MN-4 edge walk over the shared evaluator.
 *  - resolveConfig: trigger override name → spec-036 registry walk.
 *  - writeOutput: the CURRENT node's data.output { writeTo, mode } →
 *    node-write core under the run principal ('replace' default; 'append'
 *    folds onto existing content). No output spec → runs:<runId> beside
 *    that node.
 */

import type { PrismaClient, AppRun } from '../generated/prisma/index.js';
import { resolvers, type Context } from '../api/graphql/schema/resolvers.js';
import { writeNodeCore } from '../api/graphql/schema/resolvers.mutation.node.js';
import { resolveAiConfigWithFallback, type ResolvedAiConfig } from '../lib/aiConfig.js';
import { generateText, generateExtraction, type ExtractionField } from '../lib/llm/index.js';
import { validateExtractionSpec } from '../lib/edge-conditions/reserved-names.js';
import { selectNextEdge } from '../lib/runner/selectNextEdge.js';
import { splitNodeUrn, normalizeUrnForLookup, legacyMemoryUrnToCanonical } from '../lib/urn.js';
import type { RunExecutionDeps, RunNodeSpec } from './appRuns.js';
import { dispatchRunCallback } from '../api/webhooks.js';

function runContext(db: PrismaClient, run: AppRun): Context {
  // The run principal (cor:agt:010:01): App + optional on-behalf-of user.
  // No roles — a run never carries platform-admin authority.
  return {
    db,
    appId: run.appId,
    userId: run.userId ?? undefined,
    organizationId: run.organizationId,
    clientId: `run:${run.id}`,
  };
}

interface OutputSpec {
  writeTo?: string;
  mode?: 'replace' | 'append';
}

async function loadFlowNode(db: PrismaClient, nodeUrn: string, organizationId: string) {
  const { memoryUrn, loc } = splitNodeUrn(nodeUrn);
  const normalized = normalizeUrnForLookup(memoryUrn);
  // Tenant-scoped: a URN can only resolve inside the run's own organization
  // (PR-493 review, Gemini security) — cross-org reads are not a run
  // capability in v1 regardless of URN knowledge.
  const memory = await db.memory.findFirst({
    where: {
      OR: [{ urn: normalized }, { urn: legacyMemoryUrnToCanonical(normalized) }],
      organizationId,
      deletedAt: null,
    },
    select: { id: true, urn: true },
  });
  if (!memory) throw new Error(`Flow memory not found for "${nodeUrn}".`);
  const node = await db.node.findUnique({
    where: { loc_memoryId: { loc, memoryId: memory.id } },
    select: { id: true, name: true, data: true, deletedAt: true },
  });
  if (!node || node.deletedAt) throw new Error(`Flow node not found: "${nodeUrn}".`);
  return { memory, loc, node };
}

export function makeProdRunDeps(db: PrismaClient): RunExecutionDeps {
  return {
    assemble: async (run, nodeUrn, view) => {
      return resolvers.Mutation.runTask(
        {},
        { urn: nodeUrn, args: Object.keys(view).length > 0 ? view : undefined },
        runContext(db, run),
      );
    },

    loadNodeSpec: async (run, nodeUrn): Promise<RunNodeSpec> => {
      const { node } = await loadFlowNode(db, nodeUrn, run.organizationId);
      const data =
        node.data && typeof node.data === 'object' && !Array.isArray(node.data)
          ? (node.data as Record<string, unknown>)
          : {};
      let extractionSpec: ExtractionField[] | null = null;
      if (Array.isArray(data.extractionSpec)) {
        const entries = (data.extractionSpec as unknown[]).filter(
          (e): e is ExtractionField =>
            e !== null && typeof e === 'object' && typeof (e as ExtractionField).field === 'string',
        );
        if (entries.length > 0) {
          // Save-time validation exists, but a run must not trust history:
          // a reserved field name (message.data.exception*) fails the run
          // loudly instead of poisoning the envelope.
          const check = validateExtractionSpec(entries);
          if (!check.ok) {
            throw new Error(`Invalid extractionSpec on "${nodeUrn}": ${check.error.message}`);
          }
          extractionSpec = entries;
        }
      }
      return { extractionSpec, hasOutput: data.output != null };
    },

    selectNext: async (run, nodeUrn, view) => {
      const { memory, loc, node } = await loadFlowNode(db, nodeUrn, run.organizationId);
      return selectNextEdge(db, {
        sourceNode: { id: node.id, memoryId: memory.id, loc, urn: nodeUrn },
        view,
      });
    },

    resolveConfig: async (run): Promise<ResolvedAiConfig> => {
      // Trigger-level override rides on the schedule/webhook row; the run
      // carries it via eventData.__aiConfigName (set by the trigger minting
      // path) — else the registry walk from the run's context.
      const override =
        run.eventData && typeof run.eventData === 'object'
          ? ((run.eventData as Record<string, unknown>).__aiConfigName as string | undefined)
          : undefined;
      return resolveAiConfigWithFallback(db, override ?? null, {
        appId: run.appId,
        agentId: run.agentId ?? undefined,
        organizationId: run.organizationId,
      });
    },

    llm: (resolved, req) => generateText(resolved, req),

    llmObject: (resolved, req, fields) => generateExtraction(resolved, req, fields),

    onTerminal: (run) => dispatchRunCallback(db, run),

    writeOutput: async (run, nodeUrn, text) => {
      const { memory, loc, node } = await loadFlowNode(db, nodeUrn, run.organizationId);
      const spec: OutputSpec =
        node.data && typeof node.data === 'object' && !Array.isArray(node.data)
          ? ((node.data as Record<string, unknown>).output as OutputSpec) ?? {}
          : {};
      const ctx = runContext(db, run);

      let targetMemoryId = memory.id;
      let targetLoc: string;
      if (spec.writeTo) {
        const split = splitNodeUrn(spec.writeTo);
        const normalized = normalizeUrnForLookup(split.memoryUrn);
        const targetMemory = await db.memory.findFirst({
          where: {
            OR: [{ urn: normalized }, { urn: legacyMemoryUrnToCanonical(normalized) }],
            organizationId: run.organizationId, // tenant-scoped (PR-493)
            deletedAt: null,
          },
          select: { id: true },
        });
        if (!targetMemory) throw new Error(`Output memory not found for "${spec.writeTo}".`);
        targetMemoryId = targetMemory.id;
        targetLoc = split.loc;
      } else {
        // No output spec: a fresh run-record node beside the entry.
        targetLoc = `runs:${run.id}`;
      }

      let content = text;
      if (spec.mode === 'append') {
        const existing = await db.node.findUnique({
          where: { loc_memoryId: { loc: targetLoc, memoryId: targetMemoryId } },
          select: { content: true, deletedAt: true },
        });
        if (existing && !existing.deletedAt && existing.content) {
          content = `${existing.content}\n\n---\n\n${text}`;
        }
      }

      const stamp = new Date().toISOString().slice(0, 10);
      const written = await writeNodeCore(
        {
          memoryId: targetMemoryId,
          loc: targetLoc,
          name: spec.writeTo ? undefined : `${node.name} — ${stamp}`,
          content,
          nodeType: 'record',
          data: { appRunId: run.id, generatedAt: new Date().toISOString() },
          reason: `headless run ${run.id} (${run.triggerKind.toLowerCase()})`,
        } as never,
        ctx,
        // Existing target: update in place (name preserved when undefined);
        // fresh target: create. Same eager-validation split as importNode.
        (await db.node.findUnique({
          where: { loc_memoryId: { loc: targetLoc, memoryId: targetMemoryId } },
          select: { id: true },
        }))
          ? 'update'
          : 'create',
      );
      return written.id as string;
    },
  };
}
