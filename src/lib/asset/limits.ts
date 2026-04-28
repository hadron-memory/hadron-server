// Effective per-agent limits for asset upload. Reads optional overrides from
// App.properties.assets.* and clamps to platform ceilings.
// Spec: hadron-portal/specs/001-asset-upload/data-model.md §E-004 / §E-009.

export const PLATFORM_DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB
export const PLATFORM_CEILING_MAX_BYTES = 100 * 1024 * 1024; // 100 MB
export const PLATFORM_DEFAULT_TIMEOUT_SECONDS = 600; // 10 min
export const PLATFORM_DEFAULT_ALLOWED_MIMES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
];

export interface EffectiveLimits {
  maxBytes: number;
  allowedMimeTypes: string[];
  uploadRequestTimeoutSeconds: number;
}

export interface AppPropertiesAssets {
  maxSizeBytes?: unknown;
  allowedMimeTypes?: unknown;
  uploadRequestTimeoutSeconds?: unknown;
}

export function getEffectiveLimits(
  appProperties: unknown,
): EffectiveLimits {
  const overrides = readAssetsOverrides(appProperties);

  const maxBytes = clampPositive(
    overrides.maxSizeBytes,
    PLATFORM_DEFAULT_MAX_BYTES,
    PLATFORM_CEILING_MAX_BYTES,
  );

  const requestedMimes = Array.isArray(overrides.allowedMimeTypes)
    ? (overrides.allowedMimeTypes as unknown[]).filter(
        (m): m is string => typeof m === 'string' && m.length > 0,
      )
    : null;
  const allowedMimeTypes = requestedMimes
    ? requestedMimes.filter((m) => PLATFORM_DEFAULT_ALLOWED_MIMES.includes(m))
    : PLATFORM_DEFAULT_ALLOWED_MIMES.slice();

  const uploadRequestTimeoutSeconds = clampPositive(
    overrides.uploadRequestTimeoutSeconds,
    PLATFORM_DEFAULT_TIMEOUT_SECONDS,
    3600,
  );

  return { maxBytes, allowedMimeTypes, uploadRequestTimeoutSeconds };
}

function readAssetsOverrides(appProperties: unknown): AppPropertiesAssets {
  if (!appProperties || typeof appProperties !== 'object') return {};
  const props = appProperties as Record<string, unknown>;
  const assets = props.assets;
  if (!assets || typeof assets !== 'object') return {};
  return assets as AppPropertiesAssets;
}

function clampPositive(raw: unknown, fallback: number, ceiling: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return Math.min(fallback, ceiling);
  }
  return Math.min(Math.floor(raw), ceiling);
}
