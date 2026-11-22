# Date: 06NOV2026
# Author: Minkyu Jung
# Purpose: 게임 정적 파일을 비공개 S3와 CloudFront(OAC)로 제공하고 _headers의 보안 헤더를 그대로 붙인다.
#          게임 서버(infra/aws)와 상태를 나눠, 서버를 철거해도 사이트가 지워지지 않게 한다.
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
    tags = { project = var.project, part = "static-site" }
  }
}

# CloudFront 인증서(ACM)는 반드시 버지니아 북부(us-east-1)에 있어야 한다.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
  default_tags {
    tags = { project = var.project, part = "static-site" }
  }
}

locals {
  # 보안 헤더는 저장소 루트의 _headers에서 읽는다. 값을 여기 따로 적지 않아 어긋날 수 없다.
  # _headers를 고치면(도메인 이전·importmap 해시) 이 폴더에서 다시 apply한다(docs/AWS_STATIC_SOP.md).
  headers_file       = file("${path.module}/../../../_headers")
  csp                = trimspace(regex("Content-Security-Policy: ([^\r\n]+)", local.headers_file)[0])
  referrer_policy    = trimspace(regex("Referrer-Policy: ([^\r\n]+)", local.headers_file)[0])
  permissions_policy = trimspace(regex("Permissions-Policy: ([^\r\n]+)", local.headers_file)[0])
  # _headers에서 1년 immutable인 경로. tests/aws-static.test.mjs가 _headers와 같은지 확인한다.
  immutable_paths = ["/fonts/*", "/assets/models/*", "/audio/*"]

  site_domain   = var.site_domain
  use_domain    = local.site_domain != "" && var.attach_site_domain
  github_repo   = var.github_repository != "" ? var.github_repository : regex("^https://github\\.com/([^/]+/[^/]+?)(?:\\.git)?$", var.repo_url)[0]
  s3_origin_id  = "site-s3"
  site_hostname = local.use_domain ? local.site_domain : aws_cloudfront_distribution.site.domain_name
}

# ---------------- S3: 공개 접근 전부 막음, 버전 보관 ----------------

resource "aws_s3_bucket" "site" {
  bucket_prefix = "${var.project}-site-"
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "site" {
  bucket = aws_s3_bucket.site.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "site" {
  bucket = aws_s3_bucket.site.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  bucket = aws_s3_bucket.site.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# 덮어쓴 옛 버전은 되돌리기용으로 잠시 두고 지워 저장 비용이 쌓이지 않게 한다.
resource "aws_s3_bucket_lifecycle_configuration" "site" {
  bucket = aws_s3_bucket.site.id
  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = var.old_version_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
  depends_on = [aws_s3_bucket_versioning.site]
}

# CloudFront(이 배포 하나)만 파일을 읽을 수 있다.
resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "CloudFrontRead"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.site.arn}/*"
      Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.site.arn } }
    }]
  })
  depends_on = [aws_s3_bucket_public_access_block.site]
}

# ---------------- 인증서: site_domain을 넣을 때만 ----------------

resource "aws_acm_certificate" "site" {
  count             = local.site_domain != "" ? 1 : 0
  provider          = aws.us_east_1
  domain_name       = local.site_domain
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

# 소유자가 Cloudflare에 검증 CNAME을 넣은 뒤 attach_site_domain=true로 apply하면 발급을 기다린다.
resource "aws_acm_certificate_validation" "site" {
  count           = local.use_domain ? 1 : 0
  provider        = aws.us_east_1
  certificate_arn = aws_acm_certificate.site[0].arn
}

# ---------------- CloudFront ----------------

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${var.project}-site"
  description                       = "Signed requests from CloudFront to the private site bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# HTML·js·css: 파일에 붙인 Cache-Control(no-cache, max-age=0)을 따른다. 기본 0초라 바로 새 파일이 보인다.
resource "aws_cloudfront_cache_policy" "revalidate" {
  name        = "${var.project}-site-revalidate"
  comment     = "Follow object Cache-Control; default no edge caching"
  min_ttl     = 0
  default_ttl = 0
  max_ttl     = 31536000
  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

# 폰트·모델·음원: 1년. 내용을 바꾸면 파일 이름도 바꾼다(docs/MIGRATION.md 4절).
resource "aws_cloudfront_cache_policy" "immutable" {
  name        = "${var.project}-site-immutable"
  comment     = "Long lived assets; change the file name when the content changes"
  min_ttl     = 86400
  default_ttl = 31536000
  max_ttl     = 31536000
  parameters_in_cache_key_and_forwarded_to_origin {
    enable_accept_encoding_gzip   = true
    enable_accept_encoding_brotli = true
    cookies_config {
      cookie_behavior = "none"
    }
    headers_config {
      header_behavior = "none"
    }
    query_strings_config {
      query_string_behavior = "none"
    }
  }
}

# _headers의 "/*" 묶음을 그대로 붙인다. X-Frame-Options는 넣지 않는다(CrazyGames iframe은 CSP frame-ancestors로 허용).
resource "aws_cloudfront_response_headers_policy" "site" {
  name    = "${var.project}-site-security"
  comment = "Same security headers as _headers"
  security_headers_config {
    content_security_policy {
      content_security_policy = local.csp
      override                = true
    }
    content_type_options {
      override = true
    }
    referrer_policy {
      referrer_policy = local.referrer_policy
      override        = true
    }
  }
  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = local.permissions_policy
      override = true
    }
  }
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  comment             = "${var.project} static site"
  default_root_object = "index.html"
  http_version        = "http2and3"
  is_ipv6_enabled     = true
  # 200 = 북미·유럽·아시아(한국·일본 포함). 100은 한국 엣지를 쓰지 않는다.
  price_class = var.price_class
  aliases     = local.use_domain ? [local.site_domain] : []

  origin {
    origin_id                = local.s3_origin_id
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  default_cache_behavior {
    target_origin_id           = local.s3_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = aws_cloudfront_cache_policy.revalidate.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.site.id
  }

  dynamic "ordered_cache_behavior" {
    for_each = local.immutable_paths
    content {
      path_pattern               = ordered_cache_behavior.value
      target_origin_id           = local.s3_origin_id
      viewer_protocol_policy     = "redirect-to-https"
      allowed_methods            = ["GET", "HEAD", "OPTIONS"]
      cached_methods             = ["GET", "HEAD"]
      compress                   = true
      cache_policy_id            = aws_cloudfront_cache_policy.immutable.id
      response_headers_policy_id = aws_cloudfront_response_headers_policy.site.id
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  # 내 도메인을 붙이면 TLS 1.2 이상만 받는다. cloudfront.net 기본 주소는 AWS가 정한 TLS 설정을 쓴다.
  viewer_certificate {
    cloudfront_default_certificate = !local.use_domain
    acm_certificate_arn            = local.use_domain ? aws_acm_certificate_validation.site[0].certificate_arn : null
    ssl_support_method             = local.use_domain ? "sni-only" : null
    minimum_protocol_version       = local.use_domain ? "TLSv1.2_2021" : "TLSv1"
  }
}
