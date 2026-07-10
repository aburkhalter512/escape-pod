output "role_arn" {
  description = "Paste into both .github/workflows/deploy-app.yml and deploy-infra.yml's role-to-assume. Not a secret — an ARN, safe to hardcode in workflow YAML."
  value       = aws_iam_role.gha_deploy.arn
}
