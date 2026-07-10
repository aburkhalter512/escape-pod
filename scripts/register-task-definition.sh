#!/usr/bin/env bash
# Registers a new escape-pod task-definition revision pointing at the
# given image and prints its ARN (stdout only — callers capture it via
# $(...)). Split out from what used to be deploy-app-image.sh so the
# same freshly-registered revision can be used both for the migration
# task and the service update, rather than each step picking up
# whatever revision happens to be active at the time (see
# deploy-migration-task.sh's comment for why that was a bug: it let
# migrations run against the *previous* deploy's image).
#
# Usage: register-task-definition.sh <full-image-uri>
set -euo pipefail

FAMILY="escape-pod"
REGION="us-west-2"
IMAGE="${1:?Usage: register-task-definition.sh <full-image-uri>}"

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

aws ecs register-task-definition --region "$REGION" --cli-input-json "$NEW_TASK_DEF" \
  --query "taskDefinition.taskDefinitionArn" --output text
