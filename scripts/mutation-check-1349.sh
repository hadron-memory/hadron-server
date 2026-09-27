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
AT=src/api/graphql/schema/resolvers.types.ts
SPEC=src/test/integration/agent-memory-attach-1349.test.ts

STALE=0
UNEXPECTED=0

# Baseline on the unmutated tree (ported from #1383's hardening): exit status
# zero, no failed line, and the TOTAL test count every mutant run must
# reproduce. A run reporting fewer tests (a file that failed to load, a crashed
# worker, an exhausted DB) did not test the mutant; it must not read as a
# survivor — #1383 observed a 13-of-297 run reported as SURVIVED.
base_raw=$(TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm vitest run "$SPEC" 2>&1 | sed 's/\x1b\[[0-9;]*m//g')
base_status=$?
base_line=$(echo "$base_raw" | grep -E '^ *Tests ')
BASELINE=$(echo "$base_line" | sed -nE 's/.*\(([0-9]+)\).*/\1/p')
if [ "$base_status" -ne 0 ] || [ -z "$BASELINE" ] || echo "$base_raw" | grep -qE '^ *(Tests|Test Files) .*failed'; then
  echo "REFUSING: the baseline is not green (vitest exit $base_status) — $base_line"
  echo "$base_raw" | tail -5 | sed 's/^/            /'
  exit 1
fi
echo "baseline: $BASELINE tests, all passing"

run() { # name file old new
  python3 - "$2" "$3" "$4" <<'PY' || { echo "STALE     $1 — pattern no longer matches the implementation"; STALE=$((STALE+1)); return; }
import sys
p, old, new = sys.argv[1:4]
s = open(p).read()
assert old in s
open(p, 'w').write(s.replace(old, new, 1))
PY
  raw=$(TEST_DATABASE_URL="$TEST_DATABASE_URL" pnpm vitest run "$SPEC" 2>&1 | sed 's/\x1b\[[0-9;]*m//g')
  status=$?
  out=$(echo "$raw" | grep -E '^ *Tests ')
  git checkout -q -- "$2"
  # A run that produced NO `Tests` summary did not report on the mutant at all —
  # vitest crashed, the DB was unreachable, a transform failed. Reporting that
  # as SURVIVED makes an infrastructure failure indistinguishable from a real
  # coverage gap, which is the second way this harness lied about its own
  # numbers (@codex, PR #1357; the first was the stale-pattern skip).
  if [ -z "$out" ]; then
    echo "ERRORED   $1 — no test summary; the run did not report on this mutant"
    echo "$raw" | tail -5 | sed 's/^/            /'
    STALE=$((STALE+1))
    return
  fi
  total=$(echo "$out" | sed -nE 's/.*\(([0-9]+)\).*/\1/p')
  if [ "$total" != "$BASELINE" ]; then
    echo "ERRORED   $1 — partial run: $total of $BASELINE tests reported ($(echo "$out" | tr -s ' '))"
    STALE=$((STALE+1))
    return
  fi
  # A nonzero exit with NO failed test is an operational failure, not a
  # verdict on the mutant (@codex, PR #1357 round 2).
  if [ "$status" -ne 0 ] && ! echo "$out" | grep -q failed; then
    echo "ERRORED   $1 — vitest exited $status without a failed test ($(echo "$out" | tr -s ' '))"
    STALE=$((STALE+1))
    return
  fi
  if echo "$out" | grep -q failed; then echo "KILLED    $1 — $(echo "$out" | tr -s ' ')"
  elif [[ "$1" == *"(expected survivor)"* ]]; then echo "SURVIVED  $1 — $(echo "$out" | tr -s ' ')"
  else echo "SURVIVED  $1 — $(echo "$out" | tr -s ' ')"; UNEXPECTED=$((UNEXPECTED+1)); fi
}

# The gate now also PARSES the role and returns it (@copilot, PR #1357), so
# removing it must still define grantedRole — without a helper this file no
# longer imports, or the run dies on a ReferenceError and "kills" falsely.
run "1 attach gate removed" "$M" \
  "      const grantedRole = await requireAgentMemoryGrant(txCtx, lockedAgent, memory, role, memoryRef);" \
  "      const grantedRole = (role ?? 'read') as never;"
run "2 re-role gate removed" "$M" \
  "      const grantedRole = await requireAgentMemoryGrant(
        { ...ctx, db: tx } as Context,
        lockedAgent,
        memory,
        role,
        memoryRef,
      );" "      const grantedRole = (role ?? 'read') as never;"
run "3 role validation disabled" "$H" \
  "  if (!(AGENT_MEMORY_ROLES as readonly string[]).includes(value)) {" "  if (false) {"
run "4 content gate -> record gate" "$H" \
  "  const independentlyReadable = await holdsContentReadIndependently(ctx, memory.id);" \
  "  const independentlyReadable = await canReadMemoryRecord(userPrincipalOnly(ctx), memory);"
run "5 tenancy check dropped" "$H" \
  "  if (!sameTenant && !publicRead) {" "  if (false) {"
run "6 PUBLIC allowed read-write cross-tenant" "$H" \
  "  const publicRead = role === 'read' && genuinelyPublic;" "  const publicRead = genuinelyPublic;"
run "7 write-capability check dropped (expected survivor)" "$H" \
  "    try {
      await requireMemoryWriteAccess(self, memory.id);" "    try {
      await Promise.resolve();"
run "8 user-principal narrowing removed (expected survivor)" "$H" \
  "  const self = userPrincipalOnly(ctx);" "  const self = ctx;"
run "9 concealment -> plain FORBIDDEN" "$H" \
  "  if (!canRead) throw new MemoryNotFoundError(ref);" \
  "  if (!canRead) throw new GraphQLError('Forbidden', { extensions: { code: 'FORBIDDEN' } });"
run "10 PUBLIC-agent read-write guard removed" "$H" \
  "    if (agent.visibility === 'PUBLIC' && !isExcludedFromCoveredSet(memory)) {" "    if (false) {"
run "11 agent-becomes-PUBLIC guard removed" "$A" \
  "  if (writable.length > 0) {" "  if (false) {"
run "12 foreign-link revocation disabled" "$A" \
  "  if (invalid.length === 0) return 0;" "  if (true) return 0;"
run "13 revocation also drops same-tenant links" "$A" \
  "    return !sameTenant || publicAgentWriter;" "    return true;"
run "14 re-role actor stamp dropped" "$M" \
  "        data: { role: grantedRole, updatedBy: ctx.userId ?? ctx.clientId ?? null }," \
  "        data: { role: grantedRole },"

# --- P1 round 2 (@codex on 7af8a4d6): each check serialized with its write ---
# Anchored on the revocation call: the congruence check now opens with an
# identical line, and a first-occurrence match silently mutated IT instead
# (found when this mutant started "surviving" in round 4).
run "15 revocation skips org transfer" "$M" \
  "        if (visibility !== undefined || newOrgId !== undefined) {
          await revokeLinksForeignToTenant(" \
  "        if (visibility !== undefined) {
          await revokeLinksForeignToTenant("
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
  "  const writableOnly =
    memory.visibility === 'PUBLIC' && !isExcludedFromCoveredSet(memory) && memory.ownerUserId == null;" \
  "  const writableOnly = false; if (memory.visibility === 'PUBLIC') return 0;"
run "21 publication counts deleted-memory links" "$A" \
  "        deletedAt: null,
        class: { notIn: ['personal', 'private'] },
        appId: null," \
  "        class: { notIn: ['personal', 'private'] },
        appId: null,"
run "23 publication does not lock linked memories" "$AG" \
  "        for (const memoryId of lockedMemoryIds) {
          await tx.\$queryRaw\`SELECT id FROM memories WHERE id = \${memoryId} FOR UPDATE\`;
        }" "        "
# 24/25/28 were once expected survivors; later tests pin them (verified by hand,
# PR #1357 round 2): each is killed by the concurrency test written for it, so
# they are no longer allow-listed (@codex) — a regression must fail this script.
run "24 narrowing check not re-run under the lock" "$M" \
  "          await assertMemoryVisibilityChangeAllowed(tx, row, visibility ?? row.visibility);" ""

# 26 SURVIVES by design — see the UNPROVEN BY TEST note at that line.
run "25 promotion back outside the deciding transaction" "$AG" \
  "          await tx.memory.update({
            where: { id: promoteSystemMemoryId }," \
  "          await ctx.db.memory.update({
            where: { id: promoteSystemMemoryId },"
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
run "28 promotion target left out of the ordered lock set" "$AG" \
  "        if (promoteSystemMemoryId && !lockedMemoryIds.includes(promoteSystemMemoryId)) {
          lockedMemoryIds = [...lockedMemoryIds, promoteSystemMemoryId].sort();
        }" "        "

# --- P1 round 6 (@codex on da0715e6): the five findings ---
run "29 App-derived reach not excluded (laundering)" "$H" \
  "  return getAccessibleMemoryIds(self, memoryId, { excludeAppDerived: true }).then(" \
  "  return getAccessibleMemoryIds(self, memoryId).then("
run "30 PUBLIC column treated as a public audience" "$H" \
  "    memory.visibility === 'PUBLIC' &&
    !isExcludedFromCoveredSet(memory) &&
    memory.ownerUserId == null;" "    memory.visibility === 'PUBLIC';"
run "31 writable-link guard ignores covered-set exclusions" "$A" \
  "        class: { notIn: ['personal', 'private'] },
        appId: null," "        "
run "32 locked systemMemoryId re-check removed" "$AG" \
  "          if (lockedAgent.systemMemoryId && lockedAgent.systemMemoryId !== promoteSystemMemoryId) {" \
  "          if (false) {"
run "33 locked other-claimant re-check removed" "$AG" \
  "          if (claimedElsewhere) {
            throw new GraphQLError('This memory is already the system memory of another agent', {
              extensions: { code: 'BAD_USER_INPUT' },
            });
          }" "          void claimedElsewhere;"

# ── #1357 same-App attach (Holger's ruling, 2026-09-26) ──────────────────
run "34 same-App branch removed" "$H" \
  "  const sameAppRead = asked === 'read' && (await sameAppAttachAdmitted(ctx, agent, memory));" \
  "  const sameAppRead = false;"
run "35 same-App branch admits read-write" "$H" \
  "  const sameAppRead = asked === 'read' && (await sameAppAttachAdmitted(ctx, agent, memory));" \
  "  const sameAppRead = await sameAppAttachAdmitted(ctx, agent, memory);"
run "36 same-App install check removed (cross-App shortcut)" "$H" \
  "  if (installed.length === 0) return false;" ""
run "37 same-App App gate removed (expected survivor)" "$H" \
  "  try {
    await requireOwnerOrOrgRole(ctx, app, 'ADMIN');
  } catch (error) {
    if (!isAuthorizationDenial(error)) throw error;
    return false;
  }
  return true;" "  return true;"
run "38 same-App class restriction removed" "$H" \
  "  if (memory.class !== 'knowledge' && memory.class !== 'group') return false;" ""
run "39 same-App admits an uninstalled App" "$H" \
  "AND uninstalled_at IS NULL FOR SHARE" "FOR SHARE"
run "40 same-App admits a deleted App" "$H" \
  "AND deleted_at IS NULL AND uninstalled_at IS NULL FOR SHARE" \
  "AND uninstalled_at IS NULL FOR SHARE"
run "41 same-App admits an App in a soft-deleted org" "$H" \
  "AND deleted_at IS NULL FOR SHARE" "FOR SHARE"
run "45 role parsed before concealment" "$H" \
  "  const asked = rawRole ?? 'read';" "  const asked = parseAgentMemoryRole(rawRole);"
run "46 narrowing judged against the pre-transfer tenant (fail-fast)" "$M" \
  "          { ...memory, organizationId: newOrgId ?? memory.organizationId }," "          memory,"
run "47 narrowing judged against the pre-update row (in-transaction)" "$M" \
  "          await assertMemoryVisibilityChangeAllowed(tx, row, visibility ?? row.visibility);" "          await assertMemoryVisibilityChangeAllowed(tx, memory, visibility ?? memory.visibility);"
run "48 a transfer alone skips the congruence check" "$M" \
  "        if (visibility !== undefined || newOrgId !== undefined) {
          // The POST-update row" "        if (visibility !== undefined) {
          // The POST-update row"
run "49 agent gate not re-run on the locked agent (attach)" "$M" \
  "      await requireOwnerOrOrgRole(txCtx, lockedAgent, 'ADMIN');" ""
run "50 agent gate not re-run on the locked agent (re-role)" "$M" \
  "      await requireOwnerOrOrgRole({ ...ctx, db: tx } as Context, lockedAgent, 'ADMIN');" ""
run "51 rename sync keyed on the stale pre-transaction URN" "$AG" \
  "          oldAgentUrn: replacedUrn," "          oldAgentUrn: agent.urn,"
run "52 PUBLIC-agent read-write guard ignores the covered set" "$H" \
  "    if (agent.visibility === 'PUBLIC' && !isExcludedFromCoveredSet(memory)) {" "    if (agent.visibility === 'PUBLIC') {"
run "53 an APP-class memory is attachable again" "$H" \
  "  if (memory.class === 'app') {" "  if (false) {"
run "54 locked agent liveness not checked" "$M" \
  "  if (agent.deletedAt) throw new AgentNotFoundError(refs.agentRef);" ""
run "55 locked memory liveness not checked" "$M" \
  "  if (memory.deletedAt) throw new MemoryNotFoundError(refs.memoryRef);" ""
run "56 promotion names the memory from the pre-transaction snapshot" "$AG" \
  "              name: \`\${name ?? lockedAgent.name} System\`," "              name: \`\${name ?? agent.name} System\`,"
run "57 syncs gated on the pre-read systemMemoryId" "$AG" \
  "      const committedSystemMemoryId = published?.systemMemoryId ?? agent.systemMemoryId;" "      const committedSystemMemoryId = agent.systemMemoryId;"
run "58 same-App install check read without the lock" "$H" \
  "    SELECT app_id FROM app_agents WHERE app_id = \${app.id} AND agent_id = \${agent.id} FOR KEY SHARE" "    SELECT app_id FROM app_agents WHERE app_id = \${app.id} AND agent_id = \${agent.id}"
# #1357 round 10 (@codex): user-owned PUBLIC is not a public Agent.memoryItems
# audience, even when the legacy link is excluded from congruence checks.
run "59 Agent.memoryItems bypasses the owner record gate" "$AT" \
  "if (mem.visibility === 'PUBLIC' && mem.appId == null && mem.ownerUserId == null && mem.userMemoryOfAgentId == null) {" \
  "if (mem.visibility === 'PUBLIC' && mem.appId == null && mem.userMemoryOfAgentId == null) {"
# #1357 round 11 (@copilot): legacy re-role must share the PUBLIC link gate.
run "60 re-role bypasses PUBLIC knowledge congruence" "$H" \
  "  await assertLinkAllowedForPublicAgent(agent.visibility, memory);" ""
# #1357 round 12 (@copilot): a destination PUBLIC agent's legacy writer
# becomes same-tenant on transfer and must still be revoked.
run "61 transfer retains a destination PUBLIC-agent writer" "$A" \
  "    return !sameTenant || publicAgentWriter;" "    return !sameTenant;"
# #1357 round 13 (@copilot): platform ADMIN's independent read must not bypass
# the same-App live-install/read-only constraint on App-scoped grants.
run "62 platform ADMIN bypasses App-scoped grant rule" "$H" \
  "      (memory.class === 'knowledge' || memory.class === 'group') && !sameAppRead) {" \
  "      (memory.class === 'knowledge' || memory.class === 'group') && false) {"
# #1357 round 15: the locked target must remain live, and the App/org lifecycle
# rows must stay locked until the App-scoped grant commits.
run "63 locked system-memory target liveness removed" "$AG" \
  "          if (lockedTarget.deletedAt) {" "          if (false) {"
run "64 App lifecycle row lock removed" "$H" \
  "AND uninstalled_at IS NULL FOR SHARE" "AND uninstalled_at IS NULL"
run "65 org lifecycle row lock removed" "$H" \
  "AND deleted_at IS NULL FOR SHARE" "AND deleted_at IS NULL"
run "42 a foreign PUBLIC agent vetoes the narrowing again" "$A" \
  "      OR: sameTenant," ""
run "43 sweep keys on the raw PUBLIC column" "$A" \
  "    memory.visibility === 'PUBLIC' && !isExcludedFromCoveredSet(memory) && memory.ownerUserId == null;" "    memory.visibility === 'PUBLIC';"
run "44 same-App admits a user-owned row" "$H" \
  "  if (memory.ownerUserId != null) return false;" ""
run "66 same-App admits a creator-scoped holding" "$H" \
  "  if (memory.userMemoryOfAgentId != null) return false;" ""

# A stale pattern is a FAILED run, not a skipped line. Counting only
# KILLED/SURVIVED lines once let two stale mutants — the attach gate and the
# re-role gate, the two that matter most — drop out of a reported total without
# anything looking wrong (@codex P2, PR #1357).
if [ "$STALE" -ne 0 ]; then
  echo
  echo "FAILED: $STALE mutation(s) were STALE or ERRORED."
  echo "Every reported count is therefore incomplete — a stale pattern was never"
  echo "applied, and an errored run never reported. Fix and re-run."
  exit 1
fi
if [ "$UNEXPECTED" -ne 0 ]; then
  echo
  echo "FAILED: $UNEXPECTED unexpected survivor(s) — a guard no test pins. Only a"
  echo "mutant NAMED '(expected survivor)', with its reason at the mutated line,"
  echo "may survive (@codex, PR #1383)."
  exit 1
fi
echo
echo "All mutations applied cleanly; the counts above cover every mutant."
