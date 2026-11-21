#!/usr/bin/env bash
# Object-store import boundary guard (#905).
#
# Call sites may import ONLY the provider-neutral scaffold
# `src/integrations/objectstore/index.js`. The provider implementation under
# `src/integrations/objectstore/s3/` — and the S3-family AWS SDK it wraps
# (@aws-sdk/client-s3, @aws-sdk/s3-request-presigner) — is an internal detail
# of the scaffold, and the retired `src/integrations/r2/` path must not come
# back.
#
# Plain grep, not TypeScript, because the boundary has to hold for the string
# paths inside `vi.mock(...)` calls too — those are invisible to
# `tsc --noEmit`, so a stale one fails only at test runtime.
#
# The provider-path pattern accepts noncanonical-but-equivalent spellings
# (`objectstore/./s3`, `objectstore//s3`), so inserting path segments cannot
# slip a provider import past the guard. grep's exit status is honored:
# 0 = matches (violation if any survive the exclusion), 1 = clean,
# >=2 = search error, which FAILS the guard instead of reading as clean.
#
# Usage: scripts/check-objectstore-boundary.sh [tree]     (default: src)
# The tree argument exists so tests can point the same checks at a fixture
# tree — the guard CI runs and the guard the tests prove are the same code.
# Exit codes: 0 = clean, 1 = boundary violation, 2 = search error.
set -uo pipefail

TREE="${1:-src}"
TREE="${TREE%/}"

violation() {
  local title="$1" remedy="$2"
  echo "::error::$title"
  echo "$MATCHES"
  echo ""
  echo "$remedy"
  echo ""
  # A recorded search error (2) must not be downgraded by a later violation.
  [ "$FAILED" -eq 2 ] || FAILED=1
}

check() {
  # check <title> <pattern> <excluded-path-prefix-or-empty> <remedy>
  local title="$1" pattern="$2" exclude="$3" remedy="$4"
  MATCHES=$(grep -rnE -- "$pattern" "$TREE")
  local rc=$?
  if [ "$rc" -ge 2 ]; then
    echo "::error::Search error (grep rc=$rc) in check: $title"
    FAILED=2
    return
  fi
  if [ "$rc" -eq 0 ] && [ -n "$exclude" ]; then
    # Literal path-prefix filter (index, not regex: the tree may be any path).
    MATCHES=$(printf '%s\n' "$MATCHES" | awk -v p="$exclude" -F: 'index($1, p) != 1')
  fi
  if [ -n "${MATCHES:-}" ]; then
    violation "$title" "$remedy"
  fi
}

FAILED=0

check "References to the retired integrations/r2 path found (#905 moved it to integrations/objectstore):" \
  'integrations/r2' \
  '' \
  "Import the provider-neutral scaffold 'integrations/objectstore/index.js' instead."

check "References to the s3 provider directory found outside src/integrations/objectstore/ (#905):" \
  'objectstore(/\.?)+s3' \
  "$TREE/integrations/objectstore/" \
  "Call sites must import only 'integrations/objectstore/index.js' (the scaffold). If a neutral operation is missing, extend the barrel rather than reaching into s3/."

check "Direct imports of the S3-family AWS SDK found outside src/integrations/objectstore/s3/ (#905):" \
  '@aws-sdk/(client-s3|s3-request-presigner)' \
  "$TREE/integrations/objectstore/s3/" \
  "The AWS SDK is an internal detail of the s3 provider. Add the operation to src/integrations/objectstore/ (the scaffold) and import that instead. (@aws-sdk packages other than client-s3/s3-request-presigner, e.g. the SageMaker embedding client, are unaffected.)"

if [ "$FAILED" -eq 1 ]; then
  echo "Object-store import boundary: VIOLATION (see above)."
  exit 1
fi
if [ "$FAILED" -ge 2 ]; then
  echo "Object-store import boundary: search error (see above)."
  exit 2
fi
echo "OK — object-store import boundary holds (no retired r2/ path, no provider or S3-SDK reference outside the scaffold)."
