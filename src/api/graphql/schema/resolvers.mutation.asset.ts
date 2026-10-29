// assetMutations — extracted from resolvers.ts Mutation (split step 2). No behavior change.
import {
  beginAssetUpload,
  beginAssetUploadV2,
  type BeginAssetUploadInput as AssetUploadInput,
  type BeginAssetUploadV2Input,
} from '../../../controller/operations/beginAssetUpload.js';
import { completeAssetUpload } from '../../../controller/operations/completeAssetUpload.js';
import {
  createAssetReferenceNode,
  type CreateAssetReferenceNodeInput,
} from '../../../controller/operations/createAssetReferenceNode.js';
import { setAgentAssetUploadEnabled, SetAssetEnabledError } from '../../../controller/operations/setAgentAssetUploadEnabled.js';
import { AssetUploadError } from '../../../controller/operations/beginAssetUpload.js';
import { softDeleteAsset } from '../../../controller/operations/softDeleteAsset.js';
import { setAssetPublicLink } from '../../../lib/asset/publicLink.js';
import { restoreAsset } from '../../../controller/operations/restoreAsset.js';
import {
  type Context,
  resolveAssetTargetMemoryId,
  isOrgAdminFor,
  requireReadableAgentForAssetOp,
} from './resolvers.helpers.js';
import { forbiddenError, unauthenticatedError } from '../../../lib/refusals.js';

export const assetMutations = {
    beginAssetUpload: async (
      _: unknown,
      { input }: { input: AssetUploadInput },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw unauthenticatedError();
      // #1946: an Agent the caller can't read answers the op's own "agent not found".
      await requireReadableAgentForAssetOp(ctx, input.agentUrn, () => new AssetUploadError('NOT_FOUND', 'agent not found'));
      const ticket = await beginAssetUpload(
        ctx.db,
        { userId: ctx.userId, appId: ctx.appId },
        input,
        resolveAssetTargetMemoryId,
      );
      return {
        uploadId: ticket.uploadId,
        putUrl: ticket.putUrl,
        putHeaders: ticket.putHeaders,
        expiresAt: ticket.expiresAt.toISOString(),
        storageKey: ticket.storageKey,
        maxSizeBytes: ticket.maxSizeBytes,
        allowedMimeType: ticket.allowedMimeType,
      };
    },

    // v2 (spec 006): memory-addressed begin.
    beginAssetUploadV2: async (
      _: unknown,
      { input }: { input: BeginAssetUploadV2Input },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw unauthenticatedError();
      const ticket = await beginAssetUploadV2(
        ctx.db,
        {
          userId: ctx.userId,
          appId: ctx.appId,
          roles: ctx.roles,
          organizationId: ctx.organizationId,
          sessionId: ctx.sessionId,
          impersonation: ctx.impersonation,
        },
        input,
      );
      return {
        uploadId: ticket.uploadId,
        putUrl: ticket.putUrl,
        putHeaders: ticket.putHeaders,
        expiresAt: ticket.expiresAt.toISOString(),
        storageKey: ticket.storageKey,
        maxSizeBytes: ticket.maxSizeBytes,
        allowedMimeType: ticket.allowedMimeType,
      };
    },

    // Attach an existing asset to the graph as a `reference` node.
    // Impersonation is denied for the same reason as the rest of the
    // asset surface (#876): the ad-hoc caller principal cannot carry
    // ctx.impersonation, and this is a WRITE into the target's memory.
    createAssetReferenceNode: async (
      _: unknown,
      { input }: { input: CreateAssetReferenceNodeInput },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw unauthenticatedError();
      if (ctx.impersonation) throw forbiddenError();
      return createAssetReferenceNode(
        ctx.db,
        {
          userId: ctx.userId,
          appId: ctx.appId,
          roles: ctx.roles,
          organizationId: ctx.organizationId,
        },
        ctx,
        input,
      );
    },

    completeAssetUpload: async (
      _: unknown,
      { input }: { input: { uploadId: string } },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw unauthenticatedError();
      return completeAssetUpload(
        ctx.db,
        { userId: ctx.userId, appId: ctx.appId, roles: ctx.roles, organizationId: ctx.organizationId, sessionId: ctx.sessionId, impersonation: ctx.impersonation },
        input,
      );
    },

    setAgentAssetUploadEnabled: async (
      _: unknown,
      { input }: { input: { agentUrn: string; enabled: boolean } },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw unauthenticatedError();
      // #1946: an Agent the caller can't read answers the op's own "agent not
      // found", never PERMISSION_DENIED or the user-owned message.
      await requireReadableAgentForAssetOp(ctx, input.agentUrn, () => new SetAssetEnabledError('NOT_FOUND', 'agent not found'));
      return setAgentAssetUploadEnabled(
        ctx.db,
        { userId: ctx.userId },
        input,
        isOrgAdminFor,
      );
    },

    setAssetPublicLink: async (
      _: unknown,
      { assetRef, enabled }: { assetRef: string; enabled: boolean },
      ctx: Context,
    ) => setAssetPublicLink(ctx, assetRef, enabled),

    softDeleteAsset: async (
      _: unknown,
      { assetId }: { assetId: string },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw unauthenticatedError();
      return softDeleteAsset(
        ctx.db,
        { userId: ctx.userId, appId: ctx.appId, roles: ctx.roles, organizationId: ctx.organizationId, sessionId: ctx.sessionId, impersonation: ctx.impersonation },
        { assetId },
        isOrgAdminFor,
      );
    },

    restoreAsset: async (
      _: unknown,
      { assetId }: { assetId: string },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw unauthenticatedError();
      return restoreAsset(
        ctx.db,
        { userId: ctx.userId, appId: ctx.appId, roles: ctx.roles, organizationId: ctx.organizationId, sessionId: ctx.sessionId, impersonation: ctx.impersonation },
        { assetId },
        isOrgAdminFor,
      );
    },

};
