# escape-pod infrastructure

OpenTofu (Terraform-compatible) configuration for running escape-pod on
AWS: a VPC (no NAT gateway — cost-minimization decision, see
`network.tf`), an ECS Fargate service behind an ALB, RDS Postgres
(single-AZ `db.t4g.micro`), an ECR repo, and SSM Parameter Store for
secrets. This is the only deployed service and the only OpenTofu stack
for this product — escape-pod-backend used to be a second, independently
deployed service with its own stack (and its own ALB); the two were
merged into one process to cut that redundant fixed cost, and
escape-pod-backend's repo is now archived.

Nothing here has been applied yet — this is infrastructure-as-code
waiting for AWS credentials and a domain name.

## Prerequisites

- The [OpenTofu CLI](https://opentofu.org) (`brew install opentofu`) —
  not the same binary as `terraform`, don't mix the two against the same
  state.
- AWS credentials configured (`aws configure`, or an SSO profile) with
  permission to create the resources below.
- An image already built and pushed to the ECR repo this config creates
  — see "First apply" below for the chicken-and-egg here.

## First-time setup (two steps, in order)

### 1. Bootstrap the state backend (once, manually, local state)

```bash
cd bootstrap
tofu init
tofu apply
```

This creates an S3 bucket (versioned, encrypted, public access blocked)
and a DynamoDB table for state locking. Copy the two output values into
`../backend.tf`'s `backend "s3" {}` block (`bucket` and
`dynamodb_table`), replacing the placeholder values there.

Don't rename these later without also running `tofu init -migrate-state`
or `-reconfigure` on the main config — that's a manual, deliberate
operation, not something to do casually.

### 2. Initialize and apply the main config

```bash
cd ..   # back to infra/
tofu init
```

Supply the required variables — either export `TF_VAR_*` env vars, or
create a gitignored `terraform.auto.tfvars`:

```hcl
container_image        = "<account-id>.dkr.ecr.us-west-2.amazonaws.com/escape-pod:latest"
discord_application_id = "..."   # Discord Developer Portal
discord_public_key     = "..."   # Discord Developer Portal
discord_bot_token       = "..."  # Discord Developer Portal — secret
bot_api_key             = "..."  # protects this service's own internal HTTP API
db_password             = "..."  # generate a strong random value
token_encryption_key     = "..." # node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`container_image` has no default because the ECR repo this config
creates starts empty. **First apply will succeed at creating all the
infrastructure, but the ECS service won't have a healthy running task
until an image actually exists at that URI** — that's expected, not a
bug. Build and push one after the first apply creates the ECR repo:

```bash
docker build -t <account-id>.dkr.ecr.us-west-2.amazonaws.com/escape-pod:latest ..
aws ecr get-login-password --region us-west-2 | docker login --username AWS --password-stdin <account-id>.dkr.ecr.us-west-2.amazonaws.com
docker push <account-id>.dkr.ecr.us-west-2.amazonaws.com/escape-pod:latest
```

Then:

```bash
tofu plan
tofu apply
```

## Registering with Discord (blocked until a domain exists)

Discord requires a real, CA-signed HTTPS endpoint for the Interactions
Endpoint URL — it will not accept a self-signed cert or the ALB's
default `*.elb.amazonaws.com` hostname (see the comment block at the
top of `dns_acm.tf`). Until a domain is registered:

- This stack can still be fully applied and will run a healthy service,
  reachable over plain HTTP at `alb_dns_name` — useful for testing
  everything except the actual Discord integration.
- `/interactions` will not receive any real traffic from Discord.

Once a domain exists and its hosted zone is set up in Route53 (this
config does not create the zone itself), set `domain_name` and
`route53_zone_id` and re-apply — this adds the ACM cert (DNS-validated),
the Route53 A record, and the HTTPS listener, with no other resource
changes. Then register `tofu output alb_https_url` as the Interactions
Endpoint URL in the Discord Developer Portal.
