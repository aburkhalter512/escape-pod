variable "aws_region" {
  description = "AWS region to create the state bucket/lock table in. Should match the main config's aws_region."
  type        = string
  default     = "us-west-2"
}
