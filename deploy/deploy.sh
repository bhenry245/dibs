#!/bin/bash
# Runs on the server: gets the latest code from main, writes its settings, and rebuilds and restarts
# the app. Safe to run again at any time.
set -euo pipefail

REGION=us-east-2
cd /opt/dibs

git fetch --quiet origin main
git reset --hard --quiet origin/main

setting() {
  aws ssm get-parameter --region "$REGION" --name "$1" --with-decryption \
    --query Parameter.Value --output text
}

# The Claude key is added by hand, so it might not exist yet. Without it, scanning switches off and
# everything else still works.
claude_key=$(setting /dibs/anthropic-api-key 2>/dev/null || true)
if [ -z "$claude_key" ]; then
  echo "No /dibs/anthropic-api-key yet, so receipt scanning is switched off."
fi

# Only root can read this file, because it holds the database password and the Claude key.
umask 077
cat > .env.prod <<EOF
DATABASE_URL=$(setting /dibs/database-url)
RECEIPTS_BUCKET=$(setting /dibs/receipts-bucket)
ANTHROPIC_API_KEY=$claude_key
EOF

export SITE_ADDRESS
SITE_ADDRESS=$(setting /dibs/site-address)

docker compose -f docker-compose.prod.yml up -d --build --remove-orphans
# Old images pile up with every deploy, and the server's disk is small.
docker image prune -f

echo "Deployed $(git rev-parse --short HEAD) to https://$SITE_ADDRESS"
