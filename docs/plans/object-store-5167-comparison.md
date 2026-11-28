# Local and QA object store: replacement comparison (hadron-server#5167, step 1)

For Holger to decide from. **Nothing is chosen.** Step 2 (the swap) waits on that choice.
Probed 2026-11-28 from a host with no Docker, so **no candidate was run against our client**:
every feature claim below is from the vendor's repository or docs, not from an execution.
Status key: **V** = read in vendor source or docs today; **U** = not verified, needs the step 2 S3 integration run.

## What the store must do (from #5167, cor:dmo:060:12 and :13)
Presigned PUT/GET; path-style addressing; bucket CORS for the portal origin; `ListObjectsV2` that
returns `LastModified` (the orphan reaper's age floor, `client.ts:301`); server-side `CopyObject`
plus `HeadObject` and `DeleteObject` (staging key to permanent key, `client.ts:248`); a healthcheck
that needs no `mc`; anonymous image pull.

## Anonymous pull today (manifest probe, Docker Hub, HTTP status)
seaweedfs 200, rustfs 200, zenko/cloudserver 200, pgsty/minio 200, bitnamilegacy/minio 200,
adobe/s3mock 200, localstack 200. `dxflrs/garage` has no `latest` tag (404); pin a version tag.

## Comparison
| Candidate | Publisher / image | Licence | Maintenance (today) | CORS | Copy / List+LastModified | Healthcheck without `mc` |
|---|---|---|---|---|---|---|
| **SeaweedFS** | `chrislusf/seaweedfs` (project owner's Hub account; org `seaweedfs` on GitHub); 47M pulls | Apache-2.0 (V, GitHub) | Release 4.55 on 2026-11-23; image pushed today | V: `PutBucketCors` route in `s3api_server.go`; README lists CORS and presigned URLs | V: `CopyObject` and `ListObjectsV2` routes. `LastModified` in listing: U | V: S3 port serves `/healthz`, `/readyz`, `/status` |
| **RustFS** | `rustfs/rustfs`; 28M pulls | Apache-2.0 (V) | Release 1.0.7 on 2026-11-26, a young 1.0 line | S3 bucket CORS API: **U** (docs show only env vars `RUSTFS_CORS_ALLOWED_ORIGINS`, default `*`) | U | Community guides use `curl /health` on 9000 (U, not seen in official compose) |
| **Garage** | `dxflrs/garage`, Deuxfleurs (a French non-profit); needs a version tag | AGPL-3.0 (V, repo LICENSE) | Image pushed today | V per its compatibility page: `PutBucketCors` implemented | V per its page: `CopyObject`, presigned URLs implemented | U; needs a cluster layout step on first start, more init than the rest |
| **Zenko CloudServer** | `zenko/cloudserver`, Scality | Apache-2.0 (V) | **Hub image last pushed 2023-01-10**; GitHub repo active | U | U | U |
| **Adobe S3Mock** | `adobe/s3mock`, Adobe | Apache-2.0 (V) | Image 2026-09-19, repo active | U (a test mock; not built for browser CORS) | U | U |
| **LocalStack** | `localstack/localstack`, Hub-official | `NOASSERTION` on GitHub; its terms have changed, so read them before use | Repo last push 2026-03-23 | U | U | U |
| **Third-party MinIO builds** (`pgsty/minio`, `bitnamilegacy/minio`) | Community rebuilds, not the MinIO company | `pgsty/minio` AGPL-3.0 (V) | `pgsty/minio` image 2026-08-04 | Same as MinIO today (no client change) | Same as MinIO | `mc ready` needs `mc`; `mc` has no public source image either |

## Notes
- **Provenance.** None of these is a first-party image from a cloud vendor. SeaweedFS and Garage are the
  established independent projects; RustFS is the newest. The third-party MinIO builds keep today's
  behaviour at the price of trusting a community publisher and an archived upstream (MinIO's own
  repository was reported archived in Feb 2026; sources disagree on dates, unchecked).
- **Licence.** Garage and the MinIO builds are AGPL-3.0. That is a dev/QA-only tool we do not modify or
  ship, so the copyleft is unlikely to bite, but it is Holger's supply-chain call. SeaweedFS, RustFS and
  CloudServer are Apache-2.0.
- **Client.** `src/integrations/objectstore/s3/client.ts` sets `forcePathStyle` by default and is
  provider-neutral. Its comment at `:84` mentions checksum headers that "MinIO and some R2 path-style"
  stores reject; any candidate must be run against that setting.

## Recommendation (mine, for Holger to overrule)
**SeaweedFS** first: Apache-2.0, anonymously pullable, very active, and the only candidate where I read
the CORS, CopyObject, ListObjectsV2 and health routes in the source. **Garage** second if AGPL is
acceptable and the layout init step is tolerable. RustFS is promising but too young and unverified on CORS.

## Open before step 2
Run the S3 integration tests (`client.test.ts`, `beginAssetUpload`) against the chosen server, and
confirm `LastModified` in `ListObjectsV2` and the CORS preflight from `http://localhost:5173`.
Rows marked U above are claims nobody has checked yet.
