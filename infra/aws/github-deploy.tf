# Date: 06NOV2026
# Author: Minkyu Jung
# Purpose: GitHub Actions가 비밀 키 없이(OIDC) 이 저장소의 game-server-v* 태그에서만 게임 서버 배포 문서 하나를 이 서버에 실행하게 한다.

# 계정마다 GitHub OIDC 공급자는 하나만 만들 수 있다. infra/aws/static에서 이미 만들었으면 github_oidc_provider_arn에 그 ARN을 넣는다.
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.github_oidc_provider_arn == "" ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

locals {
  github_oidc_arn = var.github_oidc_provider_arn != "" ? var.github_oidc_provider_arn : aws_iam_openid_connect_provider.github[0].arn
  instance_arn    = "arn:aws:ec2:${local.region}:${data.aws_caller_identity.current.account_id}:instance/${aws_instance.game.id}"
}

# 서버 안에서 할 일을 고정한 배포 문서. 받는 값은 태그 이름 하나이고 형식을 SSM이 먼저 검사한다(셸 기호가 들어갈 수 없다)
resource "aws_ssm_document" "deploy" {
  name            = "${var.project}-game-deploy"
  document_type   = "Command"
  document_format = "JSON"
  content = jsonencode({
    schemaVersion = "2.2"
    description   = "Deploy one game-server-v* tag: fetch, start new workers, wait for /healthz, switch Caddy, drain old workers"
    parameters = {
      tag = {
        type           = "String"
        description    = "Release tag, for example game-server-v1.0.0"
        allowedPattern = "^game-server-v[0-9A-Za-z._-]{1,64}$"
      }
    }
    mainSteps = [{
      action = "aws:runShellScript"
      name   = "deploy"
      inputs = {
        timeoutSeconds = "900"
        runCommand = [
          "set -euo pipefail",
          "export PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin HOME=/root",
          "tag='{{ tag }}'",
          "git -C /opt/fps/src fetch --quiet --force origin \"+refs/tags/$tag:refs/tags/$tag\"",
          "sha=$(git -C /opt/fps/src rev-parse --verify \"refs/tags/$tag^{commit}\")",
          "git -C /opt/fps/src -c advice.detachedHead=false checkout --quiet --force --detach \"$sha\"",
          "bash /opt/fps/src/infra/aws/game-server/deploy.sh \"$sha\" \"$tag\""
        ]
      }
    }]
  })
}

resource "aws_iam_role" "game_deploy" {
  name_prefix          = "${var.project}-game-deploy-"
  description          = "GitHub Actions game-server-v* tags of ${var.github_repository} run the game deploy document"
  max_session_duration = 3600
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = local.github_oidc_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        # 이 저장소의 game-server-v* 태그 작업만. 브랜치·PR·포크·environment 작업은 거절된다
        StringLike = {
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repository}:ref:refs/tags/game-server-v*"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "game_deploy" {
  name = "game-deploy"
  role = aws_iam_role.game_deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # 이 서버에 이 배포 문서만 보낼 수 있다(AWS-RunShellScript 같은 임의 명령 문서는 안 된다)
        Sid      = "SendDeployCommand"
        Effect   = "Allow"
        Action   = "ssm:SendCommand"
        Resource = [local.instance_arn, aws_ssm_document.deploy.arn]
      },
      {
        # 명령 결과 읽기. 이 동작들은 자원 단위 제한을 받지 않아 "*"다(읽기 전용)
        Sid      = "ReadCommandResults"
        Effect   = "Allow"
        Action   = ["ssm:GetCommandInvocation", "ssm:ListCommandInvocations", "ssm:ListCommands"]
        Resource = "*"
      }
    ]
  })
}
