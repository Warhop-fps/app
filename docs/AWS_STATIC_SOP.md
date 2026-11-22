<!--
  Date: 06NOV2026
  Author: Minkyu Jung
  Purpose: 게임 정적 파일을 AWS CloudFront + S3로 옮기는 절차(SOP). 용어 풀이, 값 지도, 설치·로그인·지원금 확인, terraform, 인증서·DNS, GitHub 변수, 첫 배포, 헤더·캐시 확인, 실패 표, 되돌리기.
-->
# 게임 사이트를 AWS CloudFront + S3로 옮기기 (SOP)

| 항목 | 내용 |
|---|---|
| 결정 | 2026-11-22 소유자 결정(AWS 지원금 승인). 정적 게임 파일은 **CloudFront + S3**, 게임 서버는 EC2 서울(`infra/aws`), 로그인·결제 API는 Cloudflare Worker `skala-api` 그대로, DB는 Supabase 그대로 |
| 지금 상태 | 코드만 준비됨. AWS에 아무것도 만들지 않았다. 운영 주소는 여전히 GitHub Pages `https://jungmk0720.github.io/skala-fps/` |
| 만드는 것 | `infra/aws/static`(Terraform): 비공개 S3 버킷, CloudFront, 보안 헤더 정책, (도메인을 넣으면) 인증서, GitHub 배포 역할 |
| 배포 | `.github/workflows/deploy-aws-static.yml`: main에 올라가면 검사 → `dist/` 빌드 → S3 업로드 → HTML 캐시 비우기 → 헤더 확인 |
| 소유자만 할 수 있는 일 | AWS 로그인, `terraform apply`, Cloudflare DNS 레코드 추가, GitHub 저장소 변수 넣기 |
| 걸리는 시간 | 처음 한 번 1~2시간(인증서 발급·DNS 대기 포함) |
| 비용 | 작은 사이트라 거의 0원에 가깝다. CloudFront는 매달 1 TB·요청 1천만 건 무료 구간이 있고(적용 시점에 [요금](https://aws.amazon.com/cloudfront/pricing/) 확인), S3는 수백 MB라 월 몇 십 원 수준이다. 지원금에서 먼저 빠진다 |
| 되돌리기 | GitHub Pages를 지우지 않으므로 DNS만 돌리면 된다(9절) |

- 명령은 Windows PowerShell 기준이다. 따로 적지 않으면 저장소 루트에서 실행한다.
- `example.io`는 예시다. 실제 산 도메인으로 바꾼다. 도메인은 Cloudflare Registrar에서 사고 DNS도 Cloudflare에 둔다.
- 게임 서버(`infra/aws`)와 사이트(`infra/aws/static`)는 **따로따로** apply한다. 서버를 `terraform destroy`해도 사이트는 지워지지 않는다.

## 0. 체크리스트

- [ ] 1. 용어 읽기
- [ ] 2. 값 지도 확인
- [ ] 3. AWS CLI·Terraform 설치, AWS 로그인, 지원금 확인
- [ ] 4. `infra/aws/static`에서 `terraform init/plan/apply` (도메인 없이) → cloudfront.net 주소 확인
- [ ] 5. GitHub 저장소 변수 4개 넣기 → 첫 배포 → 헤더·캐시 확인
- [ ] 6. 도메인을 산 뒤: 인증서 검증 CNAME → 도메인 붙이기 → 사이트 CNAME (모두 DNS only)
- [ ] 7. `_headers`가 바뀔 때마다 다시 apply
- [ ] 8. GitHub Pages 안내 유지
- [ ] 9. 문제가 생기면 되돌리기

## 1. 용어 풀이

| 말 | 뜻 |
|---|---|
| S3 | AWS의 파일 창고. "버킷"이라는 통 하나에 게임 파일(`dist/`)을 넣는다. 이 버킷은 **비공개**다. 인터넷에서 직접 못 읽는다 |
| CloudFront | 전 세계(한국 포함) 서버에 파일을 복사해 두고 가까운 곳에서 빠르게 주는 서비스(CDN). 처음에는 `dxxxx.cloudfront.net` 주소가 생긴다 |
| OAC (Origin Access Control) | "CloudFront만 S3 버킷을 읽을 수 있다"는 열쇠. 그래서 버킷을 공개하지 않아도 된다 |
| ACM | AWS의 무료 HTTPS 인증서. CloudFront용 인증서는 꼭 **버지니아 북부(us-east-1)**에 만든다(Terraform이 알아서 한다) |
| DNS 검증 CNAME | "이 도메인 주인이 맞다"를 보여 주려고 DNS에 넣는 레코드. Cloudflare에 넣으면 ACM이 인증서를 발급한다 |
| OIDC | GitHub Actions가 **비밀 키 없이** AWS 역할을 잠깐 빌리는 방식. 이 저장소의 main 브랜치에서 돈 작업만 빌릴 수 있게 묶어 두었다 |
| IAM 역할 | AWS 권한 묶음. 배포 역할은 이 버킷에 파일 올리기·지우기·목록 보기, 이 CloudFront의 캐시 비우기·주소 읽기만 할 수 있다 |
| invalidation(캐시 비우기) | CloudFront 서버에 남은 옛 파일을 지우라고 알리는 것. 배포 때 HTML(`/`, `/index.html`, `/privacy.html`)만 비운다. 매달 1,000 경로까지 무료 |
| 응답 헤더 정책 | CloudFront가 모든 응답에 붙이는 보안 헤더(CSP 등). 값은 저장소의 `_headers`에서 그대로 읽는다 |
| terraform | 클라우드 자원을 글(.tf 파일)로 적어 두고 그대로 만들어 주는 도구. `init`(준비) → `plan`(무엇이 바뀌는지 미리 보기) → `apply`(실제로 만들기) 순서다 |
| 상태 파일(tfstate) | terraform이 "내가 만든 것" 목록을 적는 파일. `infra/aws/static/terraform.tfstate`. 지우면 terraform이 자원을 잊는다. **백업하고 저장소에 올리지 않는다**(.gitignore에 있음) |
| DNS only(회색 구름) | Cloudflare DNS 레코드의 프록시를 끈 상태. 이번 레코드는 **모두 DNS only**로 둔다. 주황 구름(프록시)이면 CloudFront 인증서와 겹쳐 오류가 난다 |

## 2. 값 지도

| 값 | 어디서 나오나 | 어디에 넣나 |
|---|---|---|
| 도메인 `example.io` | Cloudflare Registrar에서 산 이름 | Terraform 변수 `site_domain` (6절). 도메인 전에는 비워 둔다 |
| 저장소 `JungMK0720/skala-fps` | `infra/aws/static/variables.tf`의 `repo_url` 기본값 | 바꿀 일 없음. 저장소 이름을 바꾸면 이 값도 바꾸고 다시 apply |
| 버킷 이름 `skala-fps-site-…` | `terraform output github_variables` | GitHub 변수 `AWS_STATIC_BUCKET` |
| 배포 ID `E…` | 같은 출력 | GitHub 변수 `AWS_STATIC_DISTRIBUTION_ID` |
| 배포 역할 ARN `arn:aws:iam::…:role/skala-fps-site-deploy-…` | 같은 출력 | GitHub 변수 `AWS_DEPLOY_ROLE_ARN` |
| 리전 `ap-northeast-2` | 같은 출력(서울 고정) | GitHub 변수 `AWS_STATIC_REGION` |
| `dxxxx.cloudfront.net` | `terraform output cloudfront_domain` | 브라우저 시험 주소, Cloudflare 사이트 CNAME의 대상 |
| 인증서 검증 레코드 | `terraform output certificate_validation_records` | Cloudflare DNS의 CNAME(DNS only) |
| 이미 있는 GitHub OIDC 공급자 ARN | IAM → Identity providers (있을 때만) | Terraform 변수 `github_oidc_provider_arn` |

어느 변수가 어느 배포를 켜나:

| 저장소 변수 | 켜지는 것 |
|---|---|
| `AWS_STATIC_BUCKET`·`AWS_STATIC_DISTRIBUTION_ID`·`AWS_DEPLOY_ROLE_ARN`·`AWS_STATIC_REGION` 넷 다 | `deploy-aws-static.yml`(AWS). 하나라도 없으면 notice만 남기고 건너뜀 |
| `CLOUDFLARE_PAGES_PROJECT` | `deploy-pages.yml`(Cloudflare Pages, 예전 계획) |
| `AWS_STATIC_BUCKET`과 `CLOUDFLARE_PAGES_PROJECT`를 **함께** | 두 워크플로 모두 **실패**한다(운영 배포가 둘이 되지 않게). 하나를 지운다 |

GitHub Pages(지금 운영 주소)는 이 변수들과 상관없이 그대로 돈다.

## 3. 준비: 설치·로그인·지원금 확인

1. AWS CLI와 Terraform을 설치한다. PowerShell을 새로 열어 버전이 나오면 성공이다.
   ```powershell
   winget install --id Amazon.AWSCLI -e
   winget install --id Hashicorp.Terraform -e
   # 새 PowerShell 창에서
   aws --version          # aws-cli/2.x 가 나오면 성공
   terraform -version     # Terraform v1.9 이상, 2.0 미만이어야 한다
   ```
2. AWS에 로그인한다. 루트 계정 액세스 키는 만들지 않는다. IAM Identity Center(콘솔 검색창에 "IAM Identity Center")에서 사용자를 만들고 `AdministratorAccess` 권한 세트를 계정에 연결한 뒤:
   ```powershell
   aws configure sso
   # SSO start URL: Identity Center 첫 화면의 "AWS access portal URL"
   # SSO region: Identity Center를 켠 리전(대개 ap-northeast-2)
   # CLI default region: ap-northeast-2, output: json, profile name: skala
   $env:AWS_PROFILE = 'skala'
   aws sts get-caller-identity
   ```
   성공: `"Account": "123456789012"`처럼 내 계정 번호가 나온다. 다음부터는 `aws sso login --profile skala` 후 `$env:AWS_PROFILE = 'skala'`만 하면 된다.
3. 지원금을 확인한다. 콘솔 오른쪽 위 계정 이름 → **Billing and Cost Management → Credits**. 금액, **만료일**, 적용 서비스(CloudFront·S3·EC2가 포함되는지)를 본다. 지원금은 비용 상한이 아니다. 만료·소진 뒤에는 카드로 청구된다.
4. 예산 알림: 게임 서버(`infra/aws`)를 만들면 계정 전체 월 $40 경보가 같이 생긴다. 사이트를 먼저 만든다면 Billing → **Budgets → Create budget → Monthly cost budget**으로 같은 경보를 직접 하나 만든다(이 SOP의 Terraform은 예산을 만들지 않는다. 두 번 만들면 메일만 두 번 온다).

## 4. 사이트 만들기 (도메인 없이 먼저)

1. 최신 `main`에서 시작한다.
   ```powershell
   git switch main
   git pull
   ```
2. 준비·미리 보기·만들기.
   ```powershell
   terraform -chdir=infra/aws/static init
   terraform -chdir=infra/aws/static plan -out=static.tfplan
   terraform -chdir=infra/aws/static apply static.tfplan
   terraform -chdir=infra/aws/static output
   ```
   - `init` 성공: `Terraform has been successfully initialized!`
   - `plan` 성공: 끝에 `Plan: 15 to add, 0 to change, 0 to destroy.` (계정에 GitHub OIDC 공급자가 이미 있어 변수로 넣었다면 14). **destroy가 0인지 꼭 본다.**
   - `apply` 성공: `Apply complete! Resources: 15 added`. CloudFront 생성에 5~10분 걸린다.
   - 처음 생긴 `infra/aws/static/.terraform.lock.hcl`은 커밋해 둔다(공급자 버전 고정). `terraform.tfstate`는 커밋하지 말고 다른 곳에 백업한다.
3. 출력의 `site_url`(`https://dxxxx.cloudfront.net/`)은 아직 빈 사이트라 `AccessDenied`가 나온다. 정상이다. 5절의 첫 배포 뒤에 게임이 열린다.

## 5. GitHub 변수·첫 배포·확인

1. GitHub 저장소 → **Settings → Secrets and variables → Actions → Variables** 탭 → **New repository variable**로 넷을 넣는다. 값은 `terraform -chdir=infra/aws/static output github_variables`에 나온 그대로다. Secrets 탭이 아니다(비밀 값이 없다).
   - `AWS_STATIC_BUCKET`, `AWS_STATIC_DISTRIBUTION_ID`, `AWS_DEPLOY_ROLE_ARN`, `AWS_STATIC_REGION`
   - 같은 화면에 `CLOUDFLARE_PAGES_PROJECT`가 있으면 지운다(2절 표).
2. **Actions → Deploy AWS static site → Run workflow**(브랜치 `main`)로 첫 배포를 한다. main이 아닌 브랜치에서 돌리면 OIDC가 거절된다(일부러 그렇게 묶음).
   - 성공: 모든 단계 초록, 마지막 단계에 `응답 헤더가 _headers와 같습니다.` notice. 첫 배포의 "Check live headers before upload"는 `아직 비어 있는 사이트(첫 배포)로 보고 계속합니다` notice가 정상이다.
   - 이후로는 main에 머지될 때마다 자동으로 돈다.
3. 헤더와 캐시를 직접 본다. PowerShell의 `curl`은 다른 명령이므로 **`curl.exe`**로 친다.
   ```powershell
   curl.exe -sI https://dxxxx.cloudfront.net/
   curl.exe -sI https://dxxxx.cloudfront.net/fonts/pretendard/PretendardVariable.subset.0.woff2
   ```
   | 첫 화면(`/`)에서 볼 줄 | 기대 값 |
   |---|---|
   | 첫 줄 | `HTTP/1.1 200 OK` 또는 `HTTP/2 200` |
   | `content-security-policy` | `_headers`의 CSP와 같은 긴 줄. 끝에 `frame-ancestors 'self' https://*.crazygames.com …` |
   | `x-content-type-options` | `nosniff` |
   | `referrer-policy` | `strict-origin-when-cross-origin` |
   | `permissions-policy` | `camera=(), microphone=(), geolocation=(), payment=()` |
   | `cache-control` | `no-cache` |
   | `x-frame-options` | **없어야** 한다(CrazyGames iframe을 막음) |

   폰트에서는 `cache-control: public, max-age=31536000, immutable`이 나오고, 두 번째 요청부터 `x-cache: Hit from cloudfront`가 나오면 성공이다.
4. 브라우저(새 시크릿 창)로 `https://dxxxx.cloudfront.net/`을 열어 첫 화면이 뜨는지만 본다. 로그인·결제는 Google/Kakao 콘솔에 이 주소를 넣지 않았으므로 여기서는 시험하지 않는다(진짜 도메인에서 한다).

## 6. 도메인을 산 뒤: 인증서와 DNS

1. `infra/aws/static/terraform.tfvars` 파일을 만든다(저장소에 안 올라감).
   ```hcl
   site_domain = "example.io"
   ```
2. 인증서를 만든다.
   ```powershell
   terraform -chdir=infra/aws/static plan -out=static.tfplan
   terraform -chdir=infra/aws/static apply static.tfplan
   terraform -chdir=infra/aws/static output certificate_validation_records
   ```
   성공: `Plan: 1 to add, 0 to change, 0 to destroy`(인증서), 출력에 `name`·`content`가 있는 CNAME 하나.
3. Cloudflare 대시보드 → 도메인 → **DNS → Records → Add record**: Type `CNAME`, Name은 출력의 `name`(끝의 `.example.io.`까지 붙여 넣어도 Cloudflare가 알아서 줄인다), Target은 `content`, **Proxy status: DNS only(회색 구름)**. 저장.
4. 발급을 기다린다(보통 5~30분). 아래 명령의 결과가 `ISSUED`면 된다.
   ```powershell
   aws acm list-certificates --region us-east-1 --query "CertificateSummaryList[].[DomainName,Status]" --output table
   ```
5. 도메인을 CloudFront에 붙인다. `terraform.tfvars`에 한 줄을 더한다.
   ```hcl
   site_domain        = "example.io"
   attach_site_domain = true
   ```
   ```powershell
   terraform -chdir=infra/aws/static plan -out=static.tfplan
   terraform -chdir=infra/aws/static apply static.tfplan
   terraform -chdir=infra/aws/static output site_dns_record
   ```
   성공: `1 to add, 1 to change, 0 to destroy`(인증서 확인 + CloudFront 변경). CloudFront 반영에 5~10분.
6. Cloudflare DNS에 사이트 레코드를 넣는다: Type `CNAME`, Name `example.io`(맨 앞 도메인은 `@`), Target `dxxxx.cloudfront.net`, **DNS only**. Cloudflare는 맨 앞 도메인의 CNAME도 받아 준다(CNAME flattening).
7. 확인: `curl.exe -sI https://example.io/`에서 5절 3번 표와 같은 헤더가 나오면 끝. 내 도메인에서는 TLS 1.2 이상만 받는다(`TLSv1.2_2021`). `dxxxx.cloudfront.net` 주소의 TLS는 AWS 기본 설정을 따른다.
8. 그다음 주소 바꾸기(`tools/set-domain.mjs`)·Worker·Google·Kakao·Toss 작업은 [MIGRATION.md](MIGRATION.md) 3~4절을 따른다. `set-domain`은 `_headers`의 CSP를 바꾸므로 **7절도 한다.**

## 7. `_headers`가 바뀌면 다시 apply (중요)

CloudFront의 보안 헤더는 apply할 때 `_headers`에서 읽어 굳는다. `_headers`가 바뀌는 경우: `set-domain` 실행, importmap 변경으로 `script-src` 해시 갱신, 새 외부 주소 추가.

1. `_headers`를 바꾼 커밋을 main에 머지하기 **전에**, 그 커밋을 받은 상태에서:
   ```powershell
   terraform -chdir=infra/aws/static plan -out=static.tfplan    # "1 to change"(응답 헤더 정책)만 있어야 한다
   terraform -chdir=infra/aws/static apply static.tfplan
   ```
2. 그다음 머지한다. 순서를 잊어도 배포 워크플로의 "Check live headers before upload" 단계가 헤더가 다른 것을 보고 **업로드 전에 멈춘다**(사이트는 옛 파일 그대로 안전). 그때 1을 하고 Actions에서 그 실행을 **Re-run**한다.
3. 새 CSP가 옛 파일에도 맞는지(새 주소를 더하기만 했는지) 확인한다. `--keep-old`로 시작하면 더하기만 한다.

## 8. GitHub Pages 유지

[MIGRATION.md](MIGRATION.md) 5절 그대로다. 요약:

- GitHub Pages와 옛 주소 `https://jungmk0720.github.io/skala-fps/`는 **지우지 않는다.** 사용자의 기기 토큰(localStorage)은 새 주소로 자동으로 안 넘어가므로, 옛 주소에서 구글/카카오 계정을 연결할 시간을 준다.
- 옛 주소에는 "게임 주소가 바뀌었습니다. 옮기기 전에 이곳에서 계정을 연결하세요" 안내와 새 주소 링크만 둔다. 강제 리디렉션은 하지 않는다.
- 병행 기간 동안 Google·Kakao 콘솔의 옛 주소 URI와 Worker의 github.io Origin을 남긴다(`set-domain --keep-old`).

## 9. 실패 시 표

| 증상 | 원인 | 할 일 |
|---|---|---|
| `terraform`·`aws`를 찾을 수 없음 | 설치 뒤 창을 새로 안 열었다 | PowerShell을 닫고 다시 연다. 그래도 안 되면 3절 1번 다시 |
| `Error: No valid credential sources found`, `ExpiredToken` | 로그인이 안 됐거나 만료 | `aws sso login --profile skala` 후 `$env:AWS_PROFILE = 'skala'` |
| `EntityAlreadyExists: Provider with url https://token.actions.githubusercontent.com already exists` | 계정에 GitHub OIDC 공급자가 이미 있다 | IAM → Identity providers에서 ARN을 복사해 `terraform.tfvars`에 `github_oidc_provider_arn = "arn:aws:iam::…"`를 넣고 다시 plan/apply |
| plan에 `to destroy`가 1 이상 | 변수를 잘못 바꿨거나 다른 폴더에서 실행 | **apply하지 않는다.** `-chdir=infra/aws/static`인지, `terraform.tfvars` 값이 맞는지 본다 |
| apply가 인증서 확인에서 오래 멈춤(최대 75분) | 검증 CNAME이 없거나 프록시가 켜졌다 | Cloudflare에서 6절 3번 레코드가 있고 **회색 구름**인지 본다. Ctrl+C로 멈췄다면 고친 뒤 다시 apply |
| `CNAMEAlreadyExists` | 그 도메인이 다른 CloudFront에 붙어 있다 | 다른 배포(예: 예전 시험)에서 도메인을 뗀 뒤 다시 apply |
| 워크플로가 "skipped" notice만 남김 | 저장소 변수 넷 중 빠진 것이 있다 | 5절 1번. 이름 철자 확인 |
| `Both AWS_STATIC_BUCKET and CLOUDFLARE_PAGES_PROJECT are set` | 두 배포를 함께 켰다 | 쓰지 않을 쪽 변수를 지운다(2절 표) |
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | main이 아닌 브랜치에서 돌렸거나, 저장소 이름이 다르거나, `environment:`를 붙였다 | main에서 돌린다. 저장소 이름을 바꿨다면 `repo_url`을 고쳐 apply |
| `AccessDenied`(s3 sync) | 버킷 이름 변수가 다른 버킷을 가리킨다 | `AWS_STATIC_BUCKET`을 출력 값과 같게 |
| "응답 헤더가 _headers와 다릅니다" | `_headers`를 바꾸고 apply를 안 했다 | 7절 |
| 사이트에서 `AccessDenied` XML | 아직 배포 전이거나 없는 파일 주소 | 5절 2번 배포. 주소 끝 경로 확인(`/privacy`가 아니라 `/privacy.html`) |
| 브라우저 콘솔에 CSP 오류 | 헤더 CSP에 없는 외부 주소를 쓴다 | `_headers`·`index.html`의 CSP를 함께 고치고(`npm run check`가 둘이 같은지 본다) 7절 |
| 새로 배포했는데 옛 화면 | 브라우저 캐시 또는 캐시 비우기 진행 중 | 1~2분 뒤 새로고침. 폰트·모델·음원은 1년 캐시라 **내용을 바꾸면 파일 이름도 바꾼다** |

## 10. 되돌리기

- **잘못된 배포 하나 되돌리기**: main에서 그 커밋을 `git revert`해 올리면 워크플로가 이전 파일로 다시 배포한다. 급하면 S3 콘솔 → 버킷 → 파일 → **Versions**에서 이전 버전을 고른다(옛 버전은 30일 보관, 변수 `old_version_days`).
- **AWS 사이트를 아예 쓰지 않기**: Cloudflare DNS의 사이트 CNAME을 지우고 사용자에게 GitHub Pages 주소를 안내한다(Pages는 계속 살아 있다). GitHub 변수 `AWS_STATIC_BUCKET`을 지우면 배포도 멈춘다.
- **자원 지우기**: S3 콘솔에서 버킷을 **Empty**(옛 버전까지 비움)한 뒤
  ```powershell
  terraform -chdir=infra/aws/static plan -destroy
  terraform -chdir=infra/aws/static destroy
  ```
  Cloudflare의 검증 CNAME·사이트 CNAME도 지운다. 게임 서버(`infra/aws`)는 따로라 영향이 없다. Supabase·Worker는 건드리지 않는다.
