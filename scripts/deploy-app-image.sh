#!/usr/bin/env bash
# Updates the ECS service to run the given (already-registered) task
# definition revision. Registration happens separately, before the
# migration task runs against the same revision — see
# register-task-definition.sh and deploy-migration-task.sh — so this
# script only ever flips the service over, it doesn't register anything
# itself. See infra/ecs.tf's ignore_changes comments for why Terraform
# intentionally doesn't manage this after the first apply.
#
# Usage: deploy-app-image.sh <task-definition-arn>
set -euo pipefail

CLUSTER="escape-pod"
REGION="us-west-2"
TASK_DEF="${1:?Usage: deploy-app-image.sh <task-definition-arn>}"

aws ecs update-service --cluster "$CLUSTER" --service "$CLUSTER" --region "$REGION" \
  --task-definition "$TASK_DEF" --force-new-deployment >/dev/null

echo "Service updated to $TASK_DEF. Waiting for it to stabilize..."
aws ecs wait services-stable --cluster "$CLUSTER" --services "$CLUSTER" --region "$REGION"

echo "Deploy complete."
