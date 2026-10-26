#!/usr/bin/env bash
# Apply the maplex patch series to an upstream TokenTracker checkout.
#
#   maplex/apply-patches.sh <upstream-checkout>
#
# The checkout must be a git repo at the upstream tag (actions/checkout gives
# one). Patches are applied with `git am -3`: a 3-way merge that survives
# upstream moving code around and stops on a real conflict instead of
# shipping a half-patched client. Fix conflicts with maplex/rebuild-patches.sh.
#
# Env: MAPLEX_RELEASE_VERSION=X.Y.Z.N stamps a maplex sub-release version.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "${1:?usage: apply-patches.sh <upstream-checkout>}" && pwd)"
shopt -s nullglob
patches=("$here"/patches/*.patch)
[ ${#patches[@]} -gt 0 ] || { echo "✗ no patches in $here/patches" >&2; exit 1; }

git_id=(-c user.name=maplex -c user.email=maplex@users.noreply.github.com -c commit.gpgsign=false)
base="$(git -C "$root" rev-parse HEAD)"
if ! git -C "$root" "${git_id[@]}" am -3 --keep-cr --committer-date-is-author-date "${patches[@]}"; then
  echo "" >&2
  echo "✗ a maplex patch no longer applies to this upstream version." >&2
  echo "  Rebase the series locally: maplex/rebuild-patches.sh <tag>" >&2
  git -C "$root" am --abort || true
  exit 1
fi
# Keep HEAD on the upstream commit (release notes record it); the patched
# tree stays in the working copy.
git -C "$root" reset -q "$base"
echo "✓ ${#patches[@]} maplex patch(es) applied"

# Sub-release stamping and the official-backend leak check stay in node.
node "$here/finalize.cjs" "$root"
