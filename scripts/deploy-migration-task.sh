#!/usr/bin/env bash
# Runs `prisma migrate deploy` as a one-off Fargate task using the
# current escape-pod task definition (same image, same VPC/security
# group so it can reach RDS) and the exact network config the live ECS
# service uses — derived at runtime rather than hardcoded, so this
# doesn't go stale if subnets/security groups are ever recreated. Fails
# loudly (non-zero exit) if the migration itself fails — callers (CI)
# should not proceed to redeploy on top of a migration failure.
set -euo pipefail

CLUSTER="escape-pod"
REGION="us-west-2"

NETWORK_CONFIG=$(aws ecs describe-services --cluster "$CLUSTER" --services "$CLUSTER" --region "$REGION" \
  --query "services[0].networkConfiguration" --output json)

TASK_ARN=$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$CLUSTER" \
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
