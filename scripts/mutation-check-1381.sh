#!/usr/bin/env bash
# Reproducible mutation check for #1381 (the #1316 GraphQL remainder).
#
# Each entry reverts ONE concealment site (or weakens a shared helper), runs the
# suites that pin it, and reports KILLED (the suites red) or SURVIVED (green).
# Requires a clean worktree: it reverts each mutation with `git checkout --`, so
# an UNCOMMITTED baseline would be destroyed. A pattern that no longer matches is
# STALE and a run with no test summary is ERRORED; both fail the script, because
# either one otherwise reads as a result.
#
# Usage:  TEST_DATABASE_URL=postgresql://<user>@localhost:5432/<private_db> \
#           bash scripts/mutation-check-1381.sh
set -uo pipefail
cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain)" ]; then
  echo "REFUSING: worktree is dirty. This script reverts with 'git checkout --',"
  echo "which would discard uncommitted work. Commit or stash first."
  exit 1
fi
: "${TEST_DATABASE_URL:?set TEST_DATABASE_URL to a PRIVATE test database}"

H=src/api/graphql/schema/resolvers.helpers.ts
N=src/api/graphql/schema/resolvers.mutation.node.ts
M=src/api/graphql/schema/resolvers.mutation.memory.ts
AM=src/api/graphql/schema/resolvers.mutation.appMemory.ts
Q=src/api/graphql/schema/resolvers.query.session.ts
LA=src/controller/operations/listMemoryAssets.ts
O=src/api/graphql/schema/resolvers.query.org.ts
SPECS="src/test/integration/graphql-existence-oracle-1381.test.ts
src/test/integration/memory-existence-oracle-1316.test.ts
src/test/integration/mcp-existence-oracle-1316.test.ts
src/api/graphql/schema/resolvers.accessControl.test.ts
src/api/graphql/schema/resolvers.encryption041.test.ts
src/api/graphql/schema/resolvers.memoryType.test.ts
src/api/graphql/schema/resolvers.mutation.appMemory.test.ts
src/api/graphql/schema/resolvers.usageEvents.access.test.ts
src/controller/operations/listMemoryAssets.test.ts
src/api/graphql/schema/resolvers.effectiveAccess.test.ts
src/api/graphql/schema/resolvers.userOwnedAgent.test.ts
src/api/graphql/schema/resolvers.impersonation.test.ts"

BAD=0
SURVIVORS=0

# Baseline on the unmutated tree: every spec green, and the TOTAL test count
# every mutant run must reproduce. A run reporting fewer tests (files that
# failed to load, a crashed worker, an exhausted DB) did not test the mutant,
# and must not read as a survivor — the third way this harness lied (PR #1383:
# a partial run of 13 tests was reported as SURVIVED).
# shellcheck disable=SC2086
# The EXIT STATUS counts too (@codex, PR #1383): a suite that fails to load
# can leave a `Tests … passed (N)` line with no "failed" in it, and a baseline
# measured on that would validate every mutant against a reduced count.
base_raw=$(TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm vitest run $SPECS 2>&1 | sed 's/\x1b\[[0-9;]*m//g')
base_status=$?
base_line=$(echo "$base_raw" | grep -E '^ *Tests ')
BASELINE=$(echo "$base_line" | sed -nE 's/.*\(([0-9]+)\).*/\1/p')
if [ "$base_status" -ne 0 ] || [ -z "$BASELINE" ] || echo "$base_raw" | grep -qE '^ *(Tests|Test Files) .*failed'; then
  echo "REFUSING: the baseline is not green (vitest exit $base_status) — $base_line"
  echo "$base_raw" | tail -5 | sed 's/^/            /'
  exit 1
fi
echo "baseline: $BASELINE tests, all passing"
run() { # name file old new [occurrence, 1-based]
  python3 - "$2" "$3" "$4" "${5:-1}" <<'PY' || { echo "STALE     $1 — pattern no longer matches the implementation"; BAD=$((BAD+1)); return; }
import sys
p, old, new, nth = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
s = open(p).read()
at = -1
for _ in range(nth):
    at = s.find(old, at + 1)
    assert at >= 0
open(p, 'w').write(s[:at] + new + s[at + len(old):])
PY
  # shellcheck disable=SC2086
  raw=$(TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm vitest run $SPECS 2>&1 | sed 's/\x1b\[[0-9;]*m//g')
  status=$?
  out=$(echo "$raw" | grep -E '^ *Tests ')
  git checkout -q -- "$2"
  if [ -z "$out" ]; then
    echo "ERRORED   $1 — no test summary; the run did not report on this mutant"
    echo "$raw" | tail -5 | sed 's/^/            /'
    BAD=$((BAD+1))
    return
  fi
  total=$(echo "$out" | sed -nE 's/.*\(([0-9]+)\).*/\1/p')
  if [ "$total" != "$BASELINE" ]; then
    echo "ERRORED   $1 — partial run: $total of $BASELINE tests reported ($(echo "$out" | tr -s ' '))"
    BAD=$((BAD+1))
    return
  fi
  # A nonzero exit with NO failed test is an operational failure (teardown,
  # an unhandled error), not a verdict on the mutant (@codex/@copilot, PR #1383).
  if [ "$status" -ne 0 ] && ! echo "$out" | grep -q failed; then
    echo "ERRORED   $1 — vitest exited $status without a failed test ($(echo "$out" | tr -s ' '))"
    BAD=$((BAD+1))
    return
  fi
  if echo "$out" | grep -q failed; then echo "KILLED    $1 — $(echo "$out" | tr -s ' ')"
  else echo "SURVIVED  $1 — $(echo "$out" | tr -s ' ')"; SURVIVORS=$((SURVIVORS+1)); fi
}

# A wrapper that runs the authorization with NO classification — what each
# concealUnreadableDenial call site reverts to.
PLAIN="await (async (run: () => Promise<void>) => run())("

# ── shared helpers ───────────────────────────────────────────────────────
run "1 resolveMemoryRefForWrite hides nothing" "$H" \
  "  if (await isMemoryHiddenForWrite(ctx, id, 'record')) throw new MemoryNotFoundError(ref);" ""
run "2 hidden-for-write never true" "$H" \
  "  return gate === 'node'
    ? !(await isMemoryReadableCached(ctx, memoryId))
    : !(await canOpenMemoryRecordById(ctx, memoryId));" "  return false;"
run "3 hidden-for-write hides readers too" "$H" \
  "  return gate === 'node'
    ? !(await isMemoryReadableCached(ctx, memoryId))
    : !(await canOpenMemoryRecordById(ctx, memoryId));" "  return true;"
run "4 hidden-for-write classifies every error" "$H" \
  "    return false;
  } catch (error) {
    if (!isAuthorizationDenial(error)) throw error;
  }" "    return false;
  } catch {
    // swallowed
  }"
run "5 conceal ignores the surface's own missing error" "$H" \
  "    if (await canOpenMemoryRecordById(ctx, memoryId)) throw error;
    throw missing();" "    if (await canOpenMemoryRecordById(ctx, memoryId)) throw error;
    throw new MemoryNotFoundError(ref);"

# ── reads ────────────────────────────────────────────────────────────────
run "6 usageEvents back to []" "$Q" \
  "          throw new MemoryNotFoundError(memoryId);" "          return [];"
run "7 memoryAssets back to PERMISSION_DENIED" "$LA" \
  "    throw new AssetUploadError('NOT_FOUND', 'memory not found');
  }

  const where" "    throw new AssetUploadError('PERMISSION_DENIED', 'caller does not have read access to memory');
  }

  const where"

# ── node mutations ───────────────────────────────────────────────────────
run "8 resolveExistingNode forWrite ignored" "$N" \
  "  if (opts?.forWrite && (await isMemoryHiddenForWrite(ctx, node.memoryId, 'node'))) {" "  if (false) {"
run "9 moveNode source not resolved for write" "$N" \
  "resolveExistingNode(ctx, sourceRef, { forWrite: true })" "resolveExistingNode(ctx, sourceRef)"
run "10 relocation targetMemoryRef" "$N" \
  "await resolveMemoryRefForWrite(ctx, targetMemoryRef as string)" "await resolveMemoryRef(ctx.db, targetMemoryRef as string)"
run "11 relocation targetUrn" "$N" \
  "await resolveMemoryRefForWrite(ctx, memoryUrn)" "await resolveMemoryRef(ctx.db, memoryUrn)"
run "12 replaceSubtree" "$N" \
  "await resolveMemoryRefForWrite(ctx, memoryId);" "await resolveMemoryRef(ctx.db, memoryId);"

# ── memory mutations ─────────────────────────────────────────────────────
run "13 mergeMemories source" "$M" \
  "await resolveMemoryRefForWrite(ctx, rawSource)" "await resolveMemoryRef(ctx.db, rawSource)"
run "14 mergeMemories target" "$M" \
  "await resolveMemoryRefForWrite(ctx, rawTarget)" "await resolveMemoryRef(ctx.db, rawTarget)"
run "15 deleteMemory" "$M" \
  "await concealUnreadableDenial(ctx, resolvedId, id, async () => {" "${PLAIN}async () => {"
run "16 encryptMemory" "$M" \
  "await concealUnreadableDenial(ctx, resolvedMemoryId, memoryId, async () => {" "${PLAIN}async () => {"
run "17 updateMemory conceal" "$M" \
  "await concealUnreadableDenial(ctx, id, ref, () => requireOwnerOrOrgRole(ctx, memory, 'ADMIN'));" \
  "await requireOwnerOrOrgRole(ctx, memory, 'ADMIN');" 1
run "18 setMemorySourceToken conceal" "$M" \
  "await concealUnreadableDenial(ctx, id, ref, () => requireOwnerOrOrgRole(ctx, memory, 'ADMIN'));" \
  "await requireOwnerOrOrgRole(ctx, memory, 'ADMIN');" 2
run "19 syncMemory conceal" "$M" \
  "await concealUnreadableDenial(ctx, id, ref, () => requireOwnerOrOrgRole(ctx, memory, 'CONTRIBUTOR'));" \
  "await requireOwnerOrOrgRole(ctx, memory, 'CONTRIBUTOR');"
run "20 pushMemoryToGit conceal" "$M" \
  "await concealUnreadableDenial(ctx, id, ref, () => requireOwnerOrOrgRole(ctx, memory, 'ADMIN'));" \
  "await requireOwnerOrOrgRole(ctx, memory, 'ADMIN');" 3
run "21 updateMemory back to the raw id" "$M" \
  "      ({ id } = await resolveMemoryRef(ctx.db, ref));" "" 1
run "22 create/update do not refuse a hidden memory" "$M" \
  "  if (await canOpenMemoryRecordById(ctx, memoryId)) return;
  throw refArgNotFoundError('memory', chosenRefArg(refArg)!);" "  return;"
run "23 createMemorySubscription skips the hidden refusal" "$M" \
  "      await refuseHiddenSubscriptionMemory(ctx, resolvedMemoryId, { ref: memoryRef, id: memoryId });" "" 1
run "24 updateMemorySubscription skips the hidden refusal" "$M" \
  "      await refuseHiddenSubscriptionMemory(ctx, resolvedMemoryId, { ref: memoryRef, id: memoryId });" "" 2
run "24a deleteMemorySubscription missing error" "$M" \
  "        () => refArgNotFoundError('memory', chosen)," "        () => new Error('Forbidden'),"
run "24b deleteMemorySubscription lets an org error through" "$M" \
  "        if (memoryHidden && callerInput) {" "        if (false) {"
run "24c deleteMemorySubscription converts faults too" "$M" \
  "        if (memoryHidden && callerInput) {" "        if (memoryHidden) {"
run "24d ambiguous org alias leaks" "$M" \
  "          e instanceof AmbiguousLegacyUrnError ||" ""
run "30 effectiveAccess conceal removed" "$O" \
  "      if ((memoryShaped || auditsSelf) && !(await callerCanOpenResource(ctx, resolved))) {" "      if (false) {"
run "31 effectiveAccess conceals memory-shaped only for a self-audit" "$O" \
  "      if ((memoryShaped || auditsSelf) && !(await callerCanOpenResource(ctx, resolved))) {" "      if (auditsSelf && !(await callerCanOpenResource(ctx, resolved))) {"
run "32 effectiveAccess treats every non-memory kind as unopenable" "$O" \
  "    return (await findOne()) != null;" "    return false;"
run "33 effectiveAccess judges a node by the record gate" "$O" \
  "  if (resolved.kind === 'node') return isMemoryReadableCached(ctx, resolved.memory.id);" "  if (resolved.kind === 'node') return canOpenMemoryRecordById(ctx, resolved.memory.id);"
run "34 effectiveAccess lets a find-one denial through" "$O" \
  "    if (isAuthorizationDenial(error)) return false;" ""
run "25 missing subscription row does not conceal" "$M" \
  "  if (!(await canOpenMemoryRecordById(ctx, memoryId))) throw refArgNotFoundError('memory', memoryRef);" ""
run "26 attachMemoryToApp" "$AM" \
  "await concealUnreadableDenial(ctx, memoryId, memoryRef, async () => {" "${PLAIN}async () => {"

echo
echo "survivors: $SURVIVORS   stale/errored: $BAD"
# A survivor is a guard no test pins — a failure, not a note (@codex, PR #1383).
[ "$BAD" -eq 0 ] && [ "$SURVIVORS" -eq 0 ]
