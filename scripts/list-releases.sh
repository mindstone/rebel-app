#!/usr/bin/env bash
# List production releases as a canonical version->date table.
#
# Source of truth: package.json version changes on origin/main. A release ships
# version A, then a post-release commit bumps package.json A -> B. So the version
# that SHIPPED is the one REMOVED ('-') from package.json, dated at that commit.
# That date is the post-release bump, which lands within ~1 day of the actual
# promote-to-production commit (exact, but only present for recent releases).
# Git tags are stale and commit-message greps are noisy, so neither is used.
#
# Usage:
#   scripts/list-releases.sh           # most recent 20 releases
#   scripts/list-releases.sh 50        # most recent 50
#   scripts/list-releases.sh | grep 0.4.48   # look up a specific version
set -euo pipefail

limit="${1:-20}"

git log origin/main --format='%ad' --date=short -p -- package.json \
  | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}$|^-  "version":' \
  | awk '/^[0-9]{4}-/{d=$0} /version/{gsub(/[-",]/,""); print $2" "d}' \
  | awk '!seen[$1]++' \
  | head -n "$limit"
