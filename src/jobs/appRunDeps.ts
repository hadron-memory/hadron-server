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
import { generateText, generateExtraction, generateWithTools, type ExtractionField } from '../lib/llm/index.js';
import { validateExtractionSpec } from '../lib/edge-conditions/reserved-names.js';
import { selectNextEdge } from '../lib/runner/selectNextEdge.js';
import { loadFlowNode, resolveFlowMemory } from '../lib/runner/loadFlowNode.js';
import { resolveRunTools } from '../lib/runner/tools/index.js';
import { splitNodeUrn } from '../lib/urn.js';
import type { RunExecutionDeps, RunNodeSpec } from './appRuns.js';
import { dispatchRunCallback } from '../api/webhooks.js';

export function runContext(db: PrismaClient, run: AppRun): Context {
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

// loadFlowNode / resolveFlowMemory moved to src/lib/runner/loadFlowNode.ts
// (shared with the run tools) — same tenant-scoping + encrypted-memory guards.

export function makeProdRunDeps(db: PrismaClient): RunExecutionDeps {
  return {
    assemble: async (run, nodeUrn, view) => {
      return resolvers.Mutation.runTask(
        {},
        { nodeRef: nodeUrn, args: Object.keys(view).length > 0 ? view : undefined },
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
          // `__`-prefixed names are runner plumbing (D-MN-1) — a node must
          // not extract into them; mergedView would strip them anyway, so
          // the extraction would silently vanish. Fail loud instead
          // (PR-532 review, Copilot).
          const plumbing = entries.find((e) => e.field.startsWith('__'));
          if (plumbing) {
            throw new Error(
              `Invalid extractionSpec on "${nodeUrn}": field "${plumbing.field}" — ` +
                `"__"-prefixed names are reserved for runner plumbing.`,
            );
          }
          extractionSpec = entries;
        }
      }
      let tools: string[] | null = null;
      if (Array.isArray(data.tools)) {
        const names = (data.tools as unknown[]).filter((t): t is string => typeof t === 'string');
        if (names.length > 0) {
          // Unknown names fail the hop LOUD before any LLM call (D-TL-6).
          const { unknown } = resolveRunTools(names);
          if (unknown.length > 0) {
            throw new Error(`Unknown tool(s) on "${nodeUrn}": ${unknown.join(', ')}.`);
          }
          tools = names;
        }
      }
      // D-TL-5: tools × extraction are mutually exclusive per node (v1).
      if (tools && extractionSpec) {
        throw new Error(
          `Node "${nodeUrn}" declares BOTH data.tools and data.extractionSpec — ` +
            `v1 supports one per node (plan-tools D-TL-5).`,
        );
      }
      return { extractionSpec, hasOutput: data.output != null, tools };
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

    llmTools: (run, resolved, req, toolNames, opts) => {
      const { tools } = resolveRunTools(toolNames); // names validated at loadNodeSpec
      return generateWithTools(resolved, req, tools, {
        onToolCall: opts.onToolCall,
        toolCtx: { log: opts.log, db, run, principal: runContext(db, run) },
      });
    },

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
        // Shared guards (tenant scope + encrypted-memory denial) — a writeTo
        // into an encrypted memory is denied like every other flow touch.
        const targetMemory = await resolveFlowMemory(
          db, split.memoryUrn, run.organizationId, spec.writeTo,
        );
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
      // Existing target: update in place (name preserved when undefined);
      // fresh target: create. Same eager-validation split as importNode.
      const exists = await db.node.findUnique({
        where: { loc_memoryId: { loc: targetLoc, memoryId: targetMemoryId } },
        select: { id: true },
      });
      // A FRESH node always needs a name — including a writeTo target that
      // doesn't exist yet (first live urgent-triage run, 2026-07-07:
      // "Argument `name` is missing"). Derive it from the target loc's last
      // segment; updates keep undefined so the existing name is preserved.
      const createName = spec.writeTo
        ? (targetLoc.split(':').pop() ?? targetLoc)
        : `${node.name} — ${stamp}`;
      const written = await writeNodeCore(
        {
          memoryId: targetMemoryId,
          loc: targetLoc,
          name: exists ? (spec.writeTo ? undefined : createName) : createName,
          content,
          nodeType: 'record',
          data: { appRunId: run.id, generatedAt: new Date().toISOString() },
          reason: `headless run ${run.id} (${run.triggerKind.toLowerCase()})`,
        } as never,
        ctx,
        exists ? 'update' : 'create',
      );
      return written.id as string;
    },
  };
}
