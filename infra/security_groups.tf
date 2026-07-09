resource "aws_security_group" "alb" {
  name        = "escape-pod-alb"
  description = "discord-bot ALB — public HTTP/HTTPS"
  vpc_id      = aws_vpc.this.id

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # Left open even before a domain exists (the listener itself is what's
  # conditional, in alb.tf) — an open-but-unlistened port isn't a real
  # exposure.
  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description = "To ECS tasks"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "escape-pod-alb"
  }
}

resource "aws_security_group" "ecs_tasks" {
  name        = "escape-pod-ecs-tasks"
  description = "discord-bot ECS tasks — only reachable from the ALB"
  vpc_id      = aws_vpc.this.id

  ingress {
    description     = "From ALB only"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    description = "ECR pulls, CloudWatch Logs, SSM, Discord API, backend API"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "escape-pod-ecs-tasks"
  }
}
