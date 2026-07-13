resource "aws_ecs_cluster" "this" {
  name = "escape-pod"
}

# Terraform/OpenTofu requires this explicit association even though
# FARGATE and FARGATE_SPOT are both AWS-managed capacity providers — a
# cluster doesn't get either available to it implicitly. The service
# below sets its own capacity_provider_strategy explicitly, so no
# default_capacity_provider_strategy is needed here.
resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]
}

resource "aws_cloudwatch_log_group" "discord_bot" {
  name              = "/ecs/escape-pod"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_task_definition" "discord_bot" {
  family                   = "escape-pod"
  requires_compatibilities = ["FARGATE"]
  # Fargate only supports awsvpc networking (no bridge/host) — each task
  # gets its own ENI, which is also why the ALB target group below must
  # use target_type = "ip" rather than "instance".
  network_mode = "awsvpc"
  cpu          = var.task_cpu
  memory       = var.task_memory

  execution_role_arn = aws_iam_role.ecs_execution.arn
  # No task_role_arn — see iam.tf.

  container_definitions = jsonencode([
    {
      name  = "discord-bot"
      image = var.container_image

      portMappings = [
        { containerPort = 3000, protocol = "tcp" }
      ]

      environment = [
        { name = "PORT", value = "3000" },
        { name = "DISCORD_APPLICATION_ID", value = var.discord_application_id },
        { name = "DISCORD_PUBLIC_KEY", value = var.discord_public_key },
        { name = "PTP_BASE_URL", value = var.ptp_base_url },
      ]

      secrets = [
        { name = "DISCORD_BOT_TOKEN", valueFrom = aws_ssm_parameter.discord_bot_token.arn },
        { name = "BOT_API_KEY", valueFrom = aws_ssm_parameter.bot_api_key.arn },
        { name = "DATABASE_URL", valueFrom = aws_ssm_parameter.database_url.arn },
        { name = "TOKEN_ENCRYPTION_KEY", valueFrom = aws_ssm_parameter.token_encryption_key.arn },
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.discord_bot.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "discord-bot"
        }
      }
    }
  ])

  # After the first apply, CI (.github/workflows/deploy-app.yml,
  # scripts/deploy-app-image.sh) registers its own new task-definition
  # revisions per deploy, tagged by commit SHA — Terraform stops trying
  # to manage which image is currently running, only the shape of the
  # task definition (cpu/memory/roles/secrets/env vars). Without this,
  # every infra-only `tofu apply` would silently roll the running image
  # back to whatever `container_image` was set to at bootstrap time.
  # `container_image`/`var.container_image` therefore only matters for
  # the very first apply, before CI has ever registered a revision.
  lifecycle {
    ignore_changes = [container_definitions]
  }
}

resource "aws_ecs_service" "discord_bot" {
  name            = "escape-pod"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.discord_bot.arn
  desired_count   = var.desired_count

  # 100% Fargate Spot, not a mixed FARGATE/FARGATE_SPOT split: this is a
  # Discord interactions bot with client-side retry built in (a failed
  # interaction just shows "This interaction failed" and the user
  # retries — see server.ts's top-level catch-all), and desired_count=1
  # already means zero redundancy today, so Spot's 2-minute-reclamation
  # warning doesn't make availability meaningfully worse than the status
  # quo. base=0 is deliberate, not an oversight — with only 1 desired
  # task, giving FARGATE any base would place that single task on
  # on-demand and never touch Spot at all, defeating the point.
  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
    base              = 0
  }

  network_configuration {
    subnets = aws_subnet.public[*].id
    # Mandatory here: with no NAT gateway, a Fargate task needs a public
    # IP to reach ECR/CloudWatch/SSM at all — otherwise the image pull
    # hangs and the task never reaches RUNNING.
    security_groups  = [aws_security_group.ecs_tasks.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.discord_bot.arn
    container_name   = "discord-bot"
    container_port   = 3000
  }

  health_check_grace_period_seconds = 30

  # aws_ecs_cluster_capacity_providers.this must exist before a service
  # can reference FARGATE_SPOT in its strategy, or the API rejects it.
  depends_on = [aws_lb_listener.http, aws_ecs_cluster_capacity_providers.this]

  # SAFE-APPLY NOTE (Fargate Spot migration): switching launch_type ->
  # capacity_provider_strategy is a `-/+` replace for this resource, not
  # an in-place update — AWS provider limitation, unavoidable in config.
  # `tofu plan` will show task_definition moving from the live CI-deployed
  # revision (e.g. escape-pod:17) back to aws_ecs_task_definition.discord_bot's
  # own tracked revision (escape-pod:1, frozen at bootstrap). This was
  # verified NOT to be a problem: scripts/register-task-definition.sh
  # builds every CI revision by describe-task-definition on the *current*
  # revision and patching only containerDefinitions[0].image, so revision
  # 1 and the current live revision are identical in every field that
  # matters (env vars, secrets ARNs, cpu/memory, roles, log config,
  # ports) — confirmed by diffing `aws ecs describe-task-definition
  # --task-definition escape-pod:1` against `...:17` on 2026-07-13, only
  # the image tag differed, and container_image here uses the `:latest`
  # tag anyway so even that resolves to current code at task-launch time.
  # No tfvars/config change needed before applying this Spot switch.
  #
  # Safe apply sequence:
  #   1. tofu apply (recreates the service on revision 1 + Spot; brief
  #      downtime during replace since desired_count=1 has no redundancy)
  #   2. Immediately re-run .github/workflows/deploy-app.yml (or push a
  #      no-op commit to trigger it) so the service is repointed at a
  #      freshly-registered revision and `:latest`/SHA-tagged image again
  #      — not strictly required for correctness (revision 1 is already
  #      equivalent) but keeps the live revision number/image tag
  #      consistent with what CI expects going forward.
  #   3. Re-verify: aws ecs describe-services --cluster escape-pod
  #      --services escape-pod --query "services[0].{td:taskDefinition,cp:capacityProviderStrategy}"

  # Same reasoning as aws_ecs_task_definition.discord_bot's
  # ignore_changes above — CI points the service at its own new
  # revisions directly (aws ecs update-service --task-definition ...);
  # without ignoring this too, Terraform would see that as drift against
  # aws_ecs_task_definition.discord_bot.arn (frozen at whatever revision
  # this resource itself last created) and revert it on the next apply.
  lifecycle {
    ignore_changes = [task_definition]
  }
}
