// assetQueries — extracted from resolvers.ts Query (split step 3). No behavior change.
import { listMemoryAssets } from '../../../controller/operations/listMemoryAssets.js';
import { listAgentAssets } from '../../../controller/operations/listAgentAssets.js';
import { mintAssetDownloadUrl } from '../../../controller/operations/mintAssetDownloadUrl.js';
import {
  type Context,
  resolveAssetTargetMemoryId,
} from './resolvers.helpers.js';

export const assetQueries = {
    agentAssets: async (
      _: unknown,
      input: {
        agentUrn: string;
        mimeType?: string;
        skip?: number;
        count?: number;
        includeDeleted?: boolean;
      },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      // #876 (HIGH) — see memoryAssets below. This one resolves the target's
      // private per-user holding memory (userMemoryOfAgentId + createdBy) and
      // then filters `uploadedBy: caller.userId`, so every row is by
      // construction identity-scoped to the target.
      if (ctx.impersonation) throw new Error('Forbidden');
      const result = await listAgentAssets(
        ctx.db,
        { userId: ctx.userId, appId: ctx.appId },
        input,
        resolveAssetTargetMemoryId,
      );
      return {
        assets: result.assets,
        total: result.total,
        hasMore: result.hasMore,
      };
    },

    // v2 (spec 006): memory-addressed listing.
    memoryAssets: async (
      _: unknown,
      input: {
        memoryId: string;
        mimeType?: string;
        skip?: number;
        count?: number;
        includeDeleted?: boolean;
      },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      // #876 (HIGH): the asset surface builds an ad-hoc caller principal that
      // cannot carry ctx.impersonation, and routes its memory check through
      // the MCP gate (src/mcp/access-control.ts canReadMemory) rather than the
      // narrowed portal gate — the gate-parity drift CLAUDE.md warns about.
      // That MCP gate admits the target's personal/private memories and calls
      // getOrgReadableMemoryIds WITHOUT restrictToOrgId, so the target's other
      // orgs resolved too. Denied rather than threaded: the rows are filtered
      // `uploadedBy: caller.userId` regardless, so an impersonated read is
      // always identity-scoped, and fixing the shared MCP gate for one
      // GraphQL caller would risk the MCP surface it also serves.
      if (ctx.impersonation) throw new Error('Forbidden');
      const result = await listMemoryAssets(
        ctx.db,
        {
          userId: ctx.userId,
          appId: ctx.appId,
          roles: ctx.roles,
          organizationId: ctx.organizationId,
        },
        input,
      );
      return {
        assets: result.assets,
        total: result.total,
        hasMore: result.hasMore,
      };
    },

    assetDownloadUrl: async (
      _: unknown,
      { assetId, ttlSeconds }: { assetId: string; ttlSeconds?: number },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      // #876 (HIGH): the only gate here is `asset.uploadedBy === caller.userId`,
      // which the target satisfies. Worse than a read: this mints a presigned
      // R2 GET URL valid for up to an hour that KEEPS WORKING after
      // stopImpersonation, defeating the "session row is the revocation source
      // of truth" guarantee the whole design rests on. Denied outright —
      // clamping the TTL to the session's remaining life would still hand out
      // a bearer URL that outlives the audit trail's ability to revoke it.
      if (ctx.impersonation) throw new Error('Forbidden');
      const result = await mintAssetDownloadUrl(
        ctx.db,
        { userId: ctx.userId, appId: ctx.appId },
        { assetId, ttlSeconds },
      );
      return {
        url: result.url,
        expiresAt: result.expiresAt.toISOString(),
        filename: result.filename,
        mimeType: result.mimeType,
        sizeBytes: result.sizeBytes,
      };
    },

};

