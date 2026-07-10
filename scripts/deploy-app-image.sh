#!/usr/bin/env bash
# Registers a new escape-pod task-definition revision pointing at the
# given image (usually a commit-SHA-tagged URI from CI) and updates the
# ECS service to run it. This is what actually deploys a new image — see
# infra/ecs.tf's ignore_changes comments for why Terraform intentionally
# doesn't manage this after the first apply.
#
# Usage: deploy-app-image.sh <full-image-uri>
set -euo pipefail

CLUSTER="escape-pod"
FAMILY="escape-pod"
REGION="us-west-2"
IMAGE="${1:?Usage: deploy-app-image.sh <full-image-uri>}"

CURRENT_TASK_DEF=$(aws ecs describe-task-definition --task-definition "$FAMILY" --region "$REGION" --query "taskDefinition")

# describe-task-definition's output includes several read-only fields
# (taskDefinitionArn, revision, status, requiresAttributes,
# compatibilities, registeredAt, registeredBy) that register-task-definition
# rejects as input — picking only the valid input fields, then dropping
# any that are null (e.g. taskRoleArn, since this task has none — see
# infra/iam.tf) rather than passing them through as explicit nulls.
NEW_TASK_DEF=$(echo "$CURRENT_TASK_DEF" | jq --arg IMAGE "$IMAGE" '
  .containerDefinitions[0].image = $IMAGE
  | {family, taskRoleArn, executionRoleArn, networkMode, containerDefinitions, requiresCompatibilities, cpu, memory}
  | with_entries(select(.value != null))
')

NEW_REVISION_ARN=$(aws ecs register-task-definition --region "$REGION" --cli-input-json "$NEW_TASK_DEF" \
  --query "taskDefinition.taskDefinitionArn" --output text)

echo "Registered new task definition: $NEW_REVISION_ARN"

aws ecs update-service --cluster "$CLUSTER" --service "$CLUSTER" --region "$REGION" \
  --task-definition "$NEW_REVISION_ARN" --force-new-deployment >/dev/null

echo "Service updated to new revision. Waiting for it to stabilize..."
aws ecs wait services-stable --cluster "$CLUSTER" --services "$CLUSTER" --region "$REGION"

echo "Deploy complete."
