# Date: 06NOV2026
# Author: Minkyu Jung
# Purpose: 서울 게임 서버와 접근 제어·장애 알림·월 예산 경보를 구성한다.
terraform {
  required_version = ">= 1.9, < 2.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = "ap-northeast-2"
  default_tags {
    tags = { project = var.project }
  }
}

locals {
  region           = "ap-northeast-2"
  game_server_host = var.game_server_host != "" ? var.game_server_host : "game.${var.domain}"
  allowed_origins  = var.allowed_origins != "" ? var.allowed_origins : "https://${var.domain},https://www.${var.domain}"
  # 서버 안 지표 수집기(game-server/metrics-agent.mjs)가 올리는 이름공간과 차원 값
  metrics_namespace = "SkalaFps/GameServer"
  metrics_service   = "${var.project}-game"
  secret_arn_prefix = "arn:aws:ssm:${local.region}:${data.aws_caller_identity.current.account_id}:parameter${var.secret_parameter_path}"
}

data "aws_caller_identity" "current" {}

data "aws_ssm_parameter" "ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "public" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}

resource "aws_security_group" "game" {
  name_prefix = "${var.project}-game-"
  description = "HTTPS game service; administration through SSM only"
  vpc_id      = data.aws_vpc.default.id
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_iam_role" "ssm" {
  name_prefix = "${var.project}-ssm-"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.ssm.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# 서버 안에서 쓰는 권한: 이 경로의 비밀 값 읽기와 이 이름공간의 지표 올리기만
resource "aws_iam_role_policy" "game_runtime" {
  name = "game-runtime"
  role = aws_iam_role.ssm.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadGameSecrets"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter", "ssm:GetParameters"]
        Resource = "${local.secret_arn_prefix}/*"
      },
      {
        # 기본 키(aws/ssm)로 암호화한 SecureString을 SSM을 거쳐서만 푼다
        Sid       = "DecryptThroughSsm"
        Effect    = "Allow"
        Action    = "kms:Decrypt"
        Resource  = "*"
        Condition = { StringEquals = { "kms:ViaService" = "ssm.${local.region}.amazonaws.com" } }
      },
      {
        Sid       = "PutGameMetrics"
        Effect    = "Allow"
        Action    = "cloudwatch:PutMetricData"
        Resource  = "*"
        Condition = { StringEquals = { "cloudwatch:namespace" = local.metrics_namespace } }
      }
    ]
  })
}

resource "aws_iam_instance_profile" "game" {
  name_prefix = "${var.project}-game-"
  role        = aws_iam_role.ssm.name
}

resource "aws_instance" "game" {
  ami                         = data.aws_ssm_parameter.ami.value
  instance_type               = var.instance_type
  subnet_id                   = sort(data.aws_subnets.public.ids)[0]
  associate_public_ip_address = true
  vpc_security_group_ids      = [aws_security_group.game.id]
  iam_instance_profile        = aws_iam_instance_profile.game.name
  user_data_replace_on_change = true
  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    region                 = local.region
    game_server_host       = local.game_server_host
    repo_url               = var.repo_url
    repo_ref               = var.repo_ref
    service_command        = var.service_command
    install_command        = var.install_command
    worker_count           = var.worker_count
    allowed_origins        = local.allowed_origins
    game_result_url        = var.game_result_url
    drain_max_seconds     = var.drain_max_seconds
    health_timeout_seconds = var.health_timeout_seconds
    secret_parameter_path  = var.secret_parameter_path
    secret_names           = join(" ", var.secret_names)
    metrics_namespace      = local.metrics_namespace
    metrics_service        = local.metrics_service
  })
  metadata_options {
    http_tokens = "required"
  }
  root_block_device {
    volume_type           = "gp3"
    volume_size           = 12
    encrypted             = true
    delete_on_termination = true
  }
  tags       = { Name = "${var.project}-game" }
  depends_on = [aws_iam_role_policy_attachment.ssm, aws_iam_role_policy.game_runtime]
}

resource "aws_eip" "game" {
  domain   = "vpc"
  instance = aws_instance.game.id
}

resource "aws_sns_topic" "operations" {
  name_prefix = "${var.project}-operations-"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.operations.arn
  protocol  = "email"
  endpoint  = var.budget_email
}

resource "aws_cloudwatch_metric_alarm" "cpu" {
  alarm_name          = "${var.project}-game-cpu"
  alarm_description   = "CPU above 80 percent for 10 minutes"
  namespace           = "AWS/EC2"
  metric_name         = "CPUUtilization"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "missing"
  dimensions          = { InstanceId = aws_instance.game.id }
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]
}

resource "aws_cloudwatch_metric_alarm" "status" {
  alarm_name          = "${var.project}-game-status"
  alarm_description   = "EC2 status check failure"
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "missing"
  dimensions          = { InstanceId = aws_instance.game.id }
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]
}

# 게임 지표 경보(서버 안 fps-metrics.timer가 60초마다 올리는 값)
resource "aws_cloudwatch_metric_alarm" "tick_p95" {
  alarm_name          = "${var.project}-game-tick-p95"
  alarm_description   = "Game tick p95 above ${var.tick_p95_alarm_ms} ms for 5 minutes (30 Hz budget)"
  namespace           = local.metrics_namespace
  metric_name         = "TickP95Ms"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 5
  threshold           = var.tick_p95_alarm_ms
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  dimensions          = { Service = local.metrics_service }
  alarm_actions       = [aws_sns_topic.operations.arn]
  ok_actions          = [aws_sns_topic.operations.arn]
}

resource "aws_cloudwatch_metric_alarm" "healthz" {
  alarm_name          = "${var.project}-game-healthz"
  alarm_description   = "Game server /healthz failing (or metrics agent silent) for 3 minutes"
  namespace           = local.metrics_namespace
  metric_name         = "HealthCheckOk"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  datapoints_to_alarm = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  # 값이 안 오면(서버·수집기가 죽음) 실패로 본다
  treat_missing_data = "breaching"
  dimensions         = { Service = local.metrics_service }
  alarm_actions      = [aws_sns_topic.operations.arn]
  ok_actions         = [aws_sns_topic.operations.arn]
}

resource "aws_budgets_budget" "monthly" {
  name         = "${var.project}-monthly"
  budget_type  = "COST"
  limit_amount = tostring(var.monthly_budget_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  # 계정 전체 비용을 감시하며 지원금 때문에 경보가 가려지지 않게 한다.
  cost_types {
    include_credit = false
    include_refund = false
  }
  dynamic "notification" {
    for_each = [50, 80, 100]
    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = [var.budget_email]
    }
  }
}
