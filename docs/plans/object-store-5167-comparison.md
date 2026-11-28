# Local and QA object store: replacement comparison (hadron-server#5167, step 1)

For Holger to decide from. **Nothing is chosen.** Step 2 (the swap) waits on that choice.
Probed 2026-11-28 from a host with no Docker, so **no candidate was run against our client**.
Revised after the LOCAL and BLIND reviews of the first head.

Status key: **V(src)** = the route, flag or text was read in the vendor's source or docs today (it exists;
it is not proof it behaves right). **U** = not verified. Step 2 turns every U and V(src) into a result by
running the S3 integration tests against the chosen server. Pull counts are popularity, not maintenance, and
are left out.

## What the store must do (#5167, `cor:dmo:060:12` staging promotion, `cor:dmo:060:13` orphan reaper)
1. Presigned PUT and GET from the portal origin (SigV4 query signing; the client only signs, the server validates).
2. Path-style addressing (`forcePathStyle`, the client default).
3. Bucket CORS for `http://localhost:5173`.
4. `ListObjectsV2` that returns `LastModified` (the orphan reaper's age floor; `lastModified` in `listObjects`).
5. Server-side `CopyObject`, plus `HeadObject` and `DeleteObject` (`copyObject` in `client.ts`, staging to permanent key).
6. A container healthcheck that needs no `mc` binary.
7. Anonymous image pull.

## Requirement by candidate
| | 1 Presign | 2 Path-style | 3 CORS | 4 List+LastModified | 5 Copy / Head / Delete | 6 Health w/o `mc` | 7 Anon pull (Hub manifest probe) |
|---|---|---|---|---|---|---|---|
| **SeaweedFS** | V(src) README | V(src) path-style router in `s3api_server.go` | V(src) `PutBucketCors` route | List route V(src); `LastModified` U | V(src) all three routes | V(src) `/healthz`, `/readyz` on the S3 port | 200 |
| **Garage** | V(src) compat page | V(src) compat page | V(src) compat page | V(src) `ListObjectsV2`; `LastModified` U | V(src) compat page | U | `latest` tag absent (404); pin a version |
| **RustFS** | U | U | `PutBucketCors` is implemented in source (reviewer, undocumented); `RUSTFS_CORS_ALLOWED_ORIGINS` defaults to empty, the `*` default belongs to the console variable | U | U | U (community guides use `curl /health`) | 200 |
| **CloudServer** | U | U | U | U | U | U | 200 |
| **S3Mock** | U | U | U (a test mock, not built for browsers) | U | U | U | 200 |
| **LocalStack** | U | U | U | U | U | U | 200 |
| **Third-party MinIO builds** | same as MinIO | same | same | same | same | V(src, MinIO docs): `/minio/health/ready` and `/live` answer without `mc`, so `curl -f` works. **This row does not lose on health.** | 200 |

## Provenance, licence, maintenance
| Candidate | Publisher / image | Licence | Maintenance |
|---|---|---|---|
| SeaweedFS | `chrislusf/seaweedfs` on Hub (owner's account); GitHub org `seaweedfs` | Apache-2.0 | Release 4.55, 2026-11-23 |
| RustFS | `rustfs/rustfs` | Apache-2.0 | Release 1.0.7, 2026-11-26; a young 1.0 line |
| Garage | `dxflrs/garage`, Deuxfleurs (non-profit) | AGPL-3.0 | Image pushed 2026-11-28; first start needs a cluster layout step |
| CloudServer | `zenko/cloudserver`, Scality | Apache-2.0 | **Hub image last pushed 2023-01-10**; GitHub repo active |
| S3Mock | `adobe/s3mock`, Adobe | Apache-2.0 | Image 2026-09-19 |
| LocalStack | `localstack/localstack` | `NOASSERTION` on GitHub; terms have changed, read them first | Repo last push 2026-03-23 |
| `pgsty/minio` (community rebuild) | not the MinIO company | AGPL-3.0 | Image 2026-08-04 |
| `bitnamilegacy/minio` | community/legacy | not checked | not checked |

**MinIO upstream (checked):** `github.com/minio/minio` is **archived** (GitHub `archived: true`, last push
2026-04-24, last release `RELEASE.2025-10-15T17-29-55Z`). The third-party builds therefore keep today's
behaviour and healthcheck at the price of an unmaintained upstream and a community publisher.

## Sources (read 2026-11-28)
- SeaweedFS: https://github.com/seaweedfs/seaweedfs (README "The most complete S3 API"; `weed/s3api/s3api_server.go`; releases)
- Garage: https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/ ; repo LICENSE at git.deuxfleurs.fr/Deuxfleurs/garage
- RustFS: https://github.com/rustfs/rustfs (README, releases, `crates/config/src/constants/`)
- MinIO: https://github.com/minio/minio (archive flag, releases); Hub tags for the third-party builds
- Hub manifest probe: `GET registry-1.docker.io/v2/<image>/manifests/latest` with an anonymous token. This shows a
  tag is listed anonymously. It is not a `docker pull` from a deploy host.
- Specs: `cor:dmo:060:12` and `cor:dmo:060:13` in `hrn:mem:hadronmemory.com:specs`.
- The client is `src/integrations/objectstore/s3/client.ts` (symbols `copyObject`, `listObjects`, `forcePathStyle`;
  its comment about checksum headers that some path-style stores reject applies to every candidate).

## Notes
- **Licence.** Garage and the MinIO builds are AGPL-3.0. For a dev/QA tool we neither modify nor ship, that is
  unlikely to bite; it is Holger's supply-chain call.
- **Provenance.** No candidate is a first-party cloud-vendor image.

## Recommendation (the author's; Holger to overrule)
**SeaweedFS** first: Apache-2.0, anonymously pullable, active, and the one candidate where requirements 2, 3,
5 and 6 were all read in source. **Garage** second if AGPL is acceptable and its layout step is tolerable.
RustFS is promising but young and mostly unverified. A third-party MinIO build is the zero-change option if
Holger accepts an archived upstream.

## Step 2 verification checklist (run against the chosen server)
- A browser-origin presigned PUT then GET from `http://localhost:5173`, including the CORS preflight.
- `forcePathStyle: true` with the client's existing checksum settings.
- Stage, `copyObject` to the permanent key, `HeadObject`, `DeleteObject` through the upload path.
- `ListObjectsV2` returns `LastModified` (the reaper's age floor), checked in the reaper's dry run.
- The healthcheck command, written out and exercised on a fresh container.
- `docker pull` on a representative host, with the image pinned by digest.
- `client.test.ts` and the `beginAssetUpload` suite.
