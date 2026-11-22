#!/usr/bin/env bash
set -euo pipefail

# sync-merge.sh: Merges an upstream commit into the current branch while strictly
# preserving the fork's own .github/workflows/ directory and sync scripts,
# even if upstream changes or conflicts occurred in those files.

UPSTREAM_COMMIT="${1:-}"
TARGET_TAG="${2:-}"

if [[ -z "${UPSTREAM_COMMIT}" ]]; then
  echo "Usage: $0 <UPSTREAM_COMMIT> [TARGET_TAG]" >&2
  exit 1
fi

FORK_SHA=$(git rev-parse HEAD)
PROTECTED_PATHS=(
  .github/workflows/
  .github/scripts/check-upstream-canary.mjs
  .github/scripts/sync-merge.sh
  .github/upstream-canary-state.json
)
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

# Drop every index entry under protected paths, conflict stages included. A path the fork
# removed but upstream modified becomes a modify/delete conflict, and git restore refuses
# such unmerged entries when the path is absent from FORK_SHA.
git rm -r -q --cached --ignore-unmatch -- "${PROTECTED_PATHS[@]}"

# Always restore the fork's workflows, sync scripts, and state from pre-merge FORK_SHA
git restore --source="${FORK_SHA}" --staged --worktree -- "${PROTECTED_PATHS[@]}"

# Remove upstream-only workflow files left in the worktree as untracked files
git clean -fd -- .github/workflows/

# Verify that protected paths exactly match FORK_SHA
if ! git diff --exit-code "${FORK_SHA}" -- "${PROTECTED_PATHS[@]}" >/dev/null; then
  echo "::error::Failed to restore fork workflow tree and sync scripts to exact match with ${FORK_SHA}" >&2
  git merge --abort || true
  exit 1
fi

# Check if there are any remaining unresolved conflict paths outside protected paths
UNRESOLVED=$(git diff --name-only --diff-filter=U)
if [[ -n "${UNRESOLVED}" ]]; then
  echo "::error::Unresolved merge conflicts in application files:" >&2
  echo "${UNRESOLVED}" >&2
  git merge --abort
  exit 1
fi

# If merge was stopped or had conflicts that are now resolved, commit the merge
git commit -m "chore(sync): sync upstream lobehub ${TARGET_TAG:-$UPSTREAM_COMMIT} into canary"
echo "Successfully merged ${UPSTREAM_COMMIT} into canary while preserving fork workflows."
