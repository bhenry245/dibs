#!/bin/bash
# The server deploys new commits by itself once their CI passes (see auto-deploy.sh). This is for
# deploying right now anyway, such as after changing a setting. Run it from the repo:
#
#   AWS_PROFILE=dibs deploy/deploy-from-laptop.sh
#
# It asks AWS to run deploy.sh on the server, through Session Manager, so there's no SSH key or open
# port. Building takes a few minutes.
set -euo pipefail

REGION=us-east-2
instance_id=$(terraform -chdir=infra output -raw server_instance_id)

command_id=$(aws ssm send-command --region "$REGION" --instance-ids "$instance_id" \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["/opt/dibs/deploy/deploy.sh"]' \
  --timeout-seconds 1800 \
  --query Command.CommandId --output text)
echo "Deploying (command $command_id). This takes a few minutes..."

aws ssm wait command-executed --region "$REGION" --command-id "$command_id" \
  --instance-id "$instance_id" || true

aws ssm get-command-invocation --region "$REGION" --command-id "$command_id" \
  --instance-id "$instance_id" \
  --query '{Status: Status, Output: StandardOutputContent, Errors: StandardErrorContent}' \
  --output text
