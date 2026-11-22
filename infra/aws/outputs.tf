# Date: 06NOV2026
# Author: Minkyu Jung
# Purpose: DNS 연결 주소, SSH 없는 운영 접속 명령, GitHub 배포 변수 값과 비밀 값 이름을 출력한다.
output "public_ip" {
  value       = aws_eip.game.public_ip
  description = "game_server_host의 DNS only A 레코드에 넣을 고정 IPv4"
}

output "ssm_command" {
  value       = "aws ssm start-session --target ${aws_instance.game.id} --region ap-northeast-2"
  description = "AWS CLI와 Session Manager 플러그인이 설치된 운영 PC에서 실행"
}

output "game_server_url" {
  value       = "https://${local.game_server_host}"
  description = "GitHub 저장소 변수 GAME_SERVER_URL에 넣으면 배포 뒤 바깥에서 /healthz를 확인한다"
}

output "instance_id" {
  value       = aws_instance.game.id
  description = "GitHub 저장소 변수 GAME_SERVER_INSTANCE_ID에 넣는 값"
}

output "deploy_role_arn" {
  value       = aws_iam_role.game_deploy.arn
  description = "GitHub 저장소 변수 AWS_GAME_DEPLOY_ROLE_ARN에 넣는 값(비밀 아님)"
}

output "deploy_document_name" {
  value       = aws_ssm_document.deploy.name
  description = "GitHub 저장소 변수 GAME_SERVER_DEPLOY_DOCUMENT에 넣는 값"
}

output "secret_parameter_names" {
  value       = [for name in var.secret_names : "${var.secret_parameter_path}/${name}"]
  description = "aws ssm put-parameter로 값을 넣을 SecureString 이름(값은 Terraform에 두지 않는다)"
}
