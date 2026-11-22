<!--
  Date: 06NOV2026
  Author: Minkyu Jung
  Purpose: 서울 EC2 게임 서버의 처음 만들기와 태그 배포 절차(SOP). 용어 풀이, 값 지도, 비밀 값 넣기, terraform apply, GitHub 변수, 첫 태그 배포, /healthz·CloudWatch 확인, 실패 시 표, 되돌리기.
-->
# 게임 서버 배포 절차 (SOP)

서울 EC2 한 대에서 게임 서버(Node)를 돌리고, `game-server-v*` 태그를 올리면 GitHub Actions가 끊김 없이 새 버전으로 바꾸는 절차다. 정적 사이트(CloudFront+S3, `infra/aws/static/`)와 로그인·결제 API(Cloudflare Worker)는 이 문서와 따로 간다. 서버를 만드는 기본 준비(도메인, AWS 계정, 예산 알림)는 [infra/aws/README.md](../infra/aws/README.md)에 있다.

| 항목 | 내용 |
|---|---|
| 목표 | 비밀 값 넣기 → 서버 만들기(terraform apply) → GitHub 변수 넣기 → 태그 하나로 배포 → `/healthz`·CloudWatch 확인 |
| 소유자만 할 수 있는 일 | AWS 로그인, 비밀 값 만들기·넣기, `terraform apply`, DNS 레코드, GitHub 변수, 태그 push |
| 걸리는 시간 | 처음 한 번 40~60분(DNS 전파 대기 포함). 이후 배포는 태그 push 한 번, 5분 안팎 |
| 되돌리기 | 이전 태그로 같은 작업을 다시 실행한다(8절) |
| 추가 비용 | 사용자 지표 8개·경보 2개. CloudWatch 무료 구간(지표 10개·경보 10개) 안이면 0원, 넘으면 월 약 $3 |

- 명령은 Windows PowerShell 기준이다. 따로 적지 않으면 저장소 루트에서 실행한다.
- `<...>`는 실제 값으로 바꾼다. 4.2의 `terraform output`에서 나오는 값이 대부분이다.

## 0. 체크리스트

- [ ] 1. 용어와 값 지도 읽기(1·2절)
- [ ] 2. 게임 서버 코드가 `main`에 들어갔고 시작 명령이 맞는지 확인(3절)
- [ ] 3. 비밀 값 만들어 SSM Parameter Store에 넣기(4.1)
- [ ] 4. 첫 태그 만들기, `terraform apply`(4.2)
- [ ] 5. DNS A 레코드, SNS 메일 확인(4.3)
- [ ] 6. 서버 안에서 확인(4.4)
- [ ] 7. GitHub 저장소 변수 넣기(4.5)
- [ ] 8. 태그로 배포해 보기(4.6), `/healthz`·CloudWatch 확인(4.7)

## 1. 용어 풀이

| 말 | 뜻 |
|---|---|
| EC2 | AWS의 가상 서버. 여기서는 서울(`ap-northeast-2`)의 `t4g.small` 한 대(CPU 2개) |
| vCPU·프로세스 | 서버의 CPU 수만큼 게임 서버 프로그램을 띄운다(2개). 방 하나는 한 프로그램 안에서만 돈다 |
| 슬롯 a·b | 프로그램 묶음 두 칸. 지금 버전이 a(포트 8801~)에 있으면 새 버전은 b(8901~)에 띄우고, 다 뜨면 손님을 b로 보낸다. 다음 배포는 다시 a |
| Caddy | 서버 앞의 문지기 프로그램. HTTPS 인증서를 알아서 받고, 바깥 접속(443)을 안쪽 게임 프로그램으로 넘긴다 |
| `/healthz` | 게임 서버가 "살아 있다"고 답하는 주소. 200이면 정상 |
| 비우기(drain) | 새 버전으로 바꾼 뒤 옛 프로그램에 남은 판이 끝날 때까지 기다렸다가 끄는 일. 최대 30분, 그 뒤에는 남은 사람을 끊는다(다시 들어오면 새 버전) |
| SSM | AWS Systems Manager. 22번(SSH)을 열지 않고 서버에 들어가거나 명령을 보내는 기능 |
| SSM Parameter Store | AWS의 설정·비밀 값 보관함. `SecureString`으로 넣으면 암호화되어 저장된다. 서버는 켜질 때와 배포할 때 여기서 비밀 값을 읽는다 |
| SSM 배포 문서 | "태그 이름 하나를 받아 서버에서 배포 스크립트를 돌린다"로 내용이 고정된 명령서. GitHub은 이것만 보낼 수 있다 |
| OIDC | GitHub Actions가 AWS 키 없이 "나는 이 저장소의 이 태그 작업이다"를 증명하는 방식. 키를 저장소에 둘 필요가 없다 |
| IAM 역할 | AWS 권한 묶음. 배포 역할은 "이 서버에 배포 문서 보내기 + 결과 읽기"만 할 수 있다 |
| 태그 | 커밋에 붙이는 이름표. `game-server-v1.0.0`처럼 붙여 올리면 배포가 시작된다 |
| GitHub 변수 | 저장소 Settings → Secrets and variables → Actions → **Variables**. 비밀이 아닌 값(역할 ARN, 서버 ID)을 넣는 곳 |
| CloudWatch | AWS의 지표·경보 서비스. 서버가 1분마다 방 수·사람 수·틱 시간·건강을 올린다 |
| 틱 p95 | 서버가 한 번 계산(1/30초마다)하는 데 걸린 시간 중 느린 쪽 5%의 경계. 33 ms를 넘으면 30 Hz를 못 맞춘다 |
| terraform | 서버·권한·경보를 코드(`infra/aws/*.tf`)대로 만드는 도구. `plan`은 미리 보기, `apply`는 실제 생성 |

## 2. 값 지도

| 값 | 어디서 나오나 | 어디에 넣나 | 비밀인가 |
|---|---|---|---|
| 결과 서명 비밀 `GAME_RESULT_SECRET` | 4.1에서 직접 만든다(64글자 hex) | SSM Parameter Store `/skala-fps/game/GAME_RESULT_SECRET` (SecureString) | **비밀**. 저장소·tfvars·채팅·메모에 쓰지 않는다 |
| 비밀 경로·이름 | `infra/aws/variables.tf`의 `secret_parameter_path`·`secret_names` | 바꿀 일이 없으면 그대로 | 아님 |
| `repo_ref` | 4.2에서 만드는 첫 태그(예 `game-server-v1.0.0`) | `terraform plan -var` | 아님 |
| `domain`·`budget_email` | 산 도메인, 받을 메일 | `terraform plan -var` | 아님 |
| `github_oidc_provider_arn` | `infra/aws/static`을 먼저 apply했다면 거기서 만든 OIDC 공급자 ARN. 아니면 비운다 | `terraform plan -var` | 아님 |
| `public_ip` | `terraform output public_ip` | DNS `game.<도메인>` A 레코드 | 아님 |
| `deploy_role_arn` | `terraform output deploy_role_arn` | GitHub 변수 `AWS_GAME_DEPLOY_ROLE_ARN` | 아님 |
| `instance_id` | `terraform output instance_id` | GitHub 변수 `GAME_SERVER_INSTANCE_ID` | 아님 |
| `deploy_document_name` | `terraform output deploy_document_name` | GitHub 변수 `GAME_SERVER_DEPLOY_DOCUMENT` | 아님 |
| `game_server_url` | `terraform output game_server_url` | GitHub 변수 `GAME_SERVER_URL`(선택, 배포 뒤 바깥 `/healthz` 확인) | 아님 |

GitHub에는 **비밀(secrets)을 하나도 넣지 않는다.** 위 네 값은 모두 변수(Variables)다.

## 3. 시작 전에 확인

1. 게임 서버 코드(`server/node.js`, `server/package.json`, `server/package-lock.json`)가 `main`에 들어가 있어야 한다. 아직 브랜치에만 있으면 여기서 멈춘다.
2. 시작 명령이 맞는지 본다. 기본값(`infra/aws/variables.tf`의 `service_command`):
   ```
   /usr/local/bin/node server/node.js --host 127.0.0.1 --trust-proxy
   ```
   포트는 환경 변수 `PORT`로 넘긴다(슬롯 a = 8801, 8802 …). 이 값은 권위 서버 시제품 기준이다. 최종 서버의 시작 명령·옵션이 다르면 `-var='service_command=...'`로 바꾼다. 의존성 설치 명령은 `install_command`(기본 `npm --prefix server ci --omit=dev --ignore-scripts`).
3. 게임 서버가 `/healthz`(정상이면 200)와 `/metrics`(Prometheus 글자, `skala_rooms`·`skala_players`·`skala_connections`·`skala_tick_ms{q="0.95"}`)를 내야 배포·지표가 동작한다.
4. 준비물: AWS CLI v2, Session Manager 플러그인, Terraform 1.9 이상, GitHub CLI(`gh`). README의 "준비"를 먼저 끝낸다.
   ```powershell
   aws --version
   terraform version
   gh auth status
   ```

## 4. 처음 한 번

### 4.1 비밀 값 만들어 넣기 (terraform apply보다 먼저)

서버는 켜지자마자 이 값을 읽는다. 없으면 게임 서버가 뜨지 않는다.

```powershell
aws sso login
$secret = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
aws ssm put-parameter --region ap-northeast-2 --name /skala-fps/game/GAME_RESULT_SECRET --type SecureString --value $secret
Remove-Variable secret
```

성공하면 `{"Version": 1, "Tier": "Standard"}`가 나온다. 값이 들어갔는지(값은 보이지 않게) 확인:

```powershell
aws ssm describe-parameters --region ap-northeast-2 --parameter-filters Key=Name,Values=/skala-fps/game/GAME_RESULT_SECRET
```

`"Type": "SecureString"`이 보이면 된다.

- 결과를 검증하는 쪽(예: Cloudflare Worker)이 같은 값을 써야 하면 그쪽 문서대로 같은 값을 넣는다. 그때는 위 `Remove-Variable` 전에 넣는다.
- 값을 바꿀 때: 같은 명령에 `--overwrite`를 붙이고 4.6처럼 새 태그를 배포한다. 배포 때 새 값을 읽고, 옛 프로그램은 비워질 때까지 옛 값을 쓴다.

### 4.2 첫 태그와 서버 만들기

첫 부팅 때 배포할 커밋을 태그로 정한다(`main`의 검토한 커밋).

```powershell
git switch main
git pull --ff-only
git tag -a game-server-v1.0.0 -m "game server 1.0.0"
git push origin game-server-v1.0.0
```

이 push로 Actions의 **Deploy game server**가 한 번 돈다. 아직 GitHub 변수가 없으므로 `Game server deployment skipped` 안내(notice)와 함께 초록색으로 끝나는 것이 정상이다.

```powershell
terraform -chdir=infra/aws init
terraform -chdir=infra/aws plan -out=launch.tfplan -var='domain=<도메인>' -var='budget_email=<메일>' -var='repo_ref=game-server-v1.0.0'
terraform -chdir=infra/aws apply launch.tfplan
terraform -chdir=infra/aws output
```

- `infra/aws/static`을 먼저 apply했다면 plan에 `-var='github_oidc_provider_arn=<그 OIDC 공급자 ARN>'`을 더한다(계정에 하나만 만들 수 있다).
- plan 결과에서 `aws_instance.game`, `aws_iam_role.game_deploy`, `aws_ssm_document.deploy`, 경보 `tick_p95`·`healthz`가 만들어지는지 본다.
- 성공하면 `Apply complete!`와 함께 `public_ip`, `instance_id`, `deploy_role_arn`, `deploy_document_name`, `game_server_url`이 나온다. 메모해 둔다(비밀 아님).
- 이미 서버가 있는 상태에서 apply하면 user-data가 바뀌어 **서버가 새로 만들어진다**(`instance_id`가 바뀐다. 4.5의 변수도 고친다). 사람이 없는 시간에 한다.

### 4.3 DNS와 알림 메일

1. Cloudflare DNS에 `game` A 레코드 = `public_ip`, **DNS only(회색 구름)**.
2. SNS 구독 확인 메일에서 **Confirm subscription**을 누른다. 경보는 이 메일로 온다.

### 4.4 서버 안에서 확인

```powershell
aws ssm start-session --target <instance_id> --region ap-northeast-2
```

들어간 뒤:

```sh
sudo cloud-init status --wait
systemctl status caddy fps-secrets 'fps-game@*' --no-pager
cat /etc/fps/state/active-slot /etc/fps/state/slot-a.env
curl -s http://127.0.0.1:8801/healthz
systemctl list-timers fps-metrics.timer --no-pager
```

| 성공 모습 | |
|---|---|
| `cloud-init status` | `status: done` |
| `fps-game@a1`, `fps-game@a2` | `active (running)` |
| `active-slot` | `a`, `slot-a.env`에 `FPS_REF=game-server-v1.0.0` |
| `curl .../healthz` | `{"ok":true,...}` |
| `fps-metrics.timer` | 다음 실행 시각이 1분 안 |

`exit`로 나온다. 바깥 PC에서:

```powershell
curl.exe -s https://game.<도메인>/healthz
```

`{"ok":true,...}`면 HTTPS까지 된다. DNS 전파 전에는 인증서 오류가 날 수 있다. 몇 분 뒤 다시 본다.

### 4.5 GitHub 변수 넣기

```powershell
gh variable set AWS_GAME_DEPLOY_ROLE_ARN --body "<deploy_role_arn>"
gh variable set GAME_SERVER_INSTANCE_ID --body "<instance_id>"
gh variable set GAME_SERVER_DEPLOY_DOCUMENT --body "<deploy_document_name>"
gh variable set GAME_SERVER_URL --body "https://game.<도메인>"
gh variable list
```

네 줄이 보이면 된다. 웹에서는 Settings → Secrets and variables → Actions → Variables 탭이다.

### 4.6 태그로 배포해 보기

같은 커밋에 다음 번호 태그를 붙여도 되고, 새 커밋이면 그 커밋에 붙인다.

```powershell
git tag -a game-server-v1.0.1 -m "game server 1.0.1"
git push origin game-server-v1.0.1
gh run watch
```

Actions에서 순서대로 초록이 되면 성공이다: `npm run check` → `Assume deploy role (OIDC)` → `Run deploy document on the server (SSM)`(로그 끝에 `[deploy] 완료: game-server-v1.0.1 ...`) → `Check public /healthz`.

서버 안에서는 이렇게 바뀐다: 슬롯 b에 새 프로그램 → 모두 `/healthz` 200 → Caddy가 b로 전환 → `fps-drain-a`가 옛 프로그램을 비운다(`journalctl -u fps-drain-a`).

### 4.7 CloudWatch 확인

1. 콘솔 → CloudWatch → Metrics → All metrics → **SkalaFps/GameServer** → Service. `Rooms`, `Players`, `TickP95Ms`, `HealthCheckOk` 등이 1분마다 찍히는지 본다(처음 몇 분은 비어 있을 수 있다).
2. 콘솔 → CloudWatch → Alarms. `skala-fps-game-healthz`·`skala-fps-game-tick-p95`가 **OK**(초록)인지 본다. 서버를 막 만든 직후 몇 분은 `INSUFFICIENT_DATA`나 `ALARM`일 수 있다. 10분 뒤에도 `healthz`가 ALARM이면 6절을 본다.

```powershell
aws cloudwatch describe-alarms --region ap-northeast-2 --alarm-name-prefix skala-fps-game --query "MetricAlarms[].[AlarmName,StateValue]" --output table
```

## 5. 평소 배포

1. `main`에 반영된 검토한 커밋에 다음 번호 태그를 붙여 push한다(4.6과 같다).
2. Actions가 초록인지 본다. 실패해도 옛 버전은 그대로 돈다(새 프로그램만 멈춘다).
3. 배포와 배포 사이는 비우기가 끝날 만큼(보통 판 하나, 최대 30분) 띄운다. 너무 빨리 또 배포하면 아직 비우는 중인 그 전 버전의 판은 바로 끊긴다.

지금 도는 버전 보기(SSM 세션 안): `cat /etc/fps/state/active-slot; grep FPS_REF /etc/fps/state/slot-*.env`

## 6. 실패 시 표

| 증상 | 원인 | 할 일 |
|---|---|---|
| Actions가 초록인데 `Game server deployment skipped` | GitHub 변수 세 개 중 하나가 없다 | 4.5 |
| `Run this from a game-server-v* tag` | 브랜치에서 수동 실행했다 | Run workflow에서 Use workflow from → Tags → 태그 선택 |
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | 태그 이름이 `game-server-v`로 시작하지 않음, 저장소 이름이 `github_repository`와 다름, OIDC 공급자 없음 | 태그 이름 확인, `-var='github_repository=소유자/이름'`으로 apply |
| `AccessDeniedException ... ssm:SendCommand` | `GAME_SERVER_INSTANCE_ID`·`GAME_SERVER_DEPLOY_DOCUMENT`가 terraform output과 다름(서버를 새로 만든 뒤 흔함) | `terraform output`으로 다시 넣기 |
| `InvalidInstanceId` 또는 상태 `Undeliverable` | 서버가 꺼졌거나 SSM 에이전트가 연결 안 됨 | 콘솔 EC2 상태 확인, Systems Manager → Fleet Manager에 서버가 Online인지 |
| 로그에 `비밀 값을 읽지 못했습니다` / `SSM Parameter Store에 없는 값` | 4.1을 안 했거나 이름 오타 | 4.1, `terraform output secret_parameter_names`와 이름 비교 |
| 로그에 `건강 확인 실패` | 새 버전이 뜨지 않는다(코드 오류, 시작 명령 불일치) | 옛 버전은 그대로 돈다. SSM 세션에서 `journalctl -u 'fps-game@*' -n 100`, 3절 시작 명령 확인 |
| 로그에 `의존성 설치 실패` | `server/package-lock.json` 없음, npm 오류 | 그 커밋에 lock 파일이 있는지 확인 |
| `다른 배포가 진행 중입니다` | 배포 두 개가 겹침 | 앞 배포가 끝난 뒤 Re-run |
| `repo_ref ...에 infra/aws/game-server/deploy.sh가 없습니다`(cloud-init 로그) | 첫 태그가 이 구성이 없는 커밋 | 올바른 태그로 다시 apply(`/var/log/cloud-init-output.log` 확인) |
| 바깥 `/healthz`만 실패, 서버 안 `curl 127.0.0.1:8801/healthz`는 성공 | DNS 미전파, 인증서 발급 실패 | DNS 확인 후 `sudo systemctl restart caddy`, `journalctl -u caddy` |
| `healthz` 경보 ALARM | 받는 슬롯 프로그램 중 하나가 200이 아니거나, Caddy가 죽었거나, 지표 수집기가 멈춤 | `systemctl status 'fps-game@*' caddy fps-metrics.timer`, `journalctl -u fps-metrics -n 20` |
| `tick-p95` 경보 ALARM | 한 프로그램에 방·사람이 많아 1/30초 안에 계산을 못 한다 | 사람이 몰린 시간인지 확인. 길어지면 더 큰 인스턴스(`instance_type`)나 서버 쪽 방 수 제한을 검토 |
| apply 때 `EntityAlreadyExists ... oidc-provider` | 계정에 GitHub OIDC 공급자가 이미 있다 | `-var='github_oidc_provider_arn=<ARN>'` (IAM → Identity providers에서 확인) |

## 7. 무엇이 어디에 있나

| 파일 | 하는 일 |
|---|---|
| `infra/aws/main.tf` | EC2, 보안 그룹(80·443), 서버 권한(비밀 읽기·지표 올리기), 경보 |
| `infra/aws/github-deploy.tf` | OIDC 공급자, 배포 역할(태그만), SSM 배포 문서 |
| `infra/aws/user-data.sh.tftpl` | 첫 부팅: Node·Caddy 설치, 운영 값 파일, 첫 배포 |
| `infra/aws/game-server/deploy.sh` | 서버 안 배포 순서(새 프로그램 → 건강 확인 → Caddy 전환 → 비우기) |
| `infra/aws/game-server/drain.sh` | 옛 프로그램 비우기 |
| `infra/aws/game-server/secrets.mjs`, `systemd/fps-secrets.service` | SSM에서 비밀 값 읽기 → `/run/fps/secrets.env` |
| `infra/aws/game-server/metrics-agent.mjs`, `systemd/fps-metrics.*` | 1분마다 CloudWatch 지표 |
| `.github/workflows/deploy-game-server.yml` | 태그 → 검사 → OIDC → SSM 배포 |

## 8. 되돌리기

**이전 태그를 다시 배포한다.** 새 버전을 올릴 때와 똑같이 끊김 없이 바뀐다.

```powershell
gh workflow run deploy-game-server.yml --ref game-server-v1.0.0
gh run watch
```

웹에서는 Actions → Deploy game server → Run workflow → **Use workflow from → Tags → 이전 태그** → Run workflow. 브랜치(main)를 고르면 멈춘다(6절 두 번째 줄).

GitHub Actions가 안 될 때(소유자 PC에서 직접):

```powershell
aws ssm send-command --region ap-northeast-2 --instance-ids <instance_id> --document-name <deploy_document_name> --parameters tag=game-server-v1.0.0
```

나온 `CommandId`로 결과 보기: `aws ssm get-command-invocation --region ap-northeast-2 --command-id <CommandId> --instance-id <instance_id> --query StandardOutputContent --output text`

- 되돌릴 수 있는 것은 `game-server-v*` 태그가 붙은 버전뿐이다. 태그는 지우지 않는다.
- 서버 전체를 없애는 것은 README의 "철거 / 롤백"을 따른다. SSM Parameter Store의 비밀 값은 `terraform destroy`로 지워지지 않는다. 필요 없으면 `aws ssm delete-parameter --region ap-northeast-2 --name /skala-fps/game/GAME_RESULT_SECRET`.

## 9. 알아 둘 한계

- 방은 프로그램 메모리에만 있다. 서버를 새로 만들거나(apply로 교체) 비우기 최대 시간이 지나면 그 판은 끊긴다.
- 같은 방은 Caddy가 방 주소(`/room/<id>`)로 같은 프로그램에 보낸다. 방 주소에 `?쿼리`를 붙이면 같은 방 사람이 다른 프로그램으로 갈 수 있다.
- 비우는 동안 옛 방에 새로 들어오는 사람은 새 버전의 같은 이름 방으로 간다(옛 방과 따로).
- 이 구성은 terraform `plan`·`apply`와 실제 서버에서 돌려 본 적이 아직 없다. 처음 apply 뒤 4.4·4.7 확인을 꼭 한다.
