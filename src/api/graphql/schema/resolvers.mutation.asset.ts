// assetMutations — extracted from resolvers.ts Mutation (split step 2). No behavior change.
import {
  beginAssetUpload,
  beginAssetUploadV2,
  type BeginAssetUploadInput as AssetUploadInput,
  type BeginAssetUploadV2Input,
} from '../../../controller/operations/beginAssetUpload.js';
import { completeAssetUpload } from '../../../controller/operations/completeAssetUpload.js';
import { setAgentAssetUploadEnabled } from '../../../controller/operations/setAgentAssetUploadEnabled.js';
import { softDeleteAsset } from '../../../controller/operations/softDeleteAsset.js';
import { restoreAsset } from '../../../controller/operations/restoreAsset.js';
import {
  type Context,
  resolveAssetTargetMemoryId,
  isOrgAdminFor,
} from './resolvers.helpers.js';

export const assetMutations = {
    beginAssetUpload: async (
      _: unknown,
      { input }: { input: AssetUploadInput },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
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
      if (!ctx.userId) throw new Error('Unauthenticated');
      const ticket = await beginAssetUploadV2(
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
        uploadId: ticket.uploadId,
        putUrl: ticket.putUrl,
        putHeaders: ticket.putHeaders,
        expiresAt: ticket.expiresAt.toISOString(),
        storageKey: ticket.storageKey,
        maxSizeBytes: ticket.maxSizeBytes,
        allowedMimeType: ticket.allowedMimeType,
      };
    },

    completeAssetUpload: async (
      _: unknown,
      { input }: { input: { uploadId: string } },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      return completeAssetUpload(
        ctx.db,
        { userId: ctx.userId, appId: ctx.appId },
        input,
      );
    },

    setAgentAssetUploadEnabled: async (
      _: unknown,
      { input }: { input: { agentUrn: string; enabled: boolean } },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      return setAgentAssetUploadEnabled(
        ctx.db,
        { userId: ctx.userId },
        input,
        isOrgAdminFor,
      );
    },

    softDeleteAsset: async (
      _: unknown,
      { assetId }: { assetId: string },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      return softDeleteAsset(
        ctx.db,
        { userId: ctx.userId, appId: ctx.appId },
        { assetId },
        isOrgAdminFor,
      );
    },

    restoreAsset: async (
      _: unknown,
      { assetId }: { assetId: string },
      ctx: Context,
    ) => {
      if (!ctx.userId) throw new Error('Unauthenticated');
      return restoreAsset(
        ctx.db,
        { userId: ctx.userId, appId: ctx.appId },
        { assetId },
        isOrgAdminFor,
      );
    },

};

