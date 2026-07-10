# All resources here are conditional on var.domain_name being set — see
# variables.tf.
#
# IMPORTANT: Discord's interaction endpoint URL configuration (in the
# Discord Developer Portal) requires a publicly trusted CA-signed HTTPS
# endpoint. Discord will refuse to save/verify an endpoint URL that:
#   - uses a self-signed certificate, or
#   - uses the ALB's default *.elb.amazonaws.com hostname, because ACM
#     cannot issue a certificate for a domain this AWS account doesn't own.
#
# This domain's DNS is hosted on Cloudflare, not Route53 — deliberately, to
# avoid a nameserver migration. That means this config does NOT create any
# DNS records itself (no Route53 zone exists to create them in): both the
# ACM validation CNAME and the domain's own record pointing at the ALB have
# to be added by hand in Cloudflare. See the dns_validation_record and
# alb_dns_name outputs, and infra/README.md's "Adding HTTPS" section for
# the two-step apply this requires (cert requested first, validated once
# the CNAME is live, in a second apply).

resource "aws_acm_certificate" "this" {
  count = var.domain_name != "" ? 1 : 0

  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# Polls ACM until the certificate is issued — succeeds as soon as ACM can
# resolve the validation CNAME wherever it's actually hosted (Cloudflare),
# with no dependency on any Route53 record existing. Will time out (default
# 45m) if the CNAME hasn't been added in Cloudflare yet — see README.
resource "aws_acm_certificate_validation" "this" {
  count = var.domain_name != "" ? 1 : 0

  certificate_arn = aws_acm_certificate.this[0].arn
  validation_record_fqdns = [
    for dvo in aws_acm_certificate.this[0].domain_validation_options : dvo.resource_record_name
  ]
}
