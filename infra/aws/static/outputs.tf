# Date: 06NOV2026
# Author: Minkyu Jung
# Purpose: GitHub 저장소 변수에 넣을 값과 Cloudflare DNS에 넣을 레코드를 출력한다.
output "github_variables" {
  description = "GitHub Settings → Secrets and variables → Actions → Variables에 그대로 넣는다"
  value = {
    AWS_STATIC_BUCKET          = aws_s3_bucket.site.bucket
    AWS_STATIC_DISTRIBUTION_ID = aws_cloudfront_distribution.site.id
    AWS_DEPLOY_ROLE_ARN        = aws_iam_role.deploy.arn
    AWS_STATIC_REGION          = "ap-northeast-2"
  }
}

output "cloudfront_domain" {
  description = "dxxxx.cloudfront.net. 도메인 없이 바로 열어 볼 수 있고, Cloudflare CNAME의 대상이다"
  value       = aws_cloudfront_distribution.site.domain_name
}

output "site_url" {
  description = "지금 게임이 열리는 주소"
  value       = "https://${local.site_hostname}/"
}

output "certificate_validation_records" {
  description = "Cloudflare DNS에 CNAME으로 넣는다(프록시 끔, DNS only). site_domain이 비어 있으면 빈 목록"
  value = local.site_domain == "" ? [] : [
    for option in aws_acm_certificate.site[0].domain_validation_options : {
      type    = option.resource_record_type
      name    = option.resource_record_name
      content = option.resource_record_value
    }
  ]
}

output "site_dns_record" {
  description = "attach_site_domain=true로 apply한 뒤 Cloudflare에 넣을 사이트 레코드(DNS only)"
  value = local.site_domain == "" ? null : {
    type    = "CNAME"
    name    = local.site_domain
    content = aws_cloudfront_distribution.site.domain_name
    proxy   = "DNS only (회색 구름)"
  }
}

output "response_headers_csp" {
  description = "CloudFront가 붙이는 CSP(_headers에서 읽은 값). curl -I 결과와 비교한다"
  value       = local.csp
}
