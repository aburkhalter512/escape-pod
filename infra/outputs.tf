output "alb_dns_name" {
  description = "ALB's default hostname."
  value       = aws_lb.this.dns_name
}

output "alb_https_url" {
  description = "https://<domain_name>, once one is set — null otherwise. This (once non-null) is the URL to register as Discord's Interactions Endpoint URL."
  value       = var.domain_name != "" ? "https://${var.domain_name}" : null
}

output "ecr_repository_url" {
  value = aws_ecr_repository.discord_bot.repository_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "ecs_service_name" {
  value = aws_ecs_service.discord_bot.name
}
