# --- non-secret, sensible defaults ---

variable "aws_region" {
  description = "AWS region for all resources."
  type        = string
  default     = "us-west-2"
}

variable "domain_name" {
  description = <<-EOT
    Custom domain for the ALB (e.g. "bot.example.com"). Leave empty (the
    default) until a domain is actually registered — when empty, this
    config skips creating the ACM cert, Route53 record, and HTTPS
    listener entirely. UNLIKE the backend, this isn't just a nice-to-have
    here: Discord will not accept this service's /interactions endpoint
    until it's served over a real, CA-signed HTTPS URL (no self-signed
    certs, and no AWS default *.elb.amazonaws.com hostname — ACM can't
    issue a cert for a domain this account doesn't own). Until
    domain_name is set and this is re-applied, the service runs and is
    healthy, but cannot actually receive traffic from Discord.
  EOT
  type        = string
  default     = ""
}

variable "route53_zone_id" {
  description = "Hosted zone ID to create the domain_name record in. Required only when domain_name is set; this config does not create the zone itself (the domain's registrar NS records must already be delegated to it)."
  type        = string
  default     = ""
}

variable "backend_url" {
  description = <<-EOT
    escape-pod-backend's URL — that stack's `alb_dns_name` output
    (http://..., or its alb_https_url once it has a domain), copied by
    hand. No cross-repo Terraform remote-state data source by design
    (per-repo infra ownership) — the backend stack must be applied
    first, then its output fed in here. No default; this is a required
    manual step, not an oversight.
  EOT
  type        = string
}

variable "container_image" {
  description = "Full ECR image URI+tag to deploy, e.g. \"<account>.dkr.ecr.<region>.amazonaws.com/escape-pod:latest\". No default — the ECR repo this config creates starts empty; build and push an image before the ECS service can run one."
  type        = string
}

variable "task_cpu" {
  description = "Fargate task CPU units (256 = 0.25 vCPU)."
  type        = number
  default     = 256
}

variable "task_memory" {
  description = "Fargate task memory in MiB."
  type        = number
  default     = 512
}

variable "desired_count" {
  description = "Number of running tasks."
  type        = number
  default     = 1
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for the ECS task's log group."
  type        = number
  default     = 14
}

variable "discord_application_id" {
  description = "Discord application ID (Developer Portal). Not secret."
  type        = string
}

variable "discord_public_key" {
  description = "Discord app's Ed25519 public key, used to verify interaction signatures. Not secret."
  type        = string
}

# --- secrets: no defaults, supplied via TF_VAR_* env vars or a gitignored
# *.auto.tfvars at apply time, never hardcoded or committed ---

variable "discord_bot_token" {
  description = "Discord bot token (Developer Portal)."
  type        = string
  sensitive   = true
}

variable "backend_api_key" {
  description = "Shared secret this service authenticates to the backend with. Must match the bot_api_key value supplied to escape-pod-backend's infra apply."
  type        = string
  sensitive   = true
}
