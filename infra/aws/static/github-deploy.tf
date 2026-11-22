# Date: 06NOV2026
# Author: Minkyu Jung
# Purpose: GitHub Actions가 비밀 키 없이(OIDC) 이 저장소 main 브랜치에서만 사이트 파일을 올리고 캐시를 비우게 한다.

# 계정마다 GitHub OIDC 공급자는 하나만 만들 수 있다. 이미 있으면 github_oidc_provider_arn에 그 ARN을 넣는다.
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.github_oidc_provider_arn == "" ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

locals {
  github_oidc_arn = var.github_oidc_provider_arn != "" ? var.github_oidc_provider_arn : aws_iam_openid_connect_provider.github[0].arn
}

resource "aws_iam_role" "deploy" {
  name_prefix          = "${var.project}-site-deploy-"
  description          = "GitHub Actions main branch of ${local.github_repo} uploads the static site"
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
          # main 브랜치 push·수동 실행만. 다른 브랜치·PR·포크·environment 작업은 거절된다.
          "token.actions.githubusercontent.com:sub" = "repo:${local.github_repo}:ref:refs/heads/main"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "deploy" {
  name = "site-deploy"
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ListSiteBucket"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = aws_s3_bucket.site.arn
      },
      {
        Sid      = "WriteSiteFiles"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.site.arn}/*"
      },
      {
        # Invalidation은 캐시 비우기, GetDistribution은 배포 전후 헤더 확인용 주소 조회(읽기 전용)
        Sid      = "InvalidateSite"
        Effect   = "Allow"
        Action   = ["cloudfront:CreateInvalidation", "cloudfront:GetDistribution"]
        Resource = aws_cloudfront_distribution.site.arn
      }
    ]
  })
}
