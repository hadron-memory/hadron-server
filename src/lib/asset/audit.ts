// Asset audit logging — emits structured records describing every asset
// operation. Spec: hadron-portal/specs/001-asset-upload/data-model.md §E-005.
//
// TODO(AppLogEntry): when the 003-station-to-app migration adds AppLogEntry,
// swap the console emit for a db.appLogEntry.create({ ... }) call. The shape
// below is the intended `detail` JSON for that row plus a top-level
// `event_type: "asset"`. New code MUST NOT write to StationLogEntry per
// constitution Invariant #6.

export type AssetOperation =
  | 'upload-requested'
  | 'upload-completed'
  | 'upload-cancelled'
  | 'upload-declined'
  | 'upload-timeout'
  | 'listed'
  | 'download-url-issued'
  | 'soft-deleted'
  | 'restored'
  | 'purged'
  | 'scan-flipped';

export interface AssetAuditEvent {
  operation: AssetOperation;
  assetId?: string;
  agentId?: string;
  memoryId?: string;
  userId?: string;
  appId?: string;
  bytes?: number;
  ttlSeconds?: number;
  reason?: string;
  scanStatusFrom?: string;
  scanStatusTo?: string;
  count?: number;
  error?: string;
}

export function logAssetEvent(event: AssetAuditEvent): void {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      level: 'info',
      eventType: 'asset',
      ts: new Date().toISOString(),
      ...event,
    }),
  );
}
