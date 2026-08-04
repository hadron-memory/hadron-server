/**
 * Store tools (#631, phase P2 first slice): hadron_store_file — persist
 * model-authored TEXT content as an Asset in object storage AND create a
 * `reference` node pointing at it (decision 2026-07-11: every stored file
 * gets a reference node, so the file is discoverable/citable in the graph).
 *
 * References, not bytes (#631): the tool returns asset metadata + URNs —
 * file bytes never enter the LLM context. Binary sources (webfetch save
 * mode) come later, gated on the webFetch hardening (#631 P1); that is why
 * `content` is text-only here.
 *
 * Boundary posture:
 *  - same flow guards as every run tool (resolveFlowMemory: same-org only,
 *    encrypted memories denied — the run has no session key, and asset
 *    storage-key encryption needs one);
 *  - write authorization is checked BEFORE any side effect (canWriteToMemory
 *    under the run principal), so an unauthorized call cannot orphan bytes
 *    in the object store;
 *  - the reference node is written through writeNodeCore under the run
 *    principal — class gates apply unchanged;
 *  - gating is the run-policy activation (`tool.hadron_store_file`) only;
 *    the chat-surface `asset:upload` agentTools gate does not apply to runs
 *    (#631 "gate reconciliation" decision).
 *
 * Scan posture: the content is SERVER-AUTHORED (it arrived through the
 * platform API as part of the run, same trust level as node content — there
 * is no untrusted-device upload here), so the asset is persisted CLEAN
 * rather than PENDING. PENDING would block downloads forever on
 * deployments without a scanner.
 */

import { GraphQLError } from 'graphql';
import { writeNodeCore } from '../../../api/graphql/schema/resolvers.mutation.node.js';
import { canWriteToMemory } from '../../../mcp/access-control.js';
import { logAssetEvent } from '../../asset/audit.js';
import { assertMemoryAcceptsUploads } from '../../asset/gate.js';
import { getEffectiveLimits } from '../../asset/limits.js';
import { buildStorageKey, extractExtension } from '../../asset/storageKey.js';
import { putObject, deleteObject } from '../../../integrations/r2/client.js';
import { generateId } from '../../id.js';
import { splitNodeUrn } from '../../urn.js';
import { emitAssetUrnV2 } from '../../urnEmit.js';
import { resolveFlowMemory } from '../loadFlowNode.js';
import type { RunToolDef, RunToolContext } from './types.js';
import type { AuthContext } from '../../../middleware/auth.js';

/**
 * v1 accepts text content only, so the MIME vocabulary is the text-ish
 * subset of the platform asset allowlist (lib/asset/limits.ts).
 */
const TEXT_MIME_BY_EXTENSION: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
};
const ALLOWED_TEXT_MIMES = new Set(Object.values(TEXT_MIME_BY_EXTENSION));

function principalAuth(ctx: RunToolContext): AuthContext {
  return {
    clientId: ctx.principal.clientId,
    userId: ctx.principal.userId,
    appId: ctx.principal.appId,
    organizationId: ctx.principal.organizationId,
  };
}

function resolveMimeType(filename: string, explicit: unknown): string {
  if (explicit !== undefined) {
    const mime = String(explicit);
    if (!ALLOWED_TEXT_MIMES.has(mime)) {
      throw new Error(
        `hadron_store_file: mimeType "${mime}" is not storable in v1 — ` +
          `text content only (${[...ALLOWED_TEXT_MIMES].join(', ')}).`,
      );
    }
    return mime;
  }
  const ext = extractExtension(filename);
  const inferred = TEXT_MIME_BY_EXTENSION[ext];
  if (!inferred) {
    throw new Error(
      `hadron_store_file: cannot infer a MIME type from "${filename}" — ` +
        `use one of the extensions ${Object.keys(TEXT_MIME_BY_EXTENSION).join(', ')} ` +
        'or pass mimeType explicitly.',
    );
  }
  return inferred;
}

export const hadronStoreFile: RunToolDef = {
  name: 'hadron_store_file',
  description:
    'Store text content as a file in platform object storage and create a reference ' +
    'node at the given URN pointing to it. The file becomes an Asset in the URN\'s ' +
    'memory; the tool returns the asset id/URN and metadata — never the bytes. ' +
    'Use for durable artifacts (reports, extracts, CSV/JSON data) that later steps ' +
    'or other tools will consume by reference.',
  inputSchema: {
    type: 'object',
    properties: {
      urn: {
        type: 'string',
        description:
          'Fully-qualified node URN (hrn:node:<root>:<memory>:<loc>) for the reference node that will ' +
          'point at the stored file. The file is stored in that memory. Same-org only.',
      },
      filename: {
        type: 'string',
        description:
          'Filename with extension (e.g. "q3-report.md"). The extension drives the ' +
          'default MIME type: md, txt, csv, json.',
      },
      content: { type: 'string', description: 'The text content to store.' },
      mimeType: {
        type: 'string',
        description:
          'Optional MIME type override (text/markdown, text/plain, text/csv, application/json).',
      },
      name: {
        type: 'string',
        description: 'Display name for the reference node. Default: the filename.',
      },
      description: {
        type: 'string',
        description: 'Short description, stored on both the asset and the reference node.',
      },
    },
    required: ['urn', 'filename', 'content'],
  },
  cost: 1,
  execute: async (ctx, args) => {
    const urn = String(args.urn ?? '');
    const filename = String(args.filename ?? '').trim();
    if (!filename) throw new Error('hadron_store_file: "filename" is required.');
    if (typeof args.content !== 'string' || args.content.length === 0) {
      throw new Error('hadron_store_file: "content" must be a non-empty string.');
    }
    const mimeType = resolveMimeType(filename, args.mimeType);
    const body = Buffer.from(args.content, 'utf8');

    // Size cap: same platform limits as the upload path (per-App overrides
    // pass null there too — the App properties column isn't wired yet).
    const limits = getEffectiveLimits(null);
    if (body.byteLength > limits.maxBytes) {
      throw new Error(
        `hadron_store_file: content is ${body.byteLength} bytes — over the ` +
          `${limits.maxBytes}-byte asset limit.`,
      );
    }

    // Flow guards + write auth BEFORE any side effect: an unauthorized or
    // misrouted call must not leave orphan bytes in the object store.
    const { memoryUrn, loc } = splitNodeUrn(urn);
    const memory = await resolveFlowMemory(ctx.db, memoryUrn, ctx.run.organizationId, urn);
    if (!(await canWriteToMemory(ctx.db, principalAuth(ctx), memory.id))) {
      throw new Error(`Memory not writable for "${urn}" under the run principal.`);
    }
    // Memory-level storage policy, distinct from write authorization — the
    // same gate every attached-Asset creation path runs (PR-635 review).
    await assertMemoryAcceptsUploads(ctx.db, memory.id);
    const org = await ctx.db.organization.findUniqueOrThrow({
      where: { id: ctx.run.organizationId },
      select: { urn: true },
    });

    const assetId = generateId();
    const storageKey = buildStorageKey({
      orgUrn: org.urn,
      memoryUrn: memory.urn,
      assetId,
      filename,
    });
    // #697 Stage 2: emit the flat v2 asset URN (matches the GraphQL Asset.urn
    // read surface); fall back to the bare form only if the stored memory urn
    // can't compose.
    let assetUrn: string;
    try {
      assetUrn = emitAssetUrnV2(memory.urn, assetId);
    } catch {
      assetUrn = `${memory.urn}:assets:${assetId}`;
    }

    await putObject({ key: storageKey, body, contentType: mimeType });
    try {
      const nodeName = args.name !== undefined ? String(args.name) : filename;
      const nodeDescription = args.description !== undefined ? String(args.description) : undefined;
      await ctx.db.asset.create({
        data: {
          id: assetId,
          memoryId: memory.id,
          filename,
          mimeType,
          sizeBytes: body.byteLength,
          storageKey,
          // Server-authored content — see the scan-posture note in the
          // file header.
          scanStatus: 'CLEAN',
          description: nodeDescription,
          uploadedBy: ctx.principal.userId ?? null,
        },
      });
      // The reference node (nodeType `reference`: external source, metadata
      // in `data`) — the graph-side handle for the stored file.
      await writeNodeCore(
        {
          memoryId: memory.id,
          loc,
          name: nodeName,
          nodeType: 'reference',
          description: nodeDescription,
          content:
            `Stored file **${filename}** (${mimeType}, ${body.byteLength} bytes).\n\n` +
            `Asset URN: \`${assetUrn}\``,
          data: {
            asset: { id: assetId, urn: assetUrn, filename, mimeType, sizeBytes: body.byteLength },
            runId: ctx.run.id,
          },
          reason: `run tool hadron_store_file (run ${ctx.run.id})`,
        } as never,
        ctx.principal,
        'create',
      );
    } catch (err) {
      // Compensate: no asset without its reference node, no bytes without
      // their Asset row. deleteObject/asset.delete are best-effort — the
      // original error is what the author needs to see.
      await ctx.db.asset.delete({ where: { id: assetId } }).catch(() => {});
      await deleteObject(storageKey).catch(() => {});
      if (err instanceof GraphQLError && err.extensions?.code === 'NodeLocConflictError') {
        throw new Error(
          `Node already exists at "${urn}" — pick a fresh loc for the reference node.`,
        );
      }
      throw err;
    }

    logAssetEvent({
      operation: 'upload-completed',
      assetId,
      memoryId: memory.id,
      userId: ctx.principal.userId ?? null,
      appId: ctx.run.appId,
      bytes: body.byteLength,
      reason: `run tool hadron_store_file (run ${ctx.run.id})`,
    });
    ctx.log(`stored ${filename} (${body.byteLength} bytes) as ${assetUrn}; reference node ${urn}`);

    return {
      stored: true,
      nodeUrn: urn,
      asset: { id: assetId, urn: assetUrn, filename, mimeType, sizeBytes: body.byteLength },
    };
  },
};

export const STORE_TOOLS: readonly RunToolDef[] = [hadronStoreFile];
