<!--
  Date: 06NOV2026
  Author: Minkyu Jung
  Purpose: 경기 결과 서명 값(GAME_RESULT_SECRET)을 처음 만들어 API Worker와 AWS SSM에 넣는 절차, 그리고 바꾸는(교체) 절차(SOP).
           용어 풀이, 값 지도, 단계별 명령과 성공 모습, 실패 시 표. 약속 자체는 docs/MATCH_RESULT_CONTRACT.md.
-->
# 경기 결과 서명 값 넣기·바꾸기 (SOP)

게임 서버(EC2)가 경기 결과에 서명하고, API Worker가 그 서명을 확인한 뒤에만 포인트를 더한다. 두 쪽이 **같은 비밀 값**을 가져야 한다.
이 값이 새면 누구든 포인트를 만들어 낼 수 있으니 **채팅·저장소·스크린샷에 남기지 않는다.**

## 1. 용어 풀이

| 말 | 뜻 |
|---|---|
| 비밀 값(secret) | 서명에 쓰는 긴 무작위 글자. 32글자 이상. 이 문서에서는 `GAME_RESULT_SECRET` |
| 서명(HMAC) | 비밀 값으로 결과 글자에 붙이는 도장. 글자가 한 개라도 바뀌면 도장이 안 맞는다 |
| `kid`(열쇠 번호) | 비밀 값에서 저절로 나오는 짧은 번호. 어떤 값으로 서명했는지 알려 준다. 따로 설정하지 않는다 |
| wrangler secret | Cloudflare Worker에 비밀 값을 넣는 명령. 넣은 값은 다시 볼 수 없고, 바로 Worker에 반영된다 |
| AWS SSM Parameter Store | AWS의 설정 값 보관함. 게임 서버가 켜질 때 여기서 비밀 값을 읽는다. `SecureString`은 암호화해 보관한다는 뜻 |
| 교체(rotation) | 비밀 값을 새 값으로 바꾸는 것. 잠깐 동안 Worker가 **옛 값도** 받게 해서 경기 결과가 끊기지 않게 한다 |
| `GAME_RESULT_SECRET_PREV` | 교체하는 동안만 Worker에 두는 옛 값. 하루 뒤 지운다 |

## 2. 값 지도

| 무엇 | 값 / 자리 |
|---|---|
| Worker 이름 | `skala-api` (명령은 `server/api` 폴더에서) |
| Worker 비밀 값 이름 | `GAME_RESULT_SECRET`, 교체 중에만 `GAME_RESULT_SECRET_PREV` |
| SSM 매개변수 이름 | `/skala-fps/game/GAME_RESULT_SECRET` (게임 서버 쪽, `SecureString`) |
| AWS 지역(region) | `ap-northeast-2` (서울, `infra/aws/main.tf`와 같다) |
| 받는 주소 | `https://skala-api.skala-fps.workers.dev/v1/match-result` |
| 값이 없을 때 | 그 주소가 404(닫힘). 게임 서버는 결과를 쌓아 두고 다시 보낸다 |
| 값 만드는 명령 | `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` (43글자) |

## 3. 처음 넣기

> 순서: **0003 SQL 실행**(`docs/DB_MIGRATION_SOP.md` 3-2) → **Worker 배포**(같은 문서 3-3) → 이 절. 값만 먼저 넣어도 망가지지 않는다(SQL이 없으면 503으로 돌려보낸다).

### 3-1. 값 만들기

PowerShell에서:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

성공 모습: `q3Xb…` 같은 43글자 한 줄. **이 창을 닫기 전에** 3-2와 3-3에 같은 값을 넣는다. 메모장에 저장하지 않는다.

### 3-2. Worker에 넣기

```powershell
cd E:\jobFolder\skala-data\team-project\fps\server\api
npx wrangler secret put GAME_RESULT_SECRET
```

`Enter a secret value:`가 나오면 3-1의 값을 붙여 넣고 Enter.
성공 모습: `✨ Success! Uploaded secret GAME_RESULT_SECRET`. 다시 배포할 필요는 없다.

### 3-3. AWS SSM에 넣기

```powershell
aws ssm put-parameter --region ap-northeast-2 --name /skala-fps/game/GAME_RESULT_SECRET --type SecureString --value "<3-1의 값>" --overwrite
```

성공 모습: `{ "Version": 1, "Tier": "Standard" }`. 그 뒤 게임 서버를 다시 켜야 새 값을 읽는다(재시작 방법은 게임 서버 배포 문서).

PowerShell 기록에 값이 남는 것이 싫으면 AWS 콘솔 → Systems Manager → Parameter Store → **Create parameter**에서 이름 `/skala-fps/game/GAME_RESULT_SECRET`, 종류 `SecureString`으로 붙여 넣어도 같다.

### 3-4. 확인

```powershell
curl.exe -s -X POST https://skala-api.skala-fps.workers.dev/v1/match-result -H "content-type: application/json" -d "{}"
```

성공 모습: `{"ok":false,"error":"BAD_REQUEST"}` (주소가 열렸다는 뜻. 404 `not_found`면 값이 안 들어갔다).
게임 서버가 결과를 보내기 시작하면 SQL Editor에서 본다:

```sql
select result_id, mode, map, players, points_total, received_at from public.fps_match_results order by received_at desc limit 20;
```

## 4. 바꾸기 (교체)

값이 샜을지 모를 때, 또는 반년에 한 번. 옛 값으로 서명한 결과도 하루 동안 받으니 게임은 끊기지 않는다.

1. 3-1로 **새 값**을 만든다.
2. Worker에 **옛 값을 PREV로**: `npx wrangler secret put GAME_RESULT_SECRET_PREV` → 지금 쓰는 값(SSM에서 볼 수 있다: `aws ssm get-parameter --region ap-northeast-2 --name /skala-fps/game/GAME_RESULT_SECRET --with-decryption --query Parameter.Value --output text`)을 붙여 넣는다.
3. Worker에 **새 값을**: `npx wrangler secret put GAME_RESULT_SECRET` → 새 값.
4. SSM에 **새 값을**: 3-3 명령을 새 값으로 다시(`--overwrite`). 게임 서버를 다시 켠다.
5. 하루 뒤 옛 값을 지운다: `npx wrangler secret delete GAME_RESULT_SECRET_PREV` → `y`.

> 값이 **샜다**고 확신하면 5번을 하루 기다리지 말고 바로 한다(그동안 쌓인 결과 몇 개가 401로 버려질 수 있다. 포인트가 몰래 생기는 것보다 낫다).
> 샌 값으로 이미 들어온 결과는 `fps_match_points`에서 찾을 수 있다(`docs/POINTS_SOP.md`로 되돌린다).

## 5. 실패 시

| 보이는 것 | 뜻 | 할 일 |
|---|---|---|
| 3-4가 404 `not_found` | Worker에 값이 없거나 32글자보다 짧다, 또는 Worker가 옛 코드 | 3-2 다시. 그래도면 `docs/DB_MIGRATION_SOP.md` 3-3(배포) |
| 게임 서버 로그에 401 `UNKNOWN_KID` | Worker 값과 SSM 값이 다르다 | 3-2와 3-3에 **같은 값**을 다시 넣고 게임 서버를 다시 켠다 |
| 401 `BAD_SIGNATURE` | 서명 글자가 틀렸다(게임 서버 코드 버그나 본문을 바꾸는 중간 장치) | 게임 서버 쪽에 알린다. 값은 맞다 |
| 401 `RESULT_STALE` | 게임 서버 시계가 10분 넘게 틀렸거나 오래 쌓인 결과를 옛 서명 그대로 보냈다 | EC2 시간 동기화(chrony) 확인. 게임 서버는 다시 서명해 보낸다 |
| 503 `DB_MISSING` | 0003을 실서버에 안 했다 | `docs/DB_MIGRATION_SOP.md` 3-2(0003) |
| 409 `RESULT_CONFLICT` | 같은 결과 번호로 다른 내용이 왔다(방 번호가 겹쳤다) | 게임 서버 쪽 방 번호 만들기를 고친다. 포인트는 처음 것만 들어갔다 |
| `wrangler secret put`이 `not logged in` | wrangler 로그인이 풀렸다 | `npx wrangler login` 뒤 다시 |
| `aws ssm put-parameter`가 `Unable to locate credentials`·`AccessDenied` | AWS 로그인이 안 됐거나 권한이 없다 | `aws configure sso`(또는 `aws sso login`) 뒤 다시. `infra/aws/README.md` 참고 |
| `ParameterAlreadyExists` | `--overwrite`를 빠뜨렸다 | 명령 끝에 `--overwrite`를 붙여 다시 |
