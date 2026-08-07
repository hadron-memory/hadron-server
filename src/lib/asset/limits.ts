// Platform limits for asset upload.
// Spec: hadron-portal/specs/001-asset-upload/data-model.md §E-004 / §E-009.
//
// These are platform-wide and not overridable. There used to be a
// per-App override mechanism reading `App.properties.assets.*` and
// clamping to a ceiling — it was removed in #900 because **nothing ever
// called it with an App**: all three call sites passed null, and nothing
// anywhere wrote those properties. Its nine unit tests passed, which is
// what let it survive review — the mechanism looked alive from the suite
// and from the code, with no signal that its only callers opted out.
//
// Removing it is behaviour-preserving: with no overrides to clamp, the
// old code already resolved every limit to its platform default, and the
// 100MB ceiling it clamped against never bound anything.
//
// If per-App (or per-Memory, or per-org) limits are wanted later, note
// the shape that made the old one unbuildable: the v2 memory-addressed
// upload path has no App by construction, so the override needs an owner
// that actually exists on that path.

export const PLATFORM_DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB
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

export function getEffectiveLimits(): EffectiveLimits {
  return {
    maxBytes: PLATFORM_DEFAULT_MAX_BYTES,
    // A copy, not the shared array — a caller that mutates its result
    // must not edit the platform allowlist for every later upload.
    allowedMimeTypes: PLATFORM_DEFAULT_ALLOWED_MIMES.slice(),
    uploadRequestTimeoutSeconds: PLATFORM_DEFAULT_TIMEOUT_SECONDS,
  };
}
