# discord-bot infrastructure

OpenTofu (Terraform-compatible) configuration for running escape-pod
(discord-bot) on AWS: a VPC (no NAT gateway — cost-minimization decision,
see `network.tf`), an ECS Fargate service behind an ALB, an ECR repo,
and SSM Parameter Store for secrets. Fully independent from
escape-pod-backend's own `infra/` — no shared VPC, no shared ECS
cluster, no cross-repo Terraform state.

Nothing here has been applied yet — this is infrastructure-as-code
waiting for AWS credentials and a domain name.

## Prerequisites

- The [OpenTofu CLI](https://opentofu.org) (`brew install opentofu`) —
  not the same binary as `terraform`, don't mix the two against the same
  state.
- AWS credentials configured (`aws configure`, or an SSO profile) with
  permission to create the resources below.
- **escape-pod-backend's `infra/` applied first** — this config needs
  its `alb_dns_name` output as `backend_url` (see below).

## First-time setup (in order)

### 1. Apply escape-pod-backend's infra first

See `escape-pod-backend/infra/README.md`. Capture its `alb_dns_name`
output (or `alb_https_url`, once it has a domain) — needed in step 3.

### 2. Bootstrap the state backend (once, manually, local state)

```bash
cd bootstrap
tofu init
tofu apply
```

Copy the two output values into `../backend.tf`'s `backend "s3" {}`
block (`bucket` and `dynamodb_table`), replacing the placeholder values
there.

### 3. Initialize and apply the main config

```bash
cd ..   # back to infra/
tofu init
```

Supply the required variables — either export `TF_VAR_*` env vars, or
create a gitignored `terraform.auto.tfvars`:

```hcl
container_image        = "<account-id>.dkr.ecr.us-east-1.amazonaws.com/escape-pod-discord-bot:latest"
backend_url             = "http://<escape-pod-backend's alb_dns_name output>"
discord_application_id = "..."   # Discord Developer Portal
discord_public_key     = "..."   # Discord Developer Portal
discord_bot_token       = "..."  # Discord Developer Portal — secret
backend_api_key         = "..."  # shared secret — must match backend's bot_api_key
```

`container_image` has no default because the ECR repo this config
creates starts empty. **First apply will succeed at creating all the
infrastructure, but the ECS service won't have a healthy running task
until an image actually exists at that URI** — that's expected, not a
bug. Build and push one after the first apply creates the ECR repo:

```bash
docker build -t <account-id>.dkr.ecr.us-east-1.amazonaws.com/escape-pod-discord-bot:latest ..
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin <account-id>.dkr.ecr.us-east-1.amazonaws.com
docker push <account-id>.dkr.ecr.us-east-1.amazonaws.com/escape-pod-discord-bot:latest
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
the Route53 A record, and the HTTPS listener. Then register
`tofu output alb_https_url` as the Interactions Endpoint URL in the
Discord Developer Portal.

## Note on the shared secret

`backend_api_key` here and `bot_api_key` in escape-pod-backend's infra
must be the *same* value — generate it once, supply it to both applies.
There's no automatic sync between the two independent stacks by design.
