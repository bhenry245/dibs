#!/bin/bash
# Runs on the server every minute (see dibs-deploy.timer). If main has a new commit and its CI
# passed, deploys it. GitHub never needs AWS credentials, because the server pulls instead.
set -euo pipefail

REPO=bhenry245/dibs
STATE=/var/lib/dibs
mkdir -p "$STATE"

# Only one deploy at a time, even if one takes longer than a minute.
exec 9>"$STATE/lock"
flock -n 9 || exit 0

cd /opt/dibs
latest=$(git ls-remote origin refs/heads/main | cut -f1)
# Written only after a deploy succeeds, because git moves to the new commit before the build runs.
deployed=$(cat "$STATE/deployed" 2>/dev/null || true)
skipped=$(cat "$STATE/skipped" 2>/dev/null || true)

if [ "$latest" = "$deployed" ] || [ "$latest" = "$skipped" ]; then
  exit 0
fi

checks=$(curl -fsS -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$REPO/commits/$latest/check-runs?per_page=100")
decision=$(echo "$checks" | python3 /opt/dibs/deploy/check_ci.py)

case "$decision" in
  wait)
    echo "CI is still running for $latest."
    ;;
  skip)
    # Remembered, so it isn't checked again every minute. The next push gets its own chance.
    echo "$latest" > "$STATE/skipped"
    echo "Not deploying $latest, because its CI failed."
    ;;
  deploy)
    if /opt/dibs/deploy/deploy.sh "$latest"; then
      echo "$latest" > "$STATE/deployed"
    else
      # Not retried every minute, because a broken build would fail the same way each time.
      echo "$latest" > "$STATE/skipped"
      echo "Deploying $latest failed. Fix it and push again, or run deploy.sh by hand."
    fi
    ;;
esac
