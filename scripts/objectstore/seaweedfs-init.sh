#!/bin/sh
# #5167: one-shot init for the local dev and QA object store (SeaweedFS). Runs in the SeaweedFS image itself, whose
# curl signs SigV4 (--aws-sigv4), so no second image (the MinIO setup needed `mc`). Creates the bucket and applies the
# portal origin's CORS rule. Idempotent: a bucket that already exists is fine, and the CORS rule is replaced.
# Fails loudly: unlike the old `mc cors set ... || true`, a CORS rule that did not apply stops the init, because a
# browser upload would otherwise fail later with an opaque CORS error.
# Env: S3_URL, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET, S3_CORS_ORIGIN (dev-only values; see the compose files).
set -eu
sig='aws:amz:us-east-1:s3'
auth="$S3_ACCESS_KEY:$S3_SECRET_KEY"

code=$(curl -sS -o /tmp/s3-init.out -w '%{http_code}' --aws-sigv4 "$sig" --user "$auth" -X PUT "$S3_URL/$S3_BUCKET")
case "$code" in
  200|409) echo "bucket $S3_BUCKET: ready (HTTP $code)" ;;
  *) echo "bucket $S3_BUCKET: create failed (HTTP $code)" >&2; cat /tmp/s3-init.out >&2; exit 1 ;;
esac

cors="<CORSConfiguration><CORSRule><AllowedOrigin>$S3_CORS_ORIGIN</AllowedOrigin><AllowedMethod>PUT</AllowedMethod><AllowedMethod>GET</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>"
code=$(curl -sS -o /tmp/s3-init.out -w '%{http_code}' --aws-sigv4 "$sig" --user "$auth" -X PUT \
  -H 'Content-Type: application/xml' --data-binary "$cors" "$S3_URL/$S3_BUCKET?cors")
[ "$code" = 200 ] || { echo "bucket $S3_BUCKET: CORS failed (HTTP $code)" >&2; cat /tmp/s3-init.out >&2; exit 1; }
echo "bucket $S3_BUCKET: CORS allows $S3_CORS_ORIGIN"
