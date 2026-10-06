#!/usr/bin/env bash
set -euo pipefail

# sync-merge.sh: Merges an upstream commit into the current branch while strictly
# preserving the fork's own .github/workflows/ directory, even if upstream changes
# or conflicts in workflow files occurred.

UPSTREAM_COMMIT="${1:-}"
TARGET_TAG="${2:-}"

if [[ -z "${UPSTREAM_COMMIT}" ]]; then
  echo "Usage: $0 <UPSTREAM_COMMIT> [TARGET_TAG]" >&2
  exit 1
fi

FORK_SHA=$(git rev-parse HEAD)
echo "Current fork HEAD: ${FORK_SHA}"
echo "Upstream target commit: ${UPSTREAM_COMMIT}"

# Check if upstream commit is already an ancestor of fork HEAD
if git merge-base --is-ancestor "${UPSTREAM_COMMIT}" HEAD; then
  echo "Upstream commit ${UPSTREAM_COMMIT} is already an ancestor of HEAD. Nothing to merge."
  exit 0
fi

# Attempt merge stopping before commit
set +e
git merge "${UPSTREAM_COMMIT}" --no-ff --no-commit -m "chore(sync): sync upstream lobehub ${TARGET_TAG:-$UPSTREAM_COMMIT} into canary"
MERGE_EXIT=$?
set -e

# Always restore the fork's entire .github/workflows/ tree from pre-merge FORK_SHA
git restore --source="${FORK_SHA}" --staged --worktree -- .github/workflows/
git clean -fd .github/workflows/

# Verify that .github/workflows exactly matches FORK_SHA
if ! git diff --exit-code "${FORK_SHA}" -- .github/workflows/ >/dev/null; then
  echo "::error::Failed to restore fork workflow tree to exact match with ${FORK_SHA}" >&2
  git merge --abort || true
  exit 1
fi

# Check if there are any remaining unresolved conflict paths outside .github/workflows/
UNRESOLVED=$(git diff --name-only --diff-filter=U)
if [[ -n "${UNRESOLVED}" ]]; then
  echo "::error::Unresolved merge conflicts in application files outside .github/workflows/:" >&2
  echo "${UNRESOLVED}" >&2
  git merge --abort
  exit 1
fi

# If merge was stopped or had conflicts that are now resolved, commit the merge
git commit -m "chore(sync): sync upstream lobehub ${TARGET_TAG:-$UPSTREAM_COMMIT} into canary"
echo "Successfully merged ${UPSTREAM_COMMIT} into canary while preserving fork workflows."
