<!--
  Date: 06NOV2026
  Author: Minkyu Jung
  Purpose: 정지된 개인 계정의 저장소를 GitHub 조직 Warhop-fps/app으로 옮기고, 그 위에서 AWS(CloudFront+S3, EC2 서울)로 출발하는 절차(SOP). 용어 풀이, 값 지도, 단계별 명령·확인, 실패 표, 예상 비용.
-->
# GitHub 조직 이전 → AWS 출발 (SOP)

## 0. 한눈에

| 항목 | 내용 |
|---|---|
| 왜 | 2026-11-24 개인 계정(JungMK0720)이 정지돼 저장소·GitHub Pages 게임이 404. 복구 요청은 제출했지만 답이 없다 |
| 새 집 | 조직 **Warhop-fps**, 저장소 **Warhop-fps/app**(공개). 부계정 `minkyu-k530`이 조직 관리자(admin) |
| 다음 집 | 정적 파일 CloudFront + S3, 게임 서버 EC2 서울(t4g.small), 로그인·결제 API는 Cloudflare Worker `skala-api` 유지, DB는 Supabase 유지 |
| 이미 한 일 | 2026-11-27: main·작업 브랜치를 조직 저장소에 올림(4절), 코드 속 옛 저장소 주소 2곳을 새 주소로 바꿈(`chore/warhop-org`) |
| 소유자 몫 | 조직 보안 설정(5절), AWS 로그인·지원금 확인·terraform 실행(6절), DNS·OAuth 주소 바꾸기 |

## 1. 용어 풀이

| 말 | 뜻 |
|---|---|
| 조직(Organization) | 여러 사람이 함께 쓰는 GitHub 공간. 계정 하나가 정지돼도 다른 관리자가 있으면 저장소가 살아 있다 |
| remote(원격) | 내 PC의 git이 "어디로 올리고 받을지" 기억하는 주소. 지금 `origin`은 새 조직, `old-origin`은 정지된 옛 저장소 |
| 브랜치 보호 | main에 바로 push 못 하게 하고 PR로만 합치게 하는 규칙. 11-20 포인트 사고(직푸시)를 막는다 |
| Actions secret / variable | GitHub Actions가 배포할 때 쓰는 값. 비밀은 secret, 공개 값은 variable |
| OIDC | GitHub Actions가 AWS 비밀 키 없이 "이 저장소에서 왔다"는 증명으로 AWS에 들어가는 방식. **저장소 이름이 바뀌면 AWS 쪽 신뢰 조건도 바꿔야 한다** |
| egress(송신) | AWS에서 인터넷으로 나가는 데이터. 게임 서버 비용의 대부분 |

## 2. 값 지도

| 값 | 어디에 | 지금 값 |
|---|---|---|
| 저장소 주소 | `git remote -v`, `infra/aws/variables.tf`의 `repo_url` | `https://github.com/Warhop-fps/app.git` |
| 문의 링크 | `privacy.html` | `https://github.com/Warhop-fps/app/issues` |
| 옛 게임 주소 | `README.md`, Worker `ALLOWED_ORIGINS`, 구글·카카오 리디렉션 | `https://jungmk0720.github.io/skala-fps/`(지금 404) |
| 새 게임 주소 | 도메인을 산 뒤 `node tools/set-domain.mjs --domain <도메인> --keep-old` | 미정 |
| AWS 리전 | terraform | 서울 `ap-northeast-2` |
| Worker 두 개 | Cloudflare | `skala-relay`, `skala-api` (정상 동작 중) |

## 3. 순서 (체크리스트)

- [x] 1. 조직 만들기, 부계정을 관리자로 (소유자, 완료)
- [x] 2. 코드 올리기: main + 진행 중 브랜치 (2026-11-27)
- [ ] 3. 조직 보안 설정 (5절, 소유자 10분)
- [ ] 4. `chore/warhop-org` PR 머지
- [ ] 5. 밤샘 브랜치 A→B→F→C→D→E→G1→G2 순서로 PR·머지 (한 번에 하나씩)
- [ ] 6. AWS: 로그인 → 지원금 확인 → 예산 알림 → 정적 사이트 → 게임 서버 (6절)
- [ ] 7. 도메인 사기 → `set-domain.mjs` → Worker 재배포 → OAuth 리디렉션 바꾸기
- [ ] 8. 사용자에게 새 주소 공지 (운영자 패널 공지, 소유자가 보냄)

## 4. 코드 올리기 (2026-11-27에 한 일, 다시 할 때 참고)

이 PC의 git 자격 증명 관리자에 부계정 `minkyu-k530` 로그인이 이미 있다.

```powershell
git remote rename origin old-origin
git remote add origin https://github.com/Warhop-fps/app.git
git push origin main
```

브랜치는 **한 번에 하나씩, 사이를 두고** 올렸다. 계정 정지 원인으로 "짧은 시간의 대량 브랜치·푸시·PR 자동화"를 의심하고 있으니 새 계정에서 같은 일을 하지 않는다. 이미 main에 합쳐진 옛 브랜치 100여 개는 올리지 않았다(기록은 main에 다 있다). 브랜치 이름에 AI 도구 이름이 들어간 것도 올리지 않았다.

확인:

```powershell
git ls-remote --heads origin
```

성공: `refs/heads/main`과 올린 브랜치 이름들이 나온다.

## 5. 조직 보안 설정 (소유자가 브라우저에서)

github.com/organizations/Warhop-fps/settings 에서:

1. **Authentication security → Require two-factor authentication** 켜기. 부계정에도 2단계 인증을 먼저 켠다(안 켜면 조직에서 빠진다).
2. **Member privileges → Base permissions: Read**. 팀원은 저장소별로 Write를 준다.
3. **People → Invite member**: 팀원(천성훈 등) 초대. 관리자(Owner)는 부계정 + 믿을 수 있는 한 명 더 → 한 계정이 또 정지돼도 조직이 살아 있다.
4. 저장소 app → **Settings → Rules → Rulesets → New branch ruleset**: 대상 `main`, "Require a pull request before merging", "Block force pushes". 11-20 직푸시 사고를 막는다.
5. **Actions → General**: "Allow all actions" 대신 "Allow GitHub and verified creators" 권장. Workflow permissions는 "Read repository contents".

## 6. AWS로 출발

자세한 단계는 이미 있는 SOP를 그대로 따른다. 조직 이전 때문에 달라지는 곳만 적는다.

| 단계 | 문서 | 조직 이전 때문에 바꿀 것 |
|---|---|---|
| 정적 사이트 CloudFront + S3 | `docs/AWS_STATIC_SOP.md` (브랜치 `feature/aws-static-hosting`) | OIDC 신뢰 조건의 저장소를 `repo:Warhop-fps/app:ref:refs/heads/main`으로. GitHub variable은 **조직 저장소** Settings에 다시 넣는다(옛 저장소 값은 따라오지 않는다) |
| 게임 서버 EC2 서울 | `infra/aws/README.md` | `repo_url` 기본값이 새 주소로 바뀌었다(`chore/warhop-org`). EC2는 공개 저장소에서 코드를 받으므로 저장소를 비공개로 바꾸면 부팅이 실패한다 |
| 블루/그린 배포·SSM | 브랜치 `feature/game-server-deploy` | 위와 같음 |
| Worker 두 개 | `docs/CLOUDFLARE_SOP.md` | 새 게임 주소를 `ALLOWED_ORIGINS`에 넣고 재배포(`set-domain.mjs`가 고쳐 준다) |

## 7. 예상 AWS 비용 (월, 2026-11-27 추정)

환율 $1 = 1,400원. 부가세 제외. 실제 단가는 적용 시점에 [EC2](https://aws.amazon.com/ec2/pricing/on-demand/)·[CloudFront](https://aws.amazon.com/cloudfront/pricing/)·[VPC IPv4](https://aws.amazon.com/vpc/pricing/) 요금표로 확인한다. 지원금이 먼저 빠지지만 만료·소진 뒤에는 카드로 청구된다.

### 고정비 (사람이 없어도 나가는 돈)

| 자원 | 계산 | 월 |
|---|---|---:|
| EC2 t4g.small 서울 | 약 $0.0208/시간 × 730 | 약 $15.2 |
| 공인 IPv4 1개(EIP) | $0.005/시간 × 730 | $3.65 |
| EBS gp3 12 GB | 약 $0.0912/GB | 약 $1.1 |
| S3 (사이트 약 12 MB) | GB당 약 $0.025 | $0.01 미만 |
| CloudFront | 매달 1 TB·요청 1천만 건 무료 구간 | $0 |
| CloudWatch 경보 2개·SNS 메일·Budgets 2개 | 무료 구간 안 | $0 |
| ACM 인증서·SSM 접속 | 무료 | $0 |
| **고정 합계** | | **약 $20 (약 2.8만 원)** |

### 변동비 (게임 서버 송신)

측정값: 서버 판정 개인전 1인 약 28 KB/s, 좀비 방 1인 약 11 KB/s (2026-11-23 `feature/game-server`·`feature/horde-server`). 계정 전체 매달 100 GB 무료, 그 뒤 서울 약 $0.126/GB.

| 경우 | 하루 평균 동시 접속 | 월 송신 | 송신 비용 | 월 합계 |
|---|---:|---:|---:|---:|
| 지금 (가입자 약 80명) | 1.5명 | 약 110 GB | 약 $1 | **약 $21 (3만 원)** |
| 3배 | 5명 | 약 360 GB | 약 $33 | **약 $53 (7.4만 원)** |
| 10배 | 15명 | 약 1.1 TB | 약 $125 | **약 $145 (20만 원)** — 이때는 t4g.medium·스냅샷 15 Hz 검토 |

- 평균 동시 접속은 "하루 24시간 평균"이다. 저녁에만 몰리면 같은 숫자라도 최고 동시 접속은 몇 배 높다. t4g.small 1대 용량(측정 8방 p95 틱 8.65 ms)은 넉넉하다.
- 전환 기간에는 Cloudflare relay(무료)가 계속 일을 받으므로 실제 송신은 표보다 적다.
- 이 예산 경보는 `infra/aws`의 월 **$40** (50%·80%·100% 메일). 지원금이 있어도 경보는 사라지지 않게 크레딧 제외로 잡혀 있다. **경보는 상한이 아니다.**
- 도메인 구입(연 약 $10~15)은 AWS 밖 비용이다. DNS를 Route 53으로 옮기면 영역당 월 $0.5가 붙는다(지금 계획은 Cloudflare DNS 유지라 0).

## 8. 실패 표

| 증상 | 원인 | 할 일 |
|---|---|---|
| `git push`가 `403`·`Permission denied` | 정지된 옛 계정 자격 증명이 쓰임 | `git credential-manager github list`로 `minkyu-k530`이 있는지 보고, 없으면 `git credential-manager github login` |
| push 중 `refusing to allow an OAuth App to create or update workflow` | 토큰에 workflow 권한 없음 | `gh auth login`을 부계정으로 다시 하며 workflow 권한 허용 |
| Actions가 AWS에 못 들어감 (`Not authorized to perform sts:AssumeRoleWithWebIdentity`) | OIDC 신뢰 조건이 옛 저장소 이름 | 6절 표대로 `Warhop-fps/app`으로 고치고 terraform apply |
| history-guard 실패 | 옛 클론에서 지운 음원이 섞여 올라옴 | `docs/HISTORY_PURGE.md`. 옛 클론에서 push하지 않는다 |
| 조직에서 내가 빠짐 | 2단계 인증 강제를 켜기 전에 내 계정 2FA를 안 켬 | 먼저 부계정 2FA를 켜고 다시 초대받는다 |

## 9. 되돌리기

조직 저장소는 사본이다. 옛 계정이 복구되면 `git remote rename old-origin origin`으로 되돌릴 수 있다. 다만 두 곳에 따로 push하면 갈라지므로, 복구되더라도 **조직 저장소를 정본으로 두고** 옛 저장소는 보관(Archive)하는 것을 권한다.
