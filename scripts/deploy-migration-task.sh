#!/usr/bin/env bash
# Runs `prisma migrate deploy` as a one-off Fargate task using the exact
# task-definition revision passed in (must be the revision that's about
# to be deployed — see register-task-definition.sh — not just the
# family's currently-active revision, which is still the *previous*
# deploy's image and wouldn't yet have this deploy's new migration
# files). Uses the live service's network config (same VPC/security
# group so it can reach RDS), derived at runtime rather than hardcoded,
# so this doesn't go stale if subnets/security groups are ever
# recreated. Fails loudly (non-zero exit) if the migration itself
# fails — callers (CI) should not proceed to redeploy on top of a
# migration failure.
#
# Usage: deploy-migration-task.sh <task-definition-arn>
set -euo pipefail

CLUSTER="escape-pod"
REGION="us-west-2"
TASK_DEF="${1:?Usage: deploy-migration-task.sh <task-definition-arn>}"

NETWORK_CONFIG=$(aws ecs describe-services --cluster "$CLUSTER" --services "$CLUSTER" --region "$REGION" \
  --query "services[0].networkConfiguration" --output json)

TASK_ARN=$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$TASK_DEF" \
  --launch-type FARGATE \
  --region "$REGION" \
  --network-configuration "$NETWORK_CONFIG" \
  --overrides '{"containerOverrides":[{"name":"discord-bot","command":["npx","prisma","migrate","deploy"]}]}' \
  --query 'tasks[0].taskArn' --output text)

echo "Migration task started: $TASK_ARN"
echo "Waiting for it to stop..."
aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN" --region "$REGION"

EXIT_CODE=$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK_ARN" --region "$REGION" \
  --query 'tasks[0].containers[0].exitCode' --output text)

if [ "$EXIT_CODE" != "0" ]; then
  echo "Migration task failed (container exit code: $EXIT_CODE)" >&2
  echo "Logs: aws logs tail /ecs/escape-pod --region $REGION" >&2
  exit 1
fi

echo "Migration applied successfully."
