variable "aws_region" {
  description = "AWS region for the IAM/OIDC resources (these are global-ish, but the provider still needs one)."
  type        = string
  default     = "us-west-2"
}
