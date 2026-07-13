# escape-pod AWS cost analysis

Snapshot as of 2026-07-13, checked against live resource state (not just
the `.tf` files — `infra/README.md` currently claims "nothing has been
applied yet," which is stale; there's a running stack). All commands used
were read-only (`describe-*`/`list-*`/`get-*`); nothing here changed any
AWS resource.

Cost Explorer isn't enabled for this account/IAM user
(`GetCostAndUsage` → `AccessDeniedException`), so there's no billed-dollar
ground truth to check against. Every cost figure below is **computed from
current us-west-2 on-demand list pricing against actual live resource
specs and CloudWatch usage data** — not real billing data. Labeled as
such throughout.

## 1. Architecture summary (live state, not just declared state)

| Resource | Live config |
|---|---|
| ECS cluster | `escape-pod`, Fargate launch type, no capacity provider strategy (no Spot) |
| ECS service | `desired_count=1`, task def `escape-pod:17`, task CPU 256 (0.25 vCPU) / memory 512 MiB, `runtimePlatform` unset → default `LINUX/X86_64` (not Graviton/ARM) |
| ALB | 1x `application`, internet-facing, spans 2 AZs (`us-west-2a`/`us-west-2b`), 1 target group, HTTP:80 + HTTPS:443 listeners both live (cert issued for `escape-pod.api.form-viii.com`) |
| RDS | `db.t4g.micro`, Postgres 16.14, single-AZ, 20 GB gp3 (3000 IOPS / 125 MBps baseline, not provisioned above defaults), `backup_retention_period=1`, `publiclyAccessible=false` |
| VPC / networking | 1 VPC, 2 public subnets, no private subnets, **no NAT gateway**, no VPC endpoints. Fargate tasks get `assign_public_ip=true` and reach ECR/CloudWatch/SSM over the IGW directly |
| ECR | 1 repo (`escape-pod-discord-bot`), lifecycle policy active (expire untagged >7d, keep last 10 tagged) — currently 15 images, ~1.66 GB total |
| CloudWatch Logs | 1 log group (`/ecs/escape-pod`), `retention_in_days=14` (not unbounded — checked specifically per the brief, this one's fine), ~5.1 MB currently stored |
| IAM | Execution role only, no task role (app never calls AWS APIs directly) |
| Secrets | SSM Parameter Store, `SecureString`, standard tier — **free** at this scale (checked, ruled out as a cost line; Parameter Store standard tier has no per-parameter charge, only Advanced tier does) |
| DNS/ACM | No Route53 zone (DNS stays on Cloudflare); 1 ACM cert, DNS-validated, free (ACM certs used with ALB cost nothing) |
| State backend | 1 S3 bucket + 1 DynamoDB table (`bootstrap/`), both trivially small/low-traffic |

Traffic reality check (CloudWatch, last several days): ALB
`RequestCount` runs **~850–1,800 requests/day** — that's ALB health
checks (30s interval × 2 target-group members' worth of polling) plus a
handful of real Discord interactions, not meaningful load. ECS service
`CPUUtilization` averages **0.06–0.2%** with brief spikes to 20–48%
(visible only during deploys/migrations), and `MemoryUtilization`
averages **8–11%** of the 512 MiB allocation. This is about as far from
"undersized" as a workload gets — see the right-sizing recommendation
below.

Two things worth explicitly noting as *not* problems:
- The two Elastic IPs visible in `describe-addresses` are the ALB's own
  per-AZ public IPs (`amazon-elb`-owned ENIs), not a leftover NAT gateway
  or an idle/unattached EIP that would incur the still-relatively-new
  hourly idle-EIP charge. Confirmed via `describe-network-interfaces`.
- Seeing 2 running tasks in `describe-tasks` briefly (against
  `desired_count=1`) was an in-flight rolling deployment (rev 16 draining
  while rev 17 came up), not steady-state drift — `deployments[]` showed
  the old revision at `desired=0` mid-rollout. Steady state is 1 task.

Nothing here looks *undersized* for the stated audience ("a handful of
sister communities"). Multiple things look larger than necessary — see
below.

## 2. Monthly cost estimate

All lines computed from list pricing (us-west-2, on-demand), not billed
data, unless noted.

| Item | Basis | Monthly cost (computed) |
|---|---|---|
| Fargate task (0.25 vCPU / 0.5 GB, 24/7, 730 hrs) | $0.04048/vCPU-hr + $0.004445/GB-hr, X86_64 | **$9.01** |
| ALB | $0.0225/hr base + LCU-hours (traffic is trivial, well under 1 LCU sustained) | **~$16.70** |
| RDS `db.t4g.micro`, single-AZ | $0.016/hr | **$11.68** |
| RDS gp3 storage, 20 GB | $0.115/GB-mo, no extra IOPS/throughput purchased | **$2.30** |
| RDS automated backups | 1-day retention, backup storage ≤ allocated storage → within the free-equal-to-DB-size allowance | **~$0** |
| ECR storage | ~1.66 GB across 15 images, $0.10/GB-mo | **$0.17** |
| CloudWatch Logs | 14-day retention, ~5 MB stored, ingestion volume low (chatty-logger risk checked — not present) | **< $0.50** |
| Data transfer out | Tiny interaction payloads + health checks, nowhere near the 100 GB/mo free tier | **~$0** |
| NAT Gateway | **Not provisioned** (see network.tf) | **$0** |
| VPC endpoints | **Not provisioned** | **$0** |
| SSM Parameter Store (SecureString, standard tier) | 4 parameters, standard tier | **$0** (checked, free) |
| ACM certificate | Used with ALB | **$0** (checked, free) |
| Route53 | Not used — DNS stays on Cloudflare | **$0** |
| S3 (tfstate bucket) + DynamoDB (lock table) | Versioned bucket, tiny state file; on-demand DynamoDB, near-zero request volume | **< $0.10** |

**Total: approximately $40–41/month.**

For context on where that goes: ALB (~$16.70) and RDS
(~$14) together are ~75% of the bill, dwarfing the actual compute
running the bot (~$9). That's the expected shape for a workload this
small — the fixed/base costs of "always-on managed service" dominate
once actual usage is negligible, and neither the ALB nor the RDS
instance can bill less than their respective hourly base rate no matter
how idle they sit.

## 3. Cost-reduction proposal

Ordered by estimated impact. None of these are free — each has a
tradeoff called out explicitly, consistent with this being a
hobby-scale, retry-tolerant Discord bot, not a service with an SLA.

### 1. Right-size the Fargate task down (or don't — it's already about as cheap as Fargate gets)

CPU averages 0.06–0.2%, memory 8–11% of 512 MiB. Fargate's minimum task
size is 0.25 vCPU / 512 MiB (256/512 — exactly what's configured), so
**there's no smaller task to move to**; this is already the floor.

- **Estimated savings: $0.** Included here because it was explicitly
  worth checking, not to recommend action. The one real option to shrink
  this further would be swapping Fargate for something with a lower
  floor (e.g. a single small EC2 instance, or Fargate on a shared/EC2
  capacity provider) — not worth the operational complexity added for
  ~$9/mo of compute.
- If memory crept toward the ceiling later (it's currently nowhere close
  at 11%), bumping to 1024 MiB (still 256 CPU) is the next tier
  and would roughly double the memory line to ~$3.24/mo — not a concern
  now.

### 2. Fargate Spot for the service task

This is a Discord bot serving `/interactions` — Discord retries failed
webhook deliveries, and a brief task interruption during Spot reclamation
(ECS gets a 2-minute warning) is very likely tolerable for this
workload's retry-friendly, non-latency-critical nature. `desired_count=1`
means no redundancy either way today; Spot doesn't make availability
meaningfully worse than the status quo (a single on-demand task is
already a single point of failure — Spot just adds a low-probability
reclamation on top of the existing "any deploy/AZ event drops the only
task" risk).

- **Estimated savings: ~$5.50–6.50/mo** (Fargate Spot runs roughly
  30–40% cheaper than published — that's the highest-percentage cut
  available here, though the smallest in absolute dollars).
- **Tradeoff:** occasional task interruption (2-min warning, ECS
  reschedules automatically); slightly less predictable capacity during
  regional Spot capacity crunches, though at this size (single 0.25 vCPU
  task) reclamation risk is low in practice. Requires switching
  `launch_type = "FARGATE"` to a capacity provider strategy
  (`FARGATE_SPOT`, weight 100) in `ecs.tf`. Given the dollar amount, this
  is a "nice to have," not the priority — see #3 and #4 below for the
  real money.

### 3. Drop the ALB, use a Network Load Balancer or (more realistically) reconsider whether an ALB-grade ingress is needed at all

The ALB is ~40% of the total bill (~$16.70/mo) for a service that:
routes to exactly one target group, does no path-based/host-based
routing, no WAF, no advanced request-based logic — the only thing it's
actually providing is (a) HTTP→one-target-group forwarding and (b) being
the thing ACM attaches a real cert to for Discord's CA-signed-HTTPS
requirement (verified in `dns_acm.tf` — this is a hard Discord
requirement, not a nice-to-have, so **removing HTTPS entirely is off the
table**).

Realistic options, in order of how much they actually save:

- **Keep the ALB.** At this scale an ALB is the standard, low-effort way
  to get a stable HTTPS endpoint with a real cert in front of Fargate,
  and $16.70/mo buys a well-understood, zero-maintenance component. This
  is the pragmatic default — flagging the alternative below mainly so
  it's clear it was considered, not missed.
- **Replace with a Fargate task that terminates TLS itself** (cert
  materials pulled from ACM/SSM, or something like Caddy as a sidecar
  doing auto-HTTPS via Let's Encrypt) sitting behind just a public IP —
  no load balancer at all. This removes the ALB's ~$16.70/mo entirely,
  but trades it for: no automatic target health-check/failover (moot at
  `desired_count=1`, but matters if that ever changes), the app or a
  sidecar now owns cert renewal/rotation (an operational burden this repo
  currently pays AWS $16.70/mo to not have), and the task's public IP
  changes on every redeploy (need a DNS update step, or move to a static
  EIP attached to the task's ENI — awkward with Fargate's per-task ENIs
  and `assign_public_ip=true`). **Not recommended** — the operational
  complexity this introduces (cert lifecycle management, losing managed
  health-check-driven routing) isn't worth ~$16/mo for a hobby project;
  this is the kind of cost that's worth paying to not think about.
- **Estimated savings if pursued: ~$16.70/mo**, but this is the
  highest-risk/highest-effort item on this list relative to its payoff,
  and actively works against the project's own stated
  cost-vs-complexity tradeoffs elsewhere (e.g. keeping SSM over Secrets
  Manager specifically to stay simple/free). Listed for completeness,
  not recommended as a next action.

### 4. RDS: right-sized already, but backup retention and Multi-AZ are worth confirming as intentional (they already look correct)

`db.t4g.micro`, single-AZ, 20 GB gp3, 1-day backup retention — this
is already about as lean as RDS gets while remaining RDS (vs. moving off
managed Postgres entirely). Multi-AZ is **not** enabled, which is
correct for this scale: Multi-AZ would roughly double the instance line
(~+$11.68/mo) for a database serving a bot with no uptime SLA and a
single upstream Fargate task that's itself a single point of failure —
paying for RDS failover redundancy while the compute tier has none would
be inconsistent, not defensible.

- **No change recommended.** Included to confirm this was checked, not
  overlooked: Multi-AZ absence is a deliberate correct call already
  encoded in `rds.tf`, and 1-day backup retention (the RDS minimum) is
  reasonable for a hobby project's risk tolerance. If backup retention
  were bumped to the more typical 7 days, cost impact would be
  negligible (still well within the "backup storage ≤ DB size is free"
  allowance at 20 GB) — a low-cost, low-risk change worth considering
  purely for restore flexibility, not for cost reasons.

### 5. Everything else — already correctly minimized, no action

- **No NAT Gateway.** Explicitly and correctly avoided per
  `network.tf`'s own comments — this is normally the single biggest
  avoidable line item for small apps (~$32-33/mo base + per-GB
  processing), and it's already not present here. Public-subnet Fargate
  tasks + security-group-chain isolation (`security_groups.tf`) is the
  right call at this scale.
- **CloudWatch Logs retention** is capped at 14 days (not unbounded) —
  checked specifically per this analysis's brief, already fine.
- **ECR lifecycle policy** is active and reasonable (7-day untagged
  expiry, keep-last-10 tagged) — already fine, no unbounded image
  accumulation.
- **SSM Parameter Store standard tier** — free, already the cheaper
  choice over Secrets Manager (which would run ~$0.40/secret/mo × 4 ≈
  $1.60/mo for no functional benefit here).

## Bottom line

| | Monthly |
|---|---|
| Current computed estimate | **~$40–41** |
| If Fargate Spot adopted (#2) | **~$34–35** |
| If ALB also removed (#3, not recommended) | **~$18** |

Realistic near-term action: adopt Fargate Spot (#2) for ~$6/mo at low
risk given the workload's retry tolerance and existing lack of
redundancy. Leave the ALB and RDS configuration as-is — both are already
sized correctly for this app's actual traffic, and the remaining
"savings" available by cutting further would trade real operational
complexity for single-digit dollars.
