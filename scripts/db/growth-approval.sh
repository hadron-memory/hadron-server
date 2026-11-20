#!/usr/bin/env bash
# #4395 item 2: the Migration Replay workflow's growth-approval label filters, in one place so the workflow and
# scripts/db/migration-replay.test.ts run the same filter text. Prints `true` when the change manager's
# baseline-growth-approved label approves growth, `false` otherwise. Reads the JSON payload on stdin.
#
#   growth-approval.sh pr          < "$GITHUB_EVENT_PATH"                   # the PR's own labels
#   growth-approval.sh push <sha>  < (gh api repos/<repo>/commits/<sha>/pulls)
#
# push: only the PR whose merge commit IS the pushed commit lends its label (#4392 BLIND F1); a stacked or batched PR
# that merely contains the commit never does. A missing `labels` field reads as no labels, not a filter error.
# A usage error exits 2 and prints nothing, so a caller can never read it as an approval.
set -euo pipefail
LABEL=baseline-growth-approved
case "${1:-}" in
  pr)
    jq -r --arg label "$LABEL" '[(.pull_request.labels // [])[] | .name] | index($label) != null' ;;
  push)
    [ -n "${2:-}" ] || { echo "usage: growth-approval.sh push <sha>" >&2; exit 2; }
    jq -r --arg label "$LABEL" --arg sha "$2" \
      '[.[] | select(.merge_commit_sha == $sha) | (.labels // [])[] | .name] | index($label) != null' ;;
  *)
    echo "usage: growth-approval.sh pr | push <sha>" >&2; exit 2 ;;
esac
