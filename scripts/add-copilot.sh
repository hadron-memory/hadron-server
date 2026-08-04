#!/usr/bin/env bash
#
# Request a Copilot code review on a GitHub PR, and optionally ask Codex too.
#
# Usage:
#   scripts/add-copilot.sh [owner/repo] [pr-number] [--codex]
#
#   Both positionals are optional and order-independent (a value containing "/"
#   is the repo, a bare number is the PR). Omitted values are inferred from the
#   current directory / current branch.
#
#   --codex   also post an "@codex review" comment on the PR.
#
# Examples:
#   scripts/add-copilot.sh                      # current repo, current branch's PR
#   scripts/add-copilot.sh 815                  # current repo, PR 815
#   scripts/add-copilot.sh owner/repo 815 -c    # explicit, plus @codex review

set -euo pipefail

readonly COPILOT='copilot-pull-request-reviewer[bot]'
readonly CODEX_COMMENT='@codex review'

GITHUB_REPO=''
PR_NUMBER=''
WANT_CODEX=false

usage() {
  sed -n '3,18p' "$0" | sed 's/^# \{0,1\}//'
}

die() {
  echo "error: $*" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -c | --codex) WANT_CODEX=true ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*) die "unknown option: $1" ;;
    */*) GITHUB_REPO="$1" ;;
    *[0-9]*)
      [[ "$1" =~ ^[0-9]+$ ]] || die "not a PR number: $1"
      PR_NUMBER="$1"
      ;;
    *) die "unrecognized argument: $1" ;;
  esac
  shift
done

command -v gh >/dev/null 2>&1 || die 'gh CLI not found on PATH'

# Infer whatever wasn't passed. `gh pr view` with no number resolves the PR of
# the current branch.
if [[ -z "$GITHUB_REPO" ]]; then
  GITHUB_REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner) ||
    die 'could not determine the repo — pass owner/repo'
fi

if [[ -z "$PR_NUMBER" ]]; then
  PR_NUMBER=$(gh pr view --json number -q .number 2>/dev/null) ||
    die 'could not determine the PR from the current branch — pass a PR number'
fi

echo "Requesting Copilot review on ${GITHUB_REPO}#${PR_NUMBER}"

# The "[bot]" suffix is load-bearing: without it the API answers 200 but adds
# no reviewer. Likewise `gh pr edit --add-reviewer Copilot` silently no-ops.
#
# A failure here isn't fatal — GitHub 422s when Copilot has already reviewed —
# so fall through to verification, which is what actually decides the outcome.
if ! post_output=$(gh api \
  -X POST \
  "/repos/${GITHUB_REPO}/pulls/${PR_NUMBER}/requested_reviewers" \
  -f "reviewers[]=${COPILOT}" 2>&1); then
  echo "note: the review request returned an error:" >&2
  echo "$post_output" | tail -5 >&2
fi

# Verify via REST, NOT `gh pr view --json reviewRequests`: that goes through
# GraphQL, whose reviewRequests connection omits Bot reviewers and so reports a
# false no-op on a request that actually succeeded.
#
# requested_reviewers only lists PENDING requests — Copilot drops off it the
# moment it submits, often within a minute. So an empty list is ambiguous, and
# a landed review counts as success.
pending=$(gh api "/repos/${GITHUB_REPO}/pulls/${PR_NUMBER}/requested_reviewers" \
  --jq '[.users[] | "\(.login) (\(.type))"] | join(", ")')
reviews=$(gh api "/repos/${GITHUB_REPO}/pulls/${PR_NUMBER}/reviews" \
  --jq '[.[] | "\(.user.login) \(.state)"] | join(", ")')

# Case-insensitive first letter: the pending list renders the bot as
# "Copilot (Bot)" while the reviews list uses the "copilot-..." login.
if [[ "$pending" == *[Cc]opilot* ]]; then
  echo "✓ Copilot is a requested reviewer (pending: ${pending})"
elif [[ "$reviews" == *"$COPILOT"* ]]; then
  echo "✓ Copilot has already submitted its review (${reviews})"
else
  echo "✗ Copilot appears in neither the pending list nor the reviews — the request did not take." >&2
  [[ -n "$pending" ]] && echo "  pending reviewers: ${pending}" >&2
  [[ -n "$reviews" ]] && echo "  reviews: ${reviews}" >&2
  exit 1
fi

if [[ "$WANT_CODEX" == true ]]; then
  echo "Posting \"${CODEX_COMMENT}\" on ${GITHUB_REPO}#${PR_NUMBER}"
  gh pr comment "$PR_NUMBER" --repo "$GITHUB_REPO" --body "$CODEX_COMMENT" >/dev/null
  echo "✓ Codex review requested"
fi

gh pr view "$PR_NUMBER" --repo "$GITHUB_REPO" --json url -q .url
