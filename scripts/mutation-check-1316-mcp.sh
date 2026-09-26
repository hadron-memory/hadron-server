#!/usr/bin/env bash
# Reproducible mutation check for the #1316 MCP write-door slice.
#
# Each entry reverts ONE concealment site (or weakens a shared helper), runs the
# #1316 suites, and reports KILLED (the suites red) or SURVIVED (they stay
# green). Requires a clean worktree: it reverts each mutation with
# `git checkout --`, so an UNCOMMITTED baseline would be destroyed.
#
# A pattern that no longer matches is STALE and a run with no test summary is
# ERRORED; both fail the script, because either one otherwise reads as a result
# (the two ways the #1349 harness lied about its own numbers).
#
# Usage:  TEST_DATABASE_URL=postgresql://<user>@localhost:5432/<private_db> \
#           bash scripts/mutation-check-1316-mcp.sh
set -uo pipefail
cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain)" ]; then
  echo "REFUSING: worktree is dirty. This script reverts with 'git checkout --',"
  echo "which would discard uncommitted work. Commit or stash first."
  exit 1
fi
: "${TEST_DATABASE_URL:?set TEST_DATABASE_URL to a PRIVATE test database}"

S=src/mcp/server.ts
H=src/api/graphql/schema/resolvers.helpers.ts
N=src/api/graphql/schema/resolvers.mutation.node.ts
C=src/api/graphql/schema/resolvers.channel.ts
SPECS="src/test/integration/mcp-existence-oracle-1316.test.ts
src/test/integration/memory-existence-oracle-1316.test.ts
src/api/graphql/schema/resolvers.accessControl.test.ts
src/api/graphql/schema/resolvers.uniformReadSurface.test.ts
src/api/graphql/schema/resolvers.ownerOnlyMemory.test.ts
src/mcp/server.createNodeLiveCollision1181.test.ts
src/mcp/server.deleteMove.test.ts
src/mcp/server.replaceGlobally.test.ts
src/mcp/server.resurrect543.test.ts
src/test/integration/spec-hierarchy-neutral-1312.test.ts"

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
  if echo "$out" | grep -q failed; then echo "KILLED    $1 — $(echo "$out" | tr -s ' ')"
  elif [[ "$1" == *"(expected survivor)"* ]]; then echo "SURVIVED  $1 — $(echo "$out" | tr -s ' ')"
  else echo "SURVIVED  $1 — $(echo "$out" | tr -s ' ')"; SURVIVORS=$((SURVIVORS+1)); fi
}

VIS_W="resolveVisibleMemoryByUrn(auth, memoryUrn, 'write')"
RAW="resolveMemoryByUrn(memoryUrn)"

# ── MCP: the shared helper ────────────────────────────────────────────────
run "1 helper hides nothing" "$S" \
  "  return (await isMemoryHiddenFrom(auth, memory.id, need)) ? null : memory;" "  return memory;"
run "2 hidden-check never fires" "$S" \
  "  return !(await canReadMemory(db, auth, memoryId));" "  return false;"
run "3 hides from readers too" "$S" \
  "  return !(await canReadMemory(db, auth, memoryId));" "  return true;"
# EXPECTED SURVIVOR — write ⇒ read in every MCP gate branch, so the writer
# short-circuit is a no-op today; kept so it holds by construction (see the
# comment at the line).
run "4 writer short-circuit removed (expected survivor)" "$S" \
  "  if (need === 'write' && (await canWriteToMemory(db, auth, memoryId))) return false;" ""

# ── MCP: each call site reverted to the plain resolver ────────────────────
run "5 set_active_memory" "$S" "resolveVisibleMemoryByUrn(auth, memoryUrn, 'read');
      if (!mem)" "resolveMemoryByUrn(memoryUrn);
      if (!mem)"
run "6 hadron_validate" "$S" "resolveVisibleMemoryByUrn(auth, memoryUrn, 'read');
      if (!memory)" "resolveMemoryByUrn(memoryUrn);
      if (!memory)"
run "7 hadron_create_parent_node" "$S" "$VIS_W;
      if (!memory) {" "$RAW;
      if (!memory) {" 1
run "8 hadron_create_node" "$S" "$VIS_W;
      if (!memory) {" "$RAW;
      if (!memory) {" 2
run "9 hadron_update_node" "$S" "$VIS_W;
      if (!memory) {" "$RAW;
      if (!memory) {" 3
run "10 governed task/review doors" "$S" "$VIS_W;
    if (!memory)" "$RAW;
    if (!memory)"
run "11 hadron_move_node source" "$S" \
  "resolveVisibleMemoryByUrn(auth, fromMemoryUrn, 'write')" "resolveMemoryByUrn(fromMemoryUrn)"
run "12 hadron_move_node target" "$S" \
  "resolveVisibleMemoryByUrn(auth, toMemoryUrn, 'write')" "resolveMemoryByUrn(toMemoryUrn)"
run "13 hadron_sync_graph" "$S" \
  "const memoryRef = await $VIS_W;" "const memoryRef = await $RAW;"
run "14 hadron_create_edge source by URN" "$S" \
  "resolveVisibleMemoryByUrn(auth, sourceMemoryUrn, 'write')" "resolveMemoryByUrn(sourceMemoryUrn)"
run "15 hadron_create_edge source by id" "$S" \
  " || (await isMemoryHiddenFrom(auth, found.memoryId, 'write'))" ""

# ── GraphQL: the node-addressed helper ────────────────────────────────────
run "16 node helper never conceals" "$H" \
  "    if (await isMemoryReadableCached(ctx, memoryId)) throw error;
    throw missing();" "    throw error;"
run "17 node helper conceals readers too" "$H" \
  "    if (await isMemoryReadableCached(ctx, memoryId)) throw error;
    throw missing();" "    throw missing();"
run "18 node helper classifies every error" "$H" \
  "    if (!isAuthorizationDenial(error)) throw error;
    if (await isMemoryReadableCached(ctx, memoryId)) throw error;" \
  "    if (await isMemoryReadableCached(ctx, memoryId)) throw error;"

# ── GraphQL: each call site reverted to the bare write gate ───────────────
run "19 updateNodeData" "$N" "      await concealUnreadableNodeDenial(ctx, meta.memoryId, () => nodeNotFoundError(nodeRef), () =>
        requireMemoryWriteAccess(ctx, meta.memoryId),
      );" "      await requireMemoryWriteAccess(ctx, meta.memoryId);"
run "20 updateNodeProperties / updateObject" "$N" "  await concealUnreadableNodeDenial(ctx, meta.memoryId, () => nodeNotFoundError(nodeRef), () =>
    requireMemoryWriteAccess(ctx, meta.memoryId),
  );" "  await requireMemoryWriteAccess(ctx, meta.memoryId);"
run "21 deleteNode / deleteObject" "$N" "      await concealUnreadableNodeDenial(ctx, node.memoryId, () => nodeNotFoundError(nodeRef), () =>
        requireMemoryWriteAccess(ctx, node.memoryId),
      );" "      await requireMemoryWriteAccess(ctx, node.memoryId);"
run "22 searchReplaceInNodes(memoryIds)" "$N" \
  "          await concealUnreadableDenial(ctx, memId, ref, () => ensureAuthed(memId));" \
  "          await ensureAuthed(memId);"
run "23 searchReplaceInNodes(nodeIds)" "$N" "          await concealUnreadableNodeDenial(ctx, row.memoryId, () => new NodeNotFoundError(ref), () =>
            ensureAuthed(row.memoryId),
          );" "          await ensureAuthed(row.memoryId);"
run "24 createChannel" "$C" \
  "    await concealUnreadableDenial(ctx, memoryId, memoryRef, () => requireMemoryWriteAccess(ctx, memoryId));" \
  "    await requireMemoryWriteAccess(ctx, memoryId);"
run "25 writeNodeCore memory-addressed door" "$N" \
  "        await concealUnreadableDenial(ctx, resolvedMemoryId, conceal.ref, authorizeWrite);" \
  "        await authorizeWrite();"
run "26 writeNodeCore node-addressed door" "$N" \
  "        await concealUnreadableNodeDenial(ctx, resolvedMemoryId, () => nodeNotFoundError(conceal.ref), authorizeWrite);" \
  "        await authorizeWrite();"

echo
echo "unexpected survivors: $SURVIVORS (#4 is expected and not counted)   stale/errored: $BAD"
# An unexpected survivor is a guard no test pins — a failure, not a note
# (@codex, PR #1383). Only a mutant NAMED "(expected survivor)", with its
# reason documented at the line it mutates, may survive.
[ "$BAD" -eq 0 ] && [ "$SURVIVORS" -eq 0 ]
