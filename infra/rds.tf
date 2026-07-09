# RDS requires a subnet group spanning >=2 AZs even for a single-AZ
# instance — reuses the same public subnets the ALB needs anyway.
resource "aws_db_subnet_group" "this" {
  name       = "escape-pod"
  subnet_ids = aws_subnet.public[*].id

  tags = {
    Name = "escape-pod"
  }
}

resource "aws_db_instance" "postgres" {
  identifier     = "escape-pod"
  engine         = "postgres"
  engine_version = "16.4"

  instance_class    = var.db_instance_class
  allocated_storage = var.db_allocated_storage
  storage_type      = "gp3"

  db_name  = var.db_name
  username = var.db_username
  password = var.db_password

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false

  multi_az                   = false
  auto_minor_version_upgrade = true
  backup_retention_period    = 1
  apply_immediately          = true

  # Hobby-project tradeoffs, not defaults to keep long-term: no final
  # snapshot on destroy (avoids a dangling snapshot cost/blocker) and no
  # deletion protection (minimize friction during iterative bring-up).
  skip_final_snapshot = true
  deletion_protection = false

  tags = {
    Name = "escape-pod"
  }
}
