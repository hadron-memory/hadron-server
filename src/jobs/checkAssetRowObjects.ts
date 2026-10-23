/** Stub so the red test fails on its assertions; replaced by the real sweep in the next commit. */
import type { PrismaClient } from '../generated/prisma/index.js';

export interface AssetRowCheckOutcome {
  checked: number;
  missing: number;
  skippedEncrypted: number;
}

export class AssetRowCheckAbortedError extends Error {}

export interface AssetRowCheckOptions {
  db?: PrismaClient;
  now?: Date;
  batchSize?: number;
  maxEvents?: number;
}

export async function checkAssetRowObjects(_opts: AssetRowCheckOptions = {}): Promise<AssetRowCheckOutcome> {
  return { checked: 0, missing: 0, skippedEncrypted: 0 };
}
