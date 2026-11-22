# Date: 06NOV2026
# Author: Minkyu Jung
# Purpose: 서버 크기·도메인·배포 원본·예산 알림의 운영 입력을 정의한다.
variable "project" {
  type        = string
  default     = "skala-fps"
  description = "모든 AWS 자원의 project 태그와 이름 접두사"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,29}$", var.project))
    error_message = "project는 소문자로 시작하는 30자 이하 영문·숫자·하이픈입니다."
  }
}

variable "instance_type" {
  type        = string
  default     = "t4g.small"
  description = "arm64 AMI와 호환되는 인스턴스 종류"
}

variable "domain" {
  type        = string
  description = "구매한 게임 도메인(예: example.io), 프로토콜·경로 제외"
  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z][a-z0-9-]*$", var.domain))
    error_message = "domain은 소문자 DNS 호스트 이름이어야 합니다."
  }
}

variable "game_server_host" {
  type        = string
  default     = ""
  description = "비우면 game.<domain>. Caddy 인증서를 발급할 실제 호스트"
  validation {
    condition     = var.game_server_host == "" || can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z][a-z0-9-]*$", var.game_server_host))
    error_message = "game_server_host는 빈 문자열 또는 소문자 DNS 호스트 이름입니다."
  }
}

variable "budget_email" {
  type        = string
  description = "SNS 장애 알림과 예산 50·80·100% 알림 수신 이메일"
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.budget_email))
    error_message = "수신 가능한 이메일 주소를 넣으세요."
  }
}

variable "monthly_budget_usd" {
  type        = number
  default     = 40
  description = "계정 전체 월 비용 경보 기준(USD). 지출 상한이나 자동 종료가 아님"
  validation {
    condition     = var.monthly_budget_usd > 0
    error_message = "월 예산은 0보다 커야 합니다."
  }
}

variable "repo_url" {
  type        = string
  default     = "https://github.com/JungMK0720/skala-fps.git"
  description = "서버가 인증 없이 읽을 수 있는 공개 HTTPS 저장소 URL"
  validation {
    condition     = can(regex("^https://[A-Za-z0-9._~:/-]+$", var.repo_url))
    error_message = "인증 정보·공백 없는 HTTPS 저장소 URL을 넣으세요."
  }
}

variable "repo_ref" {
  type        = string
  default     = "main"
  description = "첫 부팅 때 배포할 태그·브랜치·커밋. 이후 배포는 game-server-v* 태그와 GitHub Actions(SSM)로 한다"
  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9._/-]*$", var.repo_ref))
    error_message = "repo_ref는 영숫자로 시작하고 공백·셸 기호를 포함하지 않아야 합니다."
  }
}

variable "service_command" {
  type        = string
  default     = "/usr/local/bin/node server/node.js --host 127.0.0.1 --trust-proxy"
  description = "게임 서버 프로세스 하나의 실행 명령(릴리스 폴더에서 실행, 포트는 환경 변수 PORT로 받음). 기본값은 권위 서버 시제품 기준이라 최종 서버와 맞춰야 함"
  validation {
    condition     = can(regex("^/[^\"'$`\\\\\\r\\n]*$", var.service_command))
    error_message = "서비스 명령은 절대 경로로 시작하는 한 줄이고 따옴표·$·역따옴표·역슬래시가 없어야 합니다."
  }
}

variable "install_command" {
  type        = string
  default     = "/usr/local/bin/npm --prefix server ci --omit=dev --ignore-scripts"
  description = "릴리스 폴더에서 한 번 실행할 서버 의존성 설치 명령(root, 설치 스크립트 끔)"
  validation {
    condition     = can(regex("^/[^\"'$`\\\\\\r\\n]*$", var.install_command))
    error_message = "설치 명령은 절대 경로로 시작하는 한 줄이고 따옴표·$·역따옴표·역슬래시가 없어야 합니다."
  }
}

variable "worker_count" {
  type        = number
  default     = 0
  description = "게임 프로세스 수. 0이면 vCPU 수(t4g.small = 2). 방 하나는 한 프로세스의 단일 스레드에서 돈다"
  validation {
    condition     = var.worker_count >= 0 && var.worker_count <= 64 && floor(var.worker_count) == var.worker_count
    error_message = "worker_count는 0~64 사이 정수입니다."
  }
}

variable "allowed_origins" {
  type        = string
  default     = ""
  description = "게임 서버가 받을 브라우저 Origin(쉼표 구분). 비우면 https://<domain>,https://www.<domain>"
  validation {
    condition     = can(regex("^[A-Za-z0-9.:/,_-]*$", var.allowed_origins))
    error_message = "allowed_origins는 쉼표로 구분한 https 주소 목록입니다."
  }
}

variable "drain_max_seconds" {
  type        = number
  default     = 1800
  description = "새 버전 배포 뒤 옛 프로세스가 진행 중인 방을 끝낼 때까지 기다리는 최대 시간(초)"
  validation {
    condition     = var.drain_max_seconds >= 60 && var.drain_max_seconds <= 7200
    error_message = "drain_max_seconds는 60~7200초입니다."
  }
}

variable "health_timeout_seconds" {
  type        = number
  default     = 60
  description = "새 프로세스 하나의 /healthz가 200이 되기를 기다리는 시간(초). 넘으면 배포를 멈추고 옛 버전을 둔다"
  validation {
    condition     = var.health_timeout_seconds >= 5 && var.health_timeout_seconds <= 600
    error_message = "health_timeout_seconds는 5~600초입니다."
  }
}

variable "secret_parameter_path" {
  type        = string
  default     = "/skala-fps/game"
  description = "게임 서버 비밀 값을 둔 SSM Parameter Store 경로. 값은 소유자가 CLI로 직접 넣고 Terraform에는 이름만 둔다"
  validation {
    condition     = can(regex("^/[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$", var.secret_parameter_path))
    error_message = "secret_parameter_path는 /로 시작하고 /로 끝나지 않는 경로입니다(예: /skala-fps/game)."
  }
}

variable "secret_names" {
  type        = list(string)
  default     = ["GAME_RESULT_SECRET"]
  description = "<secret_parameter_path>/<이름>으로 읽어 같은 이름의 환경 변수로 넘길 비밀 값 목록(SecureString)"
  validation {
    condition     = length(var.secret_names) <= 10 && alltrue([for name in var.secret_names : can(regex("^[A-Z][A-Z0-9_]{0,63}$", name))])
    error_message = "비밀 이름은 10개 이하, 대문자로 시작하는 대문자·숫자·_ 이름입니다."
  }
}

variable "github_repository" {
  type        = string
  default     = "JungMK0720/skala-fps"
  description = "배포 역할을 맡을 수 있는 GitHub 저장소(소유자/이름). 이 저장소의 game-server-v* 태그 작업만 허용"
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "github_repository는 소유자/저장소 형식입니다."
  }
}

variable "github_oidc_provider_arn" {
  type        = string
  default     = ""
  description = "계정에 GitHub OIDC 공급자가 이미 있으면(예: infra/aws/static을 먼저 apply) 그 ARN. 비우면 새로 만든다"
  validation {
    condition     = var.github_oidc_provider_arn == "" || can(regex("^arn:aws:iam::[0-9]{12}:oidc-provider/token\\.actions\\.githubusercontent\\.com$", var.github_oidc_provider_arn))
    error_message = "GitHub OIDC 공급자 ARN이어야 합니다."
  }
}

variable "tick_p95_alarm_ms" {
  type        = number
  default     = 33
  description = "틱 계산 시간 p95 경보 기준(ms). 30 Hz 한 틱은 약 33 ms"
  validation {
    condition     = var.tick_p95_alarm_ms > 0
    error_message = "tick_p95_alarm_ms는 0보다 커야 합니다."
  }
}

