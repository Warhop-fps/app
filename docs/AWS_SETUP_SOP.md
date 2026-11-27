<!--
  Date: 06NOV2026
  Author: Minkyu Jung
  Purpose: AWS를 처음 쓰기 전 준비(SOP). 공식 설치 파일만 받는 법(winget), 루트 계정 보호, IAM Identity Center 사용자 만들기, 이 PC에서 AWS 로그인, 지원금·예산 확인. 클릭 위치와 성공 확인, 실패 표.
-->
# AWS 준비: 도구 설치 → 로그인 → 지원금 확인 (SOP)

이 문서를 끝내면 다음 문서(`infra/aws/README.md` 게임 서버, `docs/AWS_STATIC_SOP.md` 정적 사이트)를 바로 시작할 수 있다. 약 40분.

## 0. 용어

| 말 | 뜻 |
|---|---|
| AWS CLI | 터미널에서 AWS를 다루는 공식 프로그램 (`aws ...` 명령) |
| Terraform | 서버·네트워크를 글(.tf)로 적어 두고 그대로 만들어 주는 프로그램 |
| Session Manager 플러그인 | 22번 포트를 열지 않고 EC2에 들어가는 공식 도구 |
| winget | Windows에 들어 있는 공식 설치 관리자. 게시자 주소에서 받고 **SHA256(파일 지문)을 대조**한 뒤 설치한다 |
| 루트 계정 | AWS 가입에 쓴 이메일 계정. 모든 권한이 있어 평소에는 쓰지 않는다 |
| IAM Identity Center | 평소에 쓸 사용자를 만드는 곳. 이 PC의 로그인(`aws sso login`)도 이걸로 한다 |

## 1. 설치 (PowerShell, 5분)

악성 코드 걱정 없이 받는 가장 쉬운 길은 winget이다. 아래 세 파일은 모두 **만든 회사의 공식 주소**이고, winget이 받은 파일의 지문(SHA256)을 확인한 뒤에만 설치한다. 검색 사이트에서 "aws cli 다운로드"로 찾은 다른 사이트 파일은 받지 않는다.

| 프로그램 | winget id | 받는 주소 (공식) | 크기 |
|---|---|---|---|
| AWS CLI 2.42.4 | `Amazon.AWSCLI` | awscli.amazonaws.com | 49.3 MB |
| Terraform 1.17.2 | `Hashicorp.Terraform` | releases.hashicorp.com | 36.9 MB |
| Session Manager 플러그인 1.2.896.0 | `Amazon.SessionManagerPlugin` | s3.amazonaws.com/session-manager-downloads | 8.5 MB |

(버전·크기는 2026-11-27 기준. winget은 그때의 최신을 받는다.)

1. 시작 → **PowerShell** 실행.
2. 한 줄씩 입력한다. 중간에 "이 앱이 디바이스를 변경하도록 허용하시겠어요?" 창이 뜨면 게시자가 **Amazon Web Services** 또는 **HashiCorp**인지 보고 **예**.

```powershell
winget install --id Amazon.AWSCLI -e
```

```powershell
winget install --id Hashicorp.Terraform -e
```

```powershell
winget install --id Amazon.SessionManagerPlugin -e
```

성공: 각 명령 끝에 `설치 성공`(Successfully installed).

3. **PowerShell 창을 닫고 새로 연다**(새 프로그램 경로를 읽으려고). 확인:

```powershell
aws --version
```

```powershell
terraform -version
```

```powershell
session-manager-plugin
```

성공: `aws-cli/2.x`, `Terraform v1.x`(1.9 이상 2.0 미만), 플러그인은 "The Session Manager plugin was installed successfully" 문장.

## 2. 루트 계정 보호 (브라우저, 5분)

1. `https://console.aws.amazon.com/` → **루트 사용자** 선택 → 가입 이메일·비밀번호로 로그인.
2. 오른쪽 위 계정 이름 → **보안 자격 증명**(Security credentials).
3. **멀티 팩터 인증(MFA)** → **MFA 디바이스 할당** → 이름 `root-phone`, **인증 관리자 앱** → 휴대폰 앱(Google Authenticator 등)으로 QR 찍고 코드 두 번 입력 → **MFA 추가**.
4. 같은 화면 **액세스 키**에 키가 하나라도 있으면 **삭제**. 루트 액세스 키는 만들지 않는다.

## 3. 평소에 쓸 사용자 만들기 (브라우저, 15분)

1. 콘솔 위쪽 지역(리전)을 **아시아 태평양(서울) ap-northeast-2**로 바꾼다.
2. 위쪽 검색창에 `IAM Identity Center` → 들어가서 **활성화**(Enable). "AWS Organizations로 활성화"를 묻으면 그대로 **계속**.
3. 왼쪽 **사용자**(Users) → **사용자 추가** → 사용자 이름 `minkyu`, 이메일(평소 쓰는 메일), 이름·성 → **다음** → 그룹은 건너뛰고 **다음** → **사용자 추가**.
4. 그 메일함에 온 초대 메일 → **Accept invitation** → 비밀번호 정하기 → MFA 등록(휴대폰 앱).
5. 다시 콘솔 IAM Identity Center → 왼쪽 **권한 세트**(Permission sets) → **권한 세트 생성** → **사전 정의된 권한 세트** → `AdministratorAccess` → **다음** → 세션 기간 `8시간` → **다음** → **생성**.
6. 왼쪽 **AWS 계정**(AWS accounts) → 내 계정에 체크 → **사용자 또는 그룹 할당** → **사용자** 탭에서 `minkyu` 체크 → **다음** → `AdministratorAccess` 체크 → **다음** → **제출**.
7. 왼쪽 **대시보드**(Dashboard) 오른쪽의 **AWS 액세스 포털 URL**(`https://d-xxxxxxxxxx.awsapps.com/start` 모양)을 메모한다. 비밀은 아니다.

(메뉴 이름은 AWS가 가끔 바꾼다. 못 찾으면 그 페이지에서 Ctrl+F로 영어 이름을 찾는다.)

## 4. 이 PC에서 AWS 로그인 (PowerShell, 5분)

```powershell
aws configure sso
```

묻는 순서대로 답한다:

| 질문 | 답 |
|---|---|
| SSO session name | `skala` |
| SSO start URL | 3-7에서 메모한 포털 URL |
| SSO region | `ap-northeast-2` |
| SSO registration scopes | 그냥 엔터 |

브라우저가 열리면 `minkyu`로 로그인 → **Allow access**(허용). 터미널로 돌아와서:

| 질문 | 답 |
|---|---|
| (계정이 하나면 자동 선택) | — |
| CLI default client Region | `ap-northeast-2` |
| CLI default output format | `json` |
| CLI profile name | `skala` |

확인:

```powershell
$env:AWS_PROFILE = 'skala'; aws sts get-caller-identity
```

성공: `"Account": "1234..."`, `"Arn": "...AWSReservedSSO_AdministratorAccess.../minkyu"`.

다음부터는 PowerShell을 열 때마다 이 두 줄이면 된다(8시간마다 다시):

```powershell
aws sso login --profile skala
```

```powershell
$env:AWS_PROFILE = 'skala'
```

## 5. 지원금·예산 확인 (브라우저, 5분)

1. 콘솔 오른쪽 위 계정 이름 → **결제 및 비용 관리**(Billing and Cost Management) → 왼쪽 **크레딧**(Credits).
   금액, **만료일**, **적용 서비스**(EC2·CloudFront·S3가 들어가는지)를 적어 둔다.
2. 왼쪽 **예산**(Budgets)은 아직 만들지 않는다. 게임 서버 terraform이 월 $40 경보를 같이 만든다(두 번 만들면 메일이 두 번 온다).
3. 왼쪽 **결제 기본 설정**(Billing preferences) → **무료 티어 사용 알림**·**PDF 인보이스 이메일** 켜기.

## 6. 다음

여기까지 되면 `infra/aws/README.md`의 "생성"부터. 게임 서버 주소는 `warhop-game.minkyulabs.com`(`docs/DOMAIN_SOP.md` 5절). 막히면 화면을 캡처해 묻는다.

## 7. 실패 표

| 증상 | 원인 | 할 일 |
|---|---|---|
| `winget`을 찾을 수 없음 | 앱 설치 관리자가 오래됨 | Microsoft Store에서 **앱 설치 관리자** 업데이트 |
| 설치 뒤 `aws`를 찾을 수 없음 | 창을 새로 안 엶 | PowerShell 닫고 새로 열기 |
| `Installer hash does not match` | 받는 도중 파일이 바뀜(또는 게시자가 막 새 버전을 냄) | **설치하지 말고** 몇 시간 뒤 다시. 해시 무시 옵션은 쓰지 않는다 |
| `aws configure sso`에서 `InvalidRequestException` | 포털 URL·리전이 틀림 | 3-7의 URL, Identity Center를 켠 리전 다시 확인 |
| `Token has expired` / `ExpiredToken` | 8시간 지남 | `aws sso login --profile skala` |
| `Unable to locate credentials` | 새 창에서 프로필을 안 정함 | `$env:AWS_PROFILE = 'skala'` |
