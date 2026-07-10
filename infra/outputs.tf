output "alb_dns_name" {
  description = "ALB's default hostname."
  value       = aws_lb.this.dns_name
}

output "alb_https_url" {
  description = "https://<domain_name>, once one is set — null otherwise. This (once non-null) is the URL to register as Discord's Interactions Endpoint URL."
  value       = var.domain_name != "" ? "https://${var.domain_name}" : null
}

output "dns_validation_record" {
  description = "CNAME to add in Cloudflare (or wherever DNS lives) to validate the ACM cert — null until domain_name is set. name/value are not secret; this is a public DNS challenge record."
  value = var.domain_name != "" ? {
    name  = tolist(aws_acm_certificate.this[0].domain_validation_options)[0].resource_record_name
    type  = tolist(aws_acm_certificate.this[0].domain_validation_options)[0].resource_record_type
    value = tolist(aws_acm_certificate.this[0].domain_validation_options)[0].resource_record_value
  } : null
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

output "rds_endpoint" {
  description = "Hostname:port — not a credential, safe to output plainly."
  value       = aws_db_instance.postgres.endpoint
}
