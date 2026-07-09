# S3 backend config — cannot reference variables (evaluated before any
# variables are available), so these values are pasted in by hand from
# bootstrap/'s outputs after running `tofu apply` there once. See README.md.
terraform {
  backend "s3" {
    bucket         = "escape-pod-tfstate-REPLACE_WITH_ACCOUNT_ID"
    key            = "discord-bot/terraform.tfstate"
    region         = "us-west-2"
    dynamodb_table = "escape-pod-tfstate-lock"
    encrypt        = true
  }
}
