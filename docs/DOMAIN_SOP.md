<!--
  Date: 06NOV2026
  Author: Minkyu Jung
  Purpose: 소유자 도메인 minkyulabs.com의 하위 주소로 게임을 다시 여는 절차(SOP). 오늘 바로 되는 Cloudflare 길(1단계)과 뒤에 AWS로 바꾸는 길(2단계), 용어, 값 지도, 단계별 명령·확인, 실패 표, 되돌리기.
-->
# minkyulabs.com으로 게임 다시 열기 (SOP)

## 0. 한눈에

| 항목 | 내용 |
|---|---|
| 왜 | 옛 주소 jungmk0720.github.io가 계정 정지로 2026-11-24부터 404. 소유자 도메인 minkyulabs.com이 이미 Cloudflare(이 PC의 wrangler와 같은 계정)에 있다 |
| 건드리지 않는 것 | `minkyulabs.com` 자체(스튜디오 사이트, Worker `minkyulabs`)와 메일 라우팅(MX) |
| 새 주소 | 게임 `warhop.minkyulabs.com`, API `warhop-api.minkyulabs.com`, 중계 `warhop-relay.minkyulabs.com`, 나중 EC2 `warhop-game.minkyulabs.com` |
| 왜 `warhop-api`처럼 한 단계인가 | Cloudflare 무료 인증서는 `*.minkyulabs.com` 한 단계만 덮는다. `api.warhop.minkyulabs.com`처럼 두 단계면 HTTPS가 깨진다 |
| 코드 | 브랜치 `feature/minkyulabs-domain`(2026-11-27, `tools/set-domain.mjs --keep-old`로 만듦, 시험 통과). 옛 workers.dev 주소도 계속 허용한다 |
| 1단계 (오늘) | 정적 파일 Cloudflare Pages, Worker 두 개 그대로. 약 30분, 비용 0원 |
| 2단계 (나중) | `warhop` DNS만 CloudFront로 돌리고 `warhop-game`을 EC2에 연결 (`docs/ORG_AWS_SOP.md`) |

## 1. 용어 풀이

| 말 | 뜻 |
|---|---|
| 하위 주소(서브도메인) | `warhop.minkyulabs.com`처럼 내 도메인 앞에 이름을 붙인 주소. 따로 살 필요 없다 |
| 맞춤 도메인(Custom domain) | Worker나 Pages에 내 주소를 붙이는 Cloudflare 기능. DNS 기록과 인증서를 Cloudflare가 알아서 만든다 |
| Pages | 정적 파일(HTML·JS·이미지)을 올려 두는 Cloudflare 서비스. 무료 |
| ALLOWED_ORIGINS | Worker가 "이 주소에서 온 요청만 받는다"고 정한 목록. 새 게임 주소를 넣고 **Worker를 다시 배포해야** 적용된다 |
| 리디렉션 URI | 구글·카카오 로그인이 끝난 뒤 돌아올 주소. 콘솔에 글자 그대로 등록해야 한다 |
| DNS only(회색 구름) | Cloudflare가 중간에서 프록시하지 않고 IP만 알려 주는 모드. EC2 게임 서버에 쓴다 |

## 2. 값 지도

| 값 | 어디 | 값 |
|---|---|---|
| Cloudflare 계정 ID | `npx wrangler whoami` | `3aff38477b2f1e9cb5c359b99f5999f9` (비밀 아님) |
| Pages 프로젝트 이름 | 새로 만든다 | `warhop` |
| 게임 주소 | Pages 맞춤 도메인 | `https://warhop.minkyulabs.com/` |
| API 주소 | Worker `skala-api` 맞춤 도메인, `js/config.js` | `https://warhop-api.minkyulabs.com` |
| 중계 주소 | Worker `skala-relay` 맞춤 도메인, `js/config.js` | `https://warhop-relay.minkyulabs.com` |
| 운영자 공지 패널 | 배포 뒤 | `https://warhop.minkyulabs.com/dev/notice.html` |
| 토스 웹훅 | 토스 개발자센터 | `https://warhop-api.minkyulabs.com/pay/webhook` |

## 3. 체크리스트 (순서 중요: 주소를 먼저 붙이고 게임을 나중에 올린다)

- [ ] 1. Worker 두 개에 맞춤 도메인 붙이기 (대시보드, 5분)
- [ ] 2. 코드 브랜치 받기
- [ ] 3. Worker 두 개 다시 배포 (새 게임 주소 허용)
- [ ] 4. Pages 프로젝트 만들고 게임 올리기
- [ ] 5. Pages에 `warhop.minkyulabs.com` 붙이기
- [ ] 6. 구글·카카오·토스 주소 바꾸기
- [ ] 7. 두 기기로 한 판 해 보기
- [ ] 8. GitHub Actions 자동 배포 연결 (선택)
- [ ] 9. 공지 보내기

## 4. 단계별

### 4.1 Worker 두 개에 새 주소 붙이기 (브라우저, 5분)

**A. API Worker**

1. 브라우저 주소창에 아래를 붙여 넣고 엔터. (Cloudflare 로그인 화면이 나오면 k5until30@naver.com 계정으로 로그인)
   `https://dash.cloudflare.com/3aff38477b2f1e9cb5c359b99f5999f9/workers-and-pages`
2. 목록에서 **skala-api**를 누른다.
3. 위쪽 탭에서 **Settings**(설정)를 누른다.
4. **Domains & Routes**(도메인 및 경로) 칸 오른쪽의 **+ Add**(추가)를 누른다.
5. 오른쪽에 창이 열리면 **Custom domain**(사용자 지정 도메인)을 고른다.
6. 입력칸에 `warhop-api.minkyulabs.com`을 쓰고 **Add domain**(도메인 추가)을 누른다.
7. 목록에 `warhop-api.minkyulabs.com`이 생기면 끝. 처음엔 "Initializing"·"Pending"으로 보이다가 몇 분 뒤 "Active"가 된다.

**B. 중계 Worker**

1. 다시 `https://dash.cloudflare.com/3aff38477b2f1e9cb5c359b99f5999f9/workers-and-pages`
2. **skala-relay** → **Settings** → **Domains & Routes** → **+ Add** → **Custom domain**
3. `warhop-relay.minkyulabs.com` 입력 → **Add domain**

**C. 확인** (2~5분 뒤): 브라우저 새 탭에 아래 두 주소를 하나씩 연다.

- `https://warhop-api.minkyulabs.com/health` → 화면에 `{"ok":true,"service":"skala-api"}`
- `https://warhop-relay.minkyulabs.com/health` → 화면에 `{"ok":true}` 비슷한 글

인증서 오류 화면이 나오면 5~10분 더 기다렸다 새로고침. 지금 돌아가는 옛 `workers.dev` 주소는 그대로라 이 단계로 깨지는 것은 없다.

### 4.2 터미널 열기와 코드 위치

1. Windows 시작 버튼 → **PowerShell** 실행 (또는 이 앱의 Terminal 패널).
2. 프로젝트 폴더로 이동:

```powershell
cd E:\jobFolder\skala-data\team-project\fps
```

3. 지금 브랜치 확인:

```powershell
git branch --show-current
```

`feature/minkyulabs-domain`이 나오면 그대로 다음 단계. 다른 이름이면:

```powershell
git switch feature/minkyulabs-domain
```

### 4.3 Worker 다시 배포 (터미널, 3분)

새 게임 주소를 허용 목록에 넣으려면 Worker를 다시 올려야 한다. 비밀 값(secret)은 그대로 남는다.

```powershell
cd server/api; npx wrangler deploy; cd ../..
```

성공: 끝부분에 `Deployed skala-api triggers`와 `https://skala-api.skala-fps.workers.dev`, `warhop-api.minkyulabs.com`이 보인다.

```powershell
cd server/relay; npx wrangler deploy; cd ../..
```

성공: `Deployed skala-relay triggers`.

브라우저 창이 열리며 Cloudflare 로그인을 물으면 **Allow**(허용)를 누른다. 배포 뒤 이상하면 그 폴더에서 `npx wrangler rollback` 한 줄로 바로 전 버전으로 돌아간다.

### 4.4 게임 파일 올리기 (터미널, 5분)

```powershell
node tools/build-site.mjs
```

성공: `dist/ 배포 파일: index.html, ...` 한 줄.

```powershell
npx wrangler pages project create warhop --production-branch main
```

성공: `Successfully created the 'warhop' project`. ("already exists"면 이미 만든 것이니 넘어간다.)

```powershell
npx wrangler pages deploy dist --project-name warhop --branch main
```

성공: 마지막 줄에 `https://xxxxxxxx.warhop.pages.dev` 주소. 그 주소를 브라우저로 열어 게임 메뉴가 뜨는지 본다.

### 4.5 게임에 warhop.minkyulabs.com 붙이기 (브라우저, 3분)

1. `https://dash.cloudflare.com/3aff38477b2f1e9cb5c359b99f5999f9/workers-and-pages`
2. 목록에서 **warhop**(Pages 프로젝트, 방금 만든 것)을 누른다.
3. 위쪽 탭 **Custom domains**(사용자 지정 도메인) → **Set up a custom domain**(사용자 지정 도메인 설정).
4. `warhop.minkyulabs.com` 입력 → **Continue**(계속).
5. 다음 화면에서 DNS 기록을 자동으로 만들겠다고 나오면 **Activate domain**(도메인 활성화).
6. 상태가 "Active"가 되면 `https://warhop.minkyulabs.com/`을 연다. 게임 메뉴가 뜨면 성공.

### 4.6 로그인·결제에 새 주소 등록 (브라우저, 10분)

**A. 구글 로그인**

1. `https://console.cloud.google.com/apis/credentials` (게임용 구글 계정으로 로그인, 위쪽 프로젝트 이름이 게임 프로젝트인지 확인)
2. **OAuth 2.0 클라이언트 ID** 목록에서 게임용 클라이언트(웹 애플리케이션) 이름을 누른다.
3. **승인된 JavaScript 원본** → **+ URI 추가** → `https://warhop.minkyulabs.com` (끝에 `/` 없음)
4. **승인된 리디렉션 URI** → **+ URI 추가** → `https://warhop.minkyulabs.com/` (끝에 `/` 있음)
5. 맨 아래 **저장**. 반영에 5분~몇 시간 걸릴 수 있다.

**B. 카카오 로그인**

1. `https://developers.kakao.com/console/app` → 게임 앱 선택
2. 왼쪽 **앱 설정 → 플랫폼** → **Web** 칸의 **수정**(또는 **사이트 도메인 등록**) → 새 줄에 `https://warhop.minkyulabs.com` → **저장**
3. 왼쪽 **제품 설정 → 카카오 로그인** → 아래 **Redirect URI** → **수정**(또는 **등록**) → 새 줄에 `https://warhop.minkyulabs.com/` → **저장**

(콘솔 메뉴 이름은 카카오가 가끔 바꾼다. 못 찾으면 페이지에서 "Redirect URI"를 Ctrl+F로 찾는다.)

**C. 토스 결제 웹훅**

1. `https://developers.tosspayments.com` → 로그인 → 위쪽 **개발자센터** → 왼쪽 **웹훅**
2. **웹훅 등록하기** → 이름 `warhop`, URL `https://warhop-api.minkyulabs.com/pay/webhook`, 이벤트 **PAYMENT_STATUS_CHANGED** 체크 → **등록**

### 4.7 확인

- 두 기기(PC·휴대폰)로 `https://warhop.minkyulabs.com/` 접속 → 같은 방에서 한 판.
- 구글 또는 카카오로 로그인 → 포인트·상점이 보이는지.
- 실패하면 브라우저 F12 → Console에 빨간 줄이 있는지 보고 8절 표.

### 4.8 자동 배포 (선택)

Warhop-fps/app → Settings → Secrets and variables → Actions:
- Secrets: `CLOUDFLARE_API_TOKEN`(대시보드 → My Profile → API Tokens → "Edit Cloudflare Workers" 템플릿, Pages 권한 포함), `CLOUDFLARE_ACCOUNT_ID` = 2절 값
- Variables: `CLOUDFLARE_PAGES_PROJECT` = `warhop`

이후 main에 머지할 때마다 `.github/workflows/deploy-pages.yml`이 자동으로 올린다.

### 4.9 공지

운영자 패널 `https://warhop.minkyulabs.com/dev/notice.html`에서 "새 주소: warhop.minkyulabs.com" 공지를 보낸다(`docs/NOTICE.md`). **옛 주소의 브라우저 저장소(기기 토큰)는 넘어오지 않는다.** 구글·카카오를 연결한 사람은 다시 로그인하면 그대로이고, 연결 안 한 사람은 진행 상황이 새로 시작된다.

## 5. 2단계: AWS로 바꿀 때

1. `docs/AWS_STATIC_SOP.md`대로 CloudFront + S3를 만들고, 인증서는 `warhop.minkyulabs.com`으로 받는다.
2. Pages 맞춤 도메인에서 `warhop.minkyulabs.com`을 빼고, DNS에 `warhop` CNAME → CloudFront 주소를 넣는다. 주소가 그대로라 사용자도 OAuth도 바꿀 것이 없다.
3. 게임 서버 EC2를 만든 뒤 DNS에 `warhop-game` A → EIP, **DNS only(회색 구름)**.

## 6. 비용

1단계는 0원이다(Pages·Worker 무료 구간, 도메인은 이미 보유). 2단계 비용은 `docs/ORG_AWS_SOP.md` 7절.

## 7. 되돌리기

- 게임: Pages → `warhop` → Deployments → 이전 배포 → **Rollback**.
- Worker: 그 폴더에서 `npx wrangler rollback`.
- 주소 자체를 접으려면 Pages·Worker의 맞춤 도메인을 지운다. 스튜디오 사이트(`minkyulabs.com`)에는 영향이 없다.

## 8. 실패 표

| 증상 | 원인 | 할 일 |
|---|---|---|
| Custom domain 추가 시 "record already exists" | 같은 이름의 DNS 기록이 있음 | DNS → Records에서 그 이름을 지우고 다시 |
| `warhop-api.../health`가 SSL 오류 | 인증서 발급 중 | 5~10분 기다림 |
| 게임은 뜨는데 Console에 `CORS`·`403 origin` | Worker를 다시 배포 안 함(옛 ALLOWED_ORIGINS) | 4.3 다시 |
| Console에 `Content Security Policy`·`connect-src` | 브랜치를 안 받고 main으로 빌드함 | 4.2 확인 뒤 4.4 다시 |
| 구글 로그인 `redirect_uri_mismatch` | 콘솔에 주소가 글자 그대로 없음(끝의 `/`까지) | 4.6 |
| `wrangler pages project create`가 "already exists" | 이미 만든 적 있음 | 그 단계는 건너뛰고 deploy만 |
| `Authentication error` | wrangler 로그인 만료 | `npx wrangler login` |
