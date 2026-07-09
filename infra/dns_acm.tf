# All resources here are conditional on var.domain_name being set — see
# variables.tf.
#
# IMPORTANT: Discord's interaction endpoint URL configuration (in the
# Discord Developer Portal) requires a publicly trusted CA-signed HTTPS
# endpoint. Discord will refuse to save/verify an endpoint URL that:
#   - uses a self-signed certificate, or
#   - uses the ALB's default *.elb.amazonaws.com hostname, because ACM
#     cannot issue a certificate for a domain this AWS account doesn't
#     own.
#
# Until var.domain_name is set to a real, owned domain (and this config
# is re-applied), this stack stands up everything EXCEPT the ACM cert,
# Route53 record, and HTTPS listener. The service will be running and
# healthy over plain HTTP at the ALB's default hostname, but you cannot
# register that URL with Discord — /interactions will not receive any
# real traffic from Discord's servers until a domain is acquired and
# var.domain_name is set.

resource "aws_acm_certificate" "this" {
  count = var.domain_name != "" ? 1 : 0

  domain_name       = var.domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# for_each (not count) because domain_validation_options is a genuinely
# keyed collection — in principle more than one validation record if the
# cert ever covers additional SANs.
resource "aws_route53_record" "acm_validation" {
  for_each = var.domain_name != "" ? {
    for dvo in aws_acm_certificate.this[0].domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  } : {}

  zone_id = var.route53_zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 60
}

resource "aws_acm_certificate_validation" "this" {
  count = var.domain_name != "" ? 1 : 0

  certificate_arn         = aws_acm_certificate.this[0].arn
  validation_record_fqdns = [for r in aws_route53_record.acm_validation : r.fqdn]
}

resource "aws_route53_record" "app" {
  count = var.domain_name != "" ? 1 : 0

  zone_id = var.route53_zone_id
  name    = var.domain_name
  type    = "A"

  alias {
    name                   = aws_lb.this.dns_name
    zone_id                = aws_lb.this.zone_id
    evaluate_target_health = true
  }
}
