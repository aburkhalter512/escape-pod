# Task execution role only — no task role. The app itself never calls an
# AWS API directly (it talks to Discord's REST API and to the backend's
# HTTP API, neither of which is the AWS SDK), so there's nothing for a
# task role to grant.

resource "aws_iam_role" "ecs_execution" {
  name = "escape-pod-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "ecs-tasks.amazonaws.com" }
        Action    = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Not included in the managed policy above — forgetting this is the most
# common reason a task silently fails to start. ssm:GetParameters
# (plural) is the actual API ECS calls when resolving the task
# definition's `secrets` block; kms:Decrypt is needed because
# SecureString values are encrypted.
resource "aws_iam_role_policy" "ecs_execution_ssm" {
  name = "ssm-secrets-read"
  role = aws_iam_role.ecs_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ssm:GetParameters"]
        Resource = "arn:aws:ssm:${var.aws_region}:${data.aws_caller_identity.current.account_id}:parameter/escape-pod/*"
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = "arn:aws:kms:${var.aws_region}:${data.aws_caller_identity.current.account_id}:key/*"
        Condition = {
          StringEquals = { "kms:ViaService" = "ssm.${var.aws_region}.amazonaws.com" }
        }
      }
    ]
  })
}
