// assetQueries — extracted from resolvers.ts Query (split step 3). No behavior change.
import { listMemoryAssets } from '../../../controller/operations/listMemoryAssets.js';
import { listAgentAssets } from '../../../controller/operations/listAgentAssets.js';
import { AssetUploadError } from '../../../controller/operations/beginAssetUpload.js';
import { mintAssetDownloadUrl } from '../../../controller/operations/mintAssetDownloadUrl.js';
import {
  listAssets,
  type ListAssetsInput,
} from '../../../controller/operations/listAssets.js';
import {
  type Context,
  resolveAssetTargetMemoryId,
  requireReadableAgentForAssetOp,
} from './resolvers.helpers.js';
import { forbiddenError, unauthenticatedError } from '../../../lib/refusals.js';

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
      if (!ctx.userId) throw unauthenticatedError();
      // #876 (HIGH) — see memoryAssets below. This one resolves the target's
      // private per-user holding memory (userMemoryOfAgentId + createdBy) and
      // then filters `uploadedBy: caller.userId`, so every row is by
      // construction identity-scoped to the target.
      if (ctx.impersonation) throw forbiddenError();
      // #1946: an Agent the caller can't read answers the op's own "agent not found".
      await requireReadableAgentForAssetOp(ctx, input.agentUrn, () => new AssetUploadError('NOT_FOUND', 'agent not found'));
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
        mine?: boolean;
      },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw unauthenticatedError();
      // #876 (HIGH): the asset surface builds an ad-hoc caller principal that
      // cannot carry ctx.impersonation, and routes its memory check through
      // the MCP gate (src/mcp/access-control.ts canReadMemory) rather than the
      // narrowed portal gate — the gate-parity drift CLAUDE.md warns about.
      // That MCP gate admits the target's personal/private memories and calls
      // getOrgReadableMemoryIds WITHOUT restrictToOrgId, so the target's other
      // orgs resolve too. Denied rather than threaded, because fixing the
      // shared MCP gate for one GraphQL caller would risk the MCP surface it
      // also serves.
      //
      // This denial is now load-bearing on its own. It previously had a
      // second line of defence — rows were filtered `uploadedBy: caller.userId`
      // regardless, so an impersonated read was identity-scoped even if the
      // gate leaked. That filter is gone (listing is now gated on the memory,
      // per cor:dmo:060:10), so DO NOT relax this throw without first
      // narrowing the gate itself.
      if (ctx.impersonation) throw forbiddenError();
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

    // #891 — the uniform cross-memory list. Gate, org scope and ref
    // handling all live in the controller; this is the thin GraphQL edge.
    assets: async (
      _: unknown,
      input: ListAssetsInput,
      ctx: Context,
    ) => {
      if (!ctx.userId && !ctx.appId) throw unauthenticatedError();
      // #876 (HIGH): same denial as every other asset read surface, and it
      // has to be stated HERE rather than inherited — this is a NEW
      // surface, and cor:acl:100:03 makes uploaded assets and their
      // download links identity-scoped and invisible to an impersonated
      // session. #888 removed the incidental `uploadedBy` row filter that
      // used to be the second line of defence, so this throw is the only
      // one. A cross-memory list is the worst possible place to leak: it
      // would enumerate the target's files across every org they belong
      // to, and an asset id is the credential for the unauthenticated
      // GET /assets/:id hotlink.
      if (ctx.impersonation) throw forbiddenError();
      return listAssets(ctx, input);
    },

    assetDownloadUrl: async (
      _: unknown,
      { assetId, ttlSeconds }: { assetId: string; ttlSeconds?: number },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw unauthenticatedError();
      // #876 (HIGH): this mints a presigned object-store GET URL valid for up
      // to an hour that KEEPS WORKING after stopImpersonation, defeating the
      // "session row is the revocation source of truth" guarantee the whole
      // design rests on. Denied outright — clamping the TTL to the session's
      // remaining life would still hand out a bearer URL that outlives the
      // audit trail's ability to revoke it. (The gate below is now the
      // memory's read gate rather than `uploadedBy === caller.userId`, which
      // makes this throw more important, not less.)
      if (ctx.impersonation) throw forbiddenError();
      const result = await mintAssetDownloadUrl(
        ctx.db,
        {
          userId: ctx.userId,
          appId: ctx.appId,
          roles: ctx.roles,
          organizationId: ctx.organizationId,
        },
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

