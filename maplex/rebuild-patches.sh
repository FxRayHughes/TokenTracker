#!/usr/bin/env bash
# Rebase the maplex patch series onto an upstream tag (Spigot/Paper style).
#
#   maplex/rebuild-patches.sh <tag> [workdir]     # e.g. v1.4.9
#
# 1. Creates/refreshes a worktree of xiufengsun/TokenTracker at <tag>
#    (default: ../tt-<version> next to this repo; any existing git clone works).
# 2. Applies patches/*.patch with `git am -3`. On a conflict it stops: fix the
#    files, `git add`, `git am --continue` in the workdir, then re-run this
#    script with the same arguments — it resumes and re-exports.
# 3. Re-exports every commit since <tag> into patches/ (rerere remembers
#    resolutions, so the next upstream bump replays them).
#
# To change a patch: edit in the workdir, `git commit --fixup <sha>` +
# `git rebase -i --autosquash <tag>` (or add a new commit), then
#   maplex/rebuild-patches.sh <tag> --export-only
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tag="${1:?usage: rebuild-patches.sh <tag> [workdir|--export-only] }"
tag="v${tag#v}"
mode="${2:-}"
work="${MAPLEX_WORKDIR:-$here/../../tt-${tag#v}}"
[ -n "$mode" ] && [ "$mode" != "--export-only" ] && work="$mode"
upstream_url="https://github.com/xiufengsun/TokenTracker.git"
g=(git -C "$work" -c user.name=maplex -c user.email=maplex@users.noreply.github.com -c commit.gpgsign=false -c rerere.enabled=true)

export_series() {
  rm -f "$here"/patches/*.patch
  "${g[@]}" format-patch -q --no-stat --zero-commit --full-index --no-signature \
    -o "$here/patches" "$tag..HEAD"
  echo "✓ exported $(ls "$here"/patches/*.patch | wc -l | tr -d ' ') patch(es) from $work ($tag..HEAD)"
}

if [ "$mode" = "--export-only" ]; then export_series; exit 0; fi

if [ -d "$work/.git" ] || [ -f "$work/.git" ]; then
  if [ -d "$("${g[@]}" rev-parse --git-path rebase-apply)" ]; then
    echo "✗ git am still in progress in $work — resolve, 'git am --continue', then re-run." >&2
    exit 1
  fi
else
  git clone -q --no-checkout "$upstream_url" "$work"
fi
"${g[@]}" fetch -q "$upstream_url" "refs/tags/$tag:refs/tags/$tag"

# Resume: HEAD already carries the series on top of the tag.
if [ "$("${g[@]}" rev-list --count "$tag..HEAD" 2>/dev/null || echo 0)" -gt 0 ] \
   && "${g[@]}" merge-base --is-ancestor "$tag" HEAD; then
  export_series; exit 0
fi

"${g[@]}" checkout -q --detach "$tag"
"${g[@]}" checkout -q -B "maplex-${tag}"
if ! "${g[@]}" am -3 --keep-cr "$here"/patches/*.patch; then
  echo "" >&2
  echo "✗ conflict. In $work: fix files, git add, git am --continue; then re-run:" >&2
  echo "  $0 $tag ${2:-}" >&2
  exit 1
fi
export_series
