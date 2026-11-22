# Date: 06NOV2026
# Author: Minkyu Jung
# Purpose: 정적 사이트의 이름 접두사·도메인·배포 저장소·캐시 범위 입력을 정의한다. 모두 기본값이 있어 도메인 없이도 apply할 수 있다.
variable "project" {
  type        = string
  default     = "skala-fps"
  description = "게임 서버(infra/aws)와 같은 project 태그·이름 접두사"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,29}$", var.project))
    error_message = "project는 소문자로 시작하는 30자 이하 영문·숫자·하이픈입니다."
  }
}

variable "site_domain" {
  type        = string
  default     = ""
  description = "게임 주소(예: example.io). 비우면 인증서 없이 dxxxx.cloudfront.net 주소만 쓴다"
  validation {
    condition     = var.site_domain == "" || can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z][a-z0-9-]*$", var.site_domain))
    error_message = "site_domain은 빈 문자열 또는 소문자 DNS 호스트 이름(프로토콜·경로 제외)입니다."
  }
}

variable "attach_site_domain" {
  type        = bool
  default     = false
  description = "Cloudflare에 인증서 검증 CNAME을 넣은 뒤 true로 바꿔 apply하면 인증서 발급을 기다리고 CloudFront에 도메인을 붙인다"
}

variable "repo_url" {
  type        = string
  default     = "https://github.com/JungMK0720/skala-fps.git"
  description = "배포를 허락할 GitHub 저장소. infra/aws의 repo_url과 같은 값"
  validation {
    condition     = can(regex("^https://github\\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.repo_url))
    error_message = "https://github.com/<소유자>/<저장소>(.git) 형식이어야 합니다."
  }
}

variable "github_repository" {
  type        = string
  default     = ""
  description = "비우면 repo_url에서 읽는다(<소유자>/<저장소>). 대소문자까지 GitHub 표시와 같아야 한다"
  validation {
    condition     = var.github_repository == "" || can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository는 <소유자>/<저장소> 형식입니다."
  }
}

variable "github_oidc_provider_arn" {
  type        = string
  default     = ""
  description = "계정에 GitHub OIDC 공급자가 이미 있으면 그 ARN. 비우면 새로 만든다"
  validation {
    condition     = var.github_oidc_provider_arn == "" || can(regex("^arn:aws:iam::[0-9]{12}:oidc-provider/token\\.actions\\.githubusercontent\\.com$", var.github_oidc_provider_arn))
    error_message = "arn:aws:iam::<계정 12자리>:oidc-provider/token.actions.githubusercontent.com 형식입니다."
  }
}

variable "price_class" {
  type        = string
  default     = "PriceClass_200"
  description = "CloudFront 엣지 범위. 한국 엣지를 쓰려면 PriceClass_200 이상"
  validation {
    condition     = contains(["PriceClass_200", "PriceClass_All"], var.price_class)
    error_message = "PriceClass_100은 한국 엣지를 쓰지 않으므로 PriceClass_200 또는 PriceClass_All만 받습니다."
  }
}

variable "old_version_days" {
  type        = number
  default     = 30
  description = "덮어쓰거나 지운 파일의 옛 버전을 보관할 날 수(되돌리기용)"
  validation {
    condition     = var.old_version_days >= 1
    error_message = "1일 이상이어야 합니다."
  }
}
