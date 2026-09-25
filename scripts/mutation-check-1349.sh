#!/usr/bin/env bash
# Reproducible mutation check for the #1349 attach gate (PR #1357).
#
# Each entry flips ONE guard to its unsafe form, runs the #1349 matrix, and
# reports killed (the suite reds) or SURVIVED (the suite stays green). Requires
# a clean worktree: it reverts each mutation with `git checkout --`, so an
# UNCOMMITTED baseline would be destroyed. Guard against that first.
#
# Usage:  TEST_DATABASE_URL=postgresql://<user>@localhost:5432/<private_db> \
#           bash scripts/mutation-check-1349.sh
set -uo pipefail
cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain)" ]; then
  echo "REFUSING: worktree is dirty. This script reverts with 'git checkout --',"
  echo "which would discard uncommitted work. Commit or stash first."
  exit 1
fi
: "${TEST_DATABASE_URL:?set TEST_DATABASE_URL to a PRIVATE test database}"

H=src/api/graphql/schema/resolvers.helpers.ts
M=src/api/graphql/schema/resolvers.mutation.memory.ts
A=src/lib/agentPublicCongruence.ts
AG=src/api/graphql/schema/resolvers.mutation.agent.ts
SPEC=src/test/integration/agent-memory-attach-1349.test.ts

STALE=0
run() { # name file old new
  python3 - "$2" "$3" "$4" <<'PY' || { echo "STALE     $1 — pattern no longer matches the implementation"; STALE=$((STALE+1)); return; }
import sys
p, old, new = sys.argv[1:4]
s = open(p).read()
assert old in s
open(p, 'w').write(s.replace(old, new, 1))
PY
  out=$(TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm vitest run "$SPEC" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E '^ *Tests ')
  git checkout -q -- "$2"
  if echo "$out" | grep -q failed; then echo "KILLED    $1 — $(echo "$out" | tr -s ' ')"
  else echo "SURVIVED  $1 — $(echo "$out" | tr -s ' ')"; fi
}

run "1 attach gate removed" "$M" \
  "      await requireAgentMemoryGrant(txCtx, lockedAgent, memory, grantedRole, memoryRef);" "      "
run "2 re-role gate removed" "$M" \
  "      await requireAgentMemoryGrant(
        { ...ctx, db: tx } as Context,
        lockedAgent,
        memory,
        grantedRole,
        memoryRef,
      );" "      "
run "3 role validation disabled" "$H" \
  "  if (!(AGENT_MEMORY_ROLES as readonly string[]).includes(value)) {" "  if (false) {"
run "4 content gate -> record gate" "$H" \
  "  const canRead = await isMemoryReadableCached(self, memory.id);" "  const canRead = await canReadMemoryRecord(self, memory);"
run "5 tenancy check dropped" "$H" \
  "  if (!sameTenant && !publicRead) {" "  if (false) {"
run "6 PUBLIC allowed read-write cross-tenant" "$H" \
  "  const publicRead = role === 'read' && memory.visibility === 'PUBLIC';" \
  "  const publicRead = memory.visibility === 'PUBLIC';"
run "7 write-capability check dropped" "$H" \
  "    try {
      await requireMemoryWriteAccess(self, memory.id);" "    try {
      await Promise.resolve();"
run "8 user-principal narrowing removed" "$H" \
  "  const self = userPrincipalOnly(ctx);" "  const self = ctx;"
run "9 concealment -> plain FORBIDDEN" "$H" \
  "  if (!canRead) throw new MemoryNotFoundError(ref);" \
  "  if (!canRead) throw new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });"
run "10 PUBLIC-agent read-write guard removed" "$H" \
  "    if (agent.visibility === 'PUBLIC') {" "    if (false) {"
run "11 agent-becomes-PUBLIC guard removed" "$A" \
  "  if (writable.length > 0) {" "  if (false) {"
run "12 foreign-link revocation disabled" "$A" \
  "  if (foreign.length === 0) return 0;" "  if (true) return 0;"
run "13 revocation also drops same-tenant links" "$A" \
  "    return !sameTenant;" "    return true;"
run "14 re-role actor stamp dropped" "$M" \
  "        data: { role: grantedRole, updatedBy: ctx.userId ?? ctx.clientId ?? null }," \
  "        data: { role: grantedRole },"

# --- P1 round 2 (@codex on 7af8a4d6): each check serialized with its write ---
run "15 revocation skips org transfer" "$M" \
  "        if (visibility !== undefined || newOrgId !== undefined) {" \
  "        if (visibility !== undefined) {"
run "16 revocation classifies from the PRE-update row" "$M" \
  "          await revokeLinksForeignToTenant(tx, row, ctx.userId ?? ctx.clientId ?? null);" \
  "          await revokeLinksForeignToTenant(tx, { ...memory, visibility: visibility ?? memory.visibility }, ctx.userId ?? ctx.clientId ?? null);"
run "17 attach lock dropped (memory row)" "$M" \
  "  await tx.\$queryRaw\`SELECT id FROM memories WHERE id = \${memoryId} FOR UPDATE\`;" "  "
run "18 attach lock dropped (agent row)" "$M" \
  "  await tx.\$queryRaw\`SELECT id FROM agents WHERE id = \${agentId} FOR UPDATE\`;" "  "
run "19 publication check back outside the lock" "$AG" \
  "        if (visibility === 'PUBLIC') {
          await assertAgentPublicAllowed(tx, id);
        }" "        "
run "20 PUBLIC transfer keeps foreign writable links" "$A" \
  "  const writableOnly = memory.visibility === 'PUBLIC';" \
  "  const writableOnly = false; if (memory.visibility === 'PUBLIC') return 0;"
run "21 publication counts deleted-memory links" "$A" \
  "    where: { agentId, deletedAt: null, role: 'read-write', memory: { deletedAt: null } }," \
  "    where: { agentId, deletedAt: null, role: 'read-write' },"
run "23 publication does not lock linked memories" "$AG" \
  "        for (const memoryId of lockedMemoryIds) {
          await tx.\$queryRaw\`SELECT id FROM memories WHERE id = \${memoryId} FOR UPDATE\`;
        }" "        "
# 24 SURVIVES by design — see the UNPROVEN BY TEST note at that line. Kept in
# the harness so the fact stays visible in every run rather than being quietly
# dropped once someone notices it is green.
run "24 narrowing check not re-run under the lock (expected survivor)" "$M" \
  "        if (visibility !== undefined) {
          await assertMemoryVisibilityChangeAllowed(tx, memory, visibility);
        }" "        "

# 25 and 26 SURVIVE by design — see the UNPROVEN BY TEST notes at those lines.
run "25 promotion back outside the deciding transaction (expected survivor)" "$AG" \
  "        if (promoteSystemMemoryId) {
          await tx.memory.update({" \
  "        if (promoteSystemMemoryId) {
          await ctx.db.memory.update({"
run "26 post-lock link re-scan removed (expected survivor)" "$AG" \
  "          if (now.some((m: string) => !lockedMemoryIds.includes(m))) {
            throw new AgentLinkSetChangedError();
          }" "          "

run "27 syncs back before the deciding transaction" "$AG" \
  "      const MAX_PUBLISH_ATTEMPTS = 3;" \
  "      if (agent.systemMemoryId && name !== undefined) {
        await ctx.db.memory.update({ where: { id: agent.systemMemoryId }, data: { name: \`\${name} System\` } }).catch(() => {});
      }
      const MAX_PUBLISH_ATTEMPTS = 3;"
# 28 SURVIVES by design: a lock-order inversion shows up as a Postgres deadlock
# abort under precise timing, not as a wrong result, so no assertion can catch
# it. Kept because the inversion is real — see the lock-order note at that line.
run "28 promotion target left out of the ordered lock set (expected survivor)" "$AG" \
  "        if (promoteSystemMemoryId && !lockedMemoryIds.includes(promoteSystemMemoryId)) {
          lockedMemoryIds = [...lockedMemoryIds, promoteSystemMemoryId].sort();
        }" "        "

# A stale pattern is a FAILED run, not a skipped line. Counting only
# KILLED/SURVIVED lines once let two stale mutants — the attach gate and the
# re-role gate, the two that matter most — drop out of a reported total without
# anything looking wrong (@codex P2, PR #1357).
if [ "$STALE" -ne 0 ]; then
  echo
  echo "FAILED: $STALE mutation(s) no longer match the implementation."
  echo "Every reported count is therefore incomplete. Fix the patterns and re-run."
  exit 1
fi
echo
echo "All mutations applied cleanly; the counts above cover every mutant."
