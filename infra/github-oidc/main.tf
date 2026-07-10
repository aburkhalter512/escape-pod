# Lets GitHub Actions workflow runs in aburkhalter512/escape-pod assume
# an AWS role using short-lived OIDC tokens instead of stored access
# keys — see ../README.md's "CI/CD" section. Same chicken-and-egg shape
# as ../bootstrap/: the role CI needs to exist can't be created *by* CI's
# own first run, so this is a separate config with its own local state,
# applied once, by hand.
#
# Only one OIDC provider for a given URL is allowed per AWS account —
# checked via `aws iam list-open-id-connect-providers` before first
# apply; none existed on this account as of this config's creation.

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

# GitHub's own published OIDC thumbprint — see
# https://github.blog/changelog/2023-06-27-github-actions-update-on-oidc-integration-with-aws/
# (GitHub's intermediate CA is now covered by Amazon's own trusted root
# store, but the provider resource still requires a thumbprint value;
# this is the documented placeholder AWS itself recommends).
resource "aws_iam_openid_connect_provider" "github" {
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["ffffffffffffffffffffffffffffffffffffffff"]
}

# AdministratorAccess, same as the escape-pod-deploy IAM user used for
# manual applies — a hand-scoped policy is a maintenance trap for a
# hobby project whose `tofu apply` needs to touch nearly every AWS
# resource type (see infra/README.md's earlier reasoning for the human
# user). What actually restricts this role is the trust policy below,
# not its permissions: only workflow runs from this specific repo can
# assume it at all.
resource "aws_iam_role" "gha_deploy" {
  name = "escape-pod-gha-deploy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Federated = aws_iam_openid_connect_provider.github.arn }
        Action    = "sts:AssumeRoleWithWebIdentity"
        Condition = {
          StringEquals = {
            "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          }
          # Two patterns: `ref:refs/heads/main` covers deploy-app.yml
          # (workflow_run, always tied to main) and deploy-infra.yml's
          # apply job (push to main); `pull_request` covers
          # deploy-infra.yml's plan job on PRs touching infra/**.
          StringLike = {
            "token.actions.githubusercontent.com:sub" = [
              "repo:aburkhalter512/escape-pod:ref:refs/heads/main",
              "repo:aburkhalter512/escape-pod:pull_request",
            ]
          }
        }
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "gha_deploy_admin" {
  role       = aws_iam_role.gha_deploy.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}
