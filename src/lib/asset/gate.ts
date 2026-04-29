/**
 * Per-app gate for the asset-upload tool.
 *
 * The asset-upload tool is opt-in: an App's `agentTools` allowlist
 * must include the canonical key before any begin/complete/list/
 * download operation is permitted. This is the same allowlist
 * pattern used elsewhere for tool gating.
 *
 * Per spec 004-asset-upload FR-020 / FR-021.
 */

import type { App } from '../../generated/prisma/index.js';

/** Canonical key for the asset-upload tool in `App.agentTools`. */
export const ASSET_UPLOAD_TOOL_KEY = 'asset:upload';

export class ToolNotEnabledError extends Error {
  constructor(public toolKey: string) {
    super(`TOOL_NOT_ENABLED: ${toolKey}`);
    this.name = 'ToolNotEnabledError';
  }
}

/**
 * Returns true iff the App has the asset-upload tool enabled.
 * Pure check; no side-effects.
 */
export function isAssetToolEnabled(app: Pick<App, 'agentTools'>): boolean {
  return app.agentTools.includes(ASSET_UPLOAD_TOOL_KEY);
}

/**
 * Throws ToolNotEnabledError if the App does not have the asset-upload
 * tool enabled. Use as the first server-side gate in any asset operation.
 */
export function assertAssetToolEnabled(
  app: Pick<App, 'agentTools'>,
): void {
  if (!isAssetToolEnabled(app)) {
    throw new ToolNotEnabledError(ASSET_UPLOAD_TOOL_KEY);
  }
}
