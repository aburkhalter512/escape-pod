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

variable "ptp_base_url" {
  description = "Protect the Pod base URL. Not secret."
  type        = string
  default     = "https://www.protectthepod.com"
}

variable "db_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "RDS allocated storage, in GB."
  type        = number
  default     = 20
}

variable "db_name" {
  description = "Postgres database name."
  type        = string
  default     = "draft_pod"
}

variable "db_username" {
  description = "Postgres master username. Not secret by itself (the password is what's sensitive), but kept as a variable alongside it for symmetry."
  type        = string
  default     = "postgres"
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

variable "bot_api_key" {
  description = "Shared secret protecting this service's own internal HTTP API (/organizers/*, /guilds/*, /pods/*) — nothing external calls it now that Discord interaction handlers call the same logic in-process, but it's kept as a bearer-protected debug/admin surface."
  type        = string
  sensitive   = true
}

variable "db_password" {
  description = "RDS master password."
  type        = string
  sensitive   = true
}

variable "token_encryption_key" {
  description = "AES-256-GCM key (32-byte hex) for encrypting PTP tokens at rest. Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
  type        = string
  sensitive   = true
}
