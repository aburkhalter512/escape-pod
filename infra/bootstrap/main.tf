# Bootstraps the S3 bucket + DynamoDB table that ../ (the main config)
# uses as its remote state backend. This has to be a separate config with
# its own local state — the main config can't use an S3 backend that
# doesn't exist yet. Apply this once, by hand, before ever running `tofu
# init` in ../. See ../README.md for the full two-step process.
#
# Fully independent from escape-pod-backend's bootstrap — no shared
# state, no shared bucket, per the project's per-repo infra ownership
# decision.

terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}

locals {
  # Deterministic, not random — reproducible without stashing extra
  # state, and S3 bucket names must be globally unique so the account id
  # is what actually guarantees that.
  bucket_name = "escape-pod-tfstate-${data.aws_caller_identity.current.account_id}"
  table_name  = "escape-pod-tfstate-lock"
}

resource "aws_s3_bucket" "tf_state" {
  bucket = local.bucket_name
}

resource "aws_s3_bucket_versioning" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tf_state" {
  bucket = aws_s3_bucket.tf_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_dynamodb_table" "tf_lock" {
  name         = local.table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }
}
