# SSM Parameter Store (SecureString), not Secrets Manager — standard-tier
# parameters are free, and both are equally supported by
# aws_ecs_task_definition's `secrets` block.

resource "aws_ssm_parameter" "discord_bot_token" {
  name  = "/escape-pod/DISCORD_BOT_TOKEN"
  type  = "SecureString"
  value = var.discord_bot_token
}

resource "aws_ssm_parameter" "bot_api_key" {
  name  = "/escape-pod/BOT_API_KEY"
  type  = "SecureString"
  value = var.bot_api_key
}

resource "aws_ssm_parameter" "database_url" {
  name  = "/escape-pod/DATABASE_URL"
  type  = "SecureString"
  value = "postgresql://${var.db_username}:${urlencode(var.db_password)}@${aws_db_instance.postgres.address}:5432/${var.db_name}"
}

resource "aws_ssm_parameter" "token_encryption_key" {
  name  = "/escape-pod/TOKEN_ENCRYPTION_KEY"
  type  = "SecureString"
  value = var.token_encryption_key
}
