# SSM Parameter Store (SecureString), not Secrets Manager — same
# reasoning as escape-pod-backend/infra/secrets.tf: standard-tier
# parameters are free, and both are equally supported by
# aws_ecs_task_definition's `secrets` block.

resource "aws_ssm_parameter" "discord_bot_token" {
  name  = "/escape-pod/DISCORD_BOT_TOKEN"
  type  = "SecureString"
  value = var.discord_bot_token
}

resource "aws_ssm_parameter" "backend_api_key" {
  name  = "/escape-pod/BACKEND_API_KEY"
  type  = "SecureString"
  value = var.backend_api_key
}
