// Provider-neutral object-store surface (#905).
//
// Call sites import ONLY this module — never the provider directory
// (`./s3/`) and never the AWS SDK directly. The boundary is CI-enforced
// (`.github/workflows/object-store-import-boundary.yml`): a reference to
// the retired `r2/` path (pre-#905) or to `objectstore/s3` outside
// this directory fails the build, including the string paths inside
// `vi.mock(...)` calls that TypeScript cannot see.
//
// Layout (Holger's 2026-08-07 direction: one directory per provider):
//
//   src/integrations/objectstore/        this scaffold — the seam
//   src/integrations/objectstore/s3/     the S3-API implementation
//                                         (AWS SDK; serves Hetzner in
//                                         production, MinIO in dev, and
//                                         R2 or any S3-compatible store
//                                         via ASSET_STORAGE_* config)
//
// `s3/` is one provider family because one client serves them all —
// per-vendor directories would hold identical code. Whether the split
// should be per provider or per protocol remains an open ruling on #905;
// a ruling there changes directory NAMES only, never this seam.
//
// The raw client handle (`getObjectStoreClient`) is deliberately NOT
// re-exported: nothing outside the provider module needs an AWS-typed
// handle, and this scaffold must not leak provider SDK types. Extend
// this barrel with a neutral operation instead.

export {
  getObjectStoreBucket,
  isObjectStoreConfigured,
  mintPutUrl,
  mintGetUrl,
  putObject,
  headObject,
  readObjectPrefix,
  copyObject,
  listObjectsPage,
  deleteObject,
} from './s3/client.js';

export type {
  PresignedPutOptions,
  PresignedGetOptions,
  HeadResult,
  ObjectSummary,
  ObjectPage,
} from './s3/client.js';
