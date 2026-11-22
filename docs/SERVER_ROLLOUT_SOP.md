<!--
  Date: 06NOV2026
  Author: Minkyu Jung
  Purpose: 서버 판정 방(게임 서버가 판정하는 개인전)을 10%·50%·100%로 켜는 절차, 끄는 스위치, 지켜볼 것, 실패 시 표, 되돌리기(SOP).
           용어 풀이 → 값 지도 → 단계 → 실패 시 표 → 되돌리기 순서. 설계는 docs/SERVER.md 16·17절.
-->
# 서버 판정 방 켜기·끄기 (SOP)

지금은 모든 방을 **방장 브라우저**가 판정한다. 이 절차는 개인전 방 일부를 **게임 서버(EC2)** 가 판정하게 바꾼다.
비율은 게임 서버의 작은 파일 하나로 정한다. **사이트를 다시 배포하지 않고** 10% → 50% → 100%로 올리고, 문제가 생기면 5초 안에 끈다.

## 1. 용어 풀이

| 말 | 뜻 |
|---|---|
| 서버 판정 방 | 게임 서버가 이동·사격·킬을 판정하는 방. 브라우저는 입력만 보낸다. 지금은 **개인전만** |
| 방장 판정 방 | 지금처럼 방장 브라우저가 판정하는 방. 팀전·폭파 미션·좀비는 늘 이쪽 |
| 비율(ratio) | 새로 여는 방 중 서버 판정으로 할 몫. `0.1` = 10%. 방장 브라우저가 방을 열 때 주사위를 굴린다 |
| 끄는 스위치(kill switch) | 비율 파일의 `"accepting": false`. 새 방은 모두 방장 판정이 된다. **이미 하고 있는 경기는 끝까지 간다** |
| rollout 파일 | 게임 서버의 `/etc/fps/rollout.json`. 서버가 5초마다 다시 읽는다(서버를 다시 켤 필요 없음) |
| `/rollout` | 게임 서버 주소 뒤에 붙는 확인 주소. 지금 비율과 받는지를 JSON으로 보여 준다 |
| 대신하기(fallback) | 게임 서버에 닿지 않으면 그 방은 저절로 방장 판정으로 시작한다 |
| 무효 경기 | 경기 중에 게임 서버가 꺼지면 그 경기는 결과가 없다(포인트 없음). 사람들은 대기실로 돌아간다 |
| 새로고침 필요 | 사이트와 게임 서버의 약속 판(PROTOCOL)이 다를 때 뜨는 안내. 옛 탭이 남아 있으면 나온다 |

## 2. 값 지도

| 무엇 | 값 / 자리 |
|---|---|
| 게임 서버 주소 | `game.<도메인>` (예: `game.example.io`). `js/config.js`의 `gameServer.url = 'wss://game.<도메인>'` |
| 주소를 넣는 명령 | `node tools/set-domain.mjs --game-server game.<도메인>` (config·`index.html`·`_headers`의 CSP를 함께 바꾼다) |
| 주소를 빼는 명령 | `node tools/set-domain.mjs --game-server off` |
| 비율 파일 | 게임 서버의 `/etc/fps/rollout.json`, 내용 `{"ratio":0.1,"accepting":true}` |
| 게임 서버 환경 변수 | `ROLLOUT_FILE=/etc/fps/rollout.json`, `GAME_RESULT_URL=https://skala-api.skala-fps.workers.dev/v1/match-result`, `GAME_RESULT_SECRET`(SSM `/skala-fps/game/GAME_RESULT_SECRET`), `GAME_SERVER_ID=ec2-a:1`, `ALLOWED_ORIGINS=https://<사이트 주소>` |
| 확인 주소 | `https://game.<도메인>/rollout`, `https://game.<도메인>/healthz` |
| 로그 보기 | 게임 서버에서 `journalctl -u skala-server -o cat -f` |
| 결과 장부(DB) | Supabase SQL Editor: `select result_id, players, points_total, received_at from public.fps_match_results order by received_at desc limit 20;` |
| 주소 깃발(시험) | 사이트 주소 뒤 `?server=1` = 받는 서버면 늘 서버 판정, `?server=0` = 늘 방장 판정 |

## 3. 먼저 되어 있어야 하는 것

1. **브랜치 합치기 순서**: `feature/game-server`(C) → `feature/signed-results`(F, 운영 기초 A 포함) → `feature/server-rollout`(이 일). 이 브랜치는 셋을 다 담고 있으니 앞의 둘을 먼저 main에 넣은 뒤 이것을 넣는다.
2. DB에 0003(경기 결과 표)을 넣었다: `docs/DB_MIGRATION_SOP.md`.
3. 결과 서명 값을 Worker와 SSM에 넣었다: `docs/GAME_RESULT_SECRET_SOP.md`. 3-4의 확인이 `BAD_REQUEST`로 나와야 한다.
4. 게임 서버가 EC2에 떠 있고 `https://game.<도메인>/healthz`가 `"ok":true`를 준다(게임 서버 배포 문서). 위 2절의 환경 변수가 들어가 있다.
   - 비밀 값이 없으면 서버 로그 처음에 `match results disabled`가 나온다. 이때도 게임은 되지만 **포인트는 브라우저가 넣는다**(지금과 같다).

## 4. 단계

### 4-1. 비율 0으로 시작 (게임 서버)

게임 서버에 접속해서(AWS 콘솔 → EC2 → 인스턴스 → **연결** → Session Manager):

```bash
sudo mkdir -p /etc/fps
echo '{"ratio":0,"accepting":true}' | sudo tee /etc/fps/rollout.json
curl -s http://127.0.0.1:8787/rollout
```

성공 모습: `{"ok":true,"protocol":2,"accepting":false,"ratio":0,"why":"off"}` (비율 0이라 받지 않는다는 뜻. 정상).

### 4-2. 사이트에 게임 서버 주소 넣기 (내 PC, 한 번만)

```powershell
cd E:\jobFolder\skala-data\team-project\fps
node tools/set-domain.mjs --game-server game.<도메인> --dry-run
node tools/set-domain.mjs --game-server game.<도메인>
npm run check
```

성공 모습: `기록: 게임 서버 wss://game.<도메인> (3개 파일: js/config.js, index.html, _headers)`, check 통과.
커밋 → PR → 머지 → 사이트 배포(평소 절차). 비율이 0이라 **배포해도 아무것도 바뀌지 않는다.**

### 4-3. 혼자 시험 (?server=1)

1. 브라우저 두 개(또는 사람 둘)로 `https://<사이트>/?server=1` 을 연다.
2. 비율 파일을 잠깐 `{"ratio":0.01,"accepting":true}`로 바꾼다(0이면 깃발이 있어도 받지 않는다). 5초 기다린다.
3. 개인전 방을 **새로** 만들고 시작한다. 방 채팅에 "이번 경기는 게임 서버가 판정해요."가 나오면 서버 판정이다.
4. 한 판을 끝낸다. 결과 화면의 포인트와, 몇 초 뒤 메뉴의 포인트가 **한 번만** 늘었는지 본다.
5. 2절의 SQL로 `fps_match_results`에 한 줄이 생겼는지 본다.

### 4-4. 10% → 50% → 100%

```bash
echo '{"ratio":0.1,"accepting":true}' | sudo tee /etc/fps/rollout.json
curl -s http://127.0.0.1:8787/rollout
```

성공 모습: `"accepting":true,"ratio":0.1`. 로그에 `rollout changed`가 한 줄 나온다.
하루쯤 5절을 지켜보고 괜찮으면 `0.5`, 다시 하루 뒤 `1`로 같은 명령을 쓴다. 비율은 **새로 여는 방**부터 적용된다(이미 열린 방은 그 방장이 고른 대로).

### 4-5. 끄는 스위치

```bash
echo '{"ratio":0,"accepting":false}' | sudo tee /etc/fps/rollout.json
curl -s http://127.0.0.1:8787/rollout
```

성공 모습: `"accepting":false,"ratio":0,"why":"off"`. 5초 안에 **모든 방의 다음 경기 시작**이 방장 판정이 된다(방장 브라우저가 시작할 때 `/rollout`을 한 번 더 읽는다. 그 방 채팅에 "게임 서버에 닿지 않아…" 안내가 한 번 나온다).
하고 있던 서버 판정 경기는 끝까지 가고 포인트도 들어간다.
**급할 때**(서버가 이상하게 판정한다 등): `sudo systemctl stop skala-server`. 하던 경기는 무효(포인트 없음)이고, 새 방은 서버에 닿지 않아 저절로 방장 판정이다.

## 5. 지켜볼 것

| 무엇 | 어디서 | 괜찮은 값 |
|---|---|---|
| 결과가 들어가는가 | 로그 `match result posted`, `/healthz`의 `results.posted` | 서버 판정 경기 수와 비슷하게 는다. `failed`·`dropped`는 0 |
| 결과가 막히는가 | 로그 `match result retry`·`rejected`·`gave up` | 거의 없다. `rejected`의 `error`를 6절에서 찾는다 |
| 포인트가 두 번 들어가는가 | 건의함·사용자 말, 2절 SQL의 `points_total`과 결과 화면 비교 | 한 번 |
| 서버가 바쁜가 | `/healthz`의 `live.tickMs.p95`, `live.cpuPercent` | p95 15 ms 아래, CPU 70% 아래 |
| 대역폭 | `/healthz`의 `live.bytesOutPerSec` | 한 사람당 약 28 KB/s(`docs/SERVER.md` 14절). 비용을 본다 |
| 끊김 | 로그 `closing abusive connection`, `/metrics`의 `skala_disconnects_total` | 드물다 |
| 대신하기가 잦은가 | 방 채팅 "게임 서버에 닿지 않아…"를 본 사람이 있는지 | 없다 |

## 6. 실패 시

| 보이는 것 | 뜻 | 할 일 |
|---|---|---|
| `/rollout`이 `"why":"off"` | 비율 0이거나 `accepting:false` | 4-4 명령으로 비율을 넣는다 |
| `/rollout`이 `"why":"full"` | 방·접속이 상한의 90% | 비율을 낮추거나 서버를 키운다(`--max-rooms`) |
| 사이트에서 `/rollout`을 못 읽는다(늘 방장 판정) | DNS·Caddy·방화벽, 또는 CSP에 주소가 없다 | `curl -s https://game.<도메인>/rollout`, 4-2를 했는지, 브라우저 콘솔의 CSP 오류 |
| 방 채팅 "게임 서버에 닿지 않아 이번 경기는 방장이 판정해요." | 시작할 때 게임 서버에 못 붙었다 | `/healthz`, 서버의 `ALLOWED_ORIGINS`에 사이트 주소가 있는지 |
| "새로고침 필요" | 사이트와 서버의 판이 다르다(한쪽만 배포했다) | 사이트·서버를 같은 커밋으로 맞춘다. 사용자는 새로고침 |
| "게임 서버와 연결이 끊겨 이번 경기는 무효예요" | 경기 중 서버가 꺼졌거나 끊겼다 | 로그의 `fatal`·`room tick failed`, `systemctl status skala-server` |
| 로그 `match results disabled` | 서버에 `GAME_RESULT_URL` 또는 32글자 이상 `GAME_RESULT_SECRET`이 없다 | 2절 환경 변수, `docs/GAME_RESULT_SECRET_SOP.md` 3-3 뒤 서버 다시 켜기 |
| `rejected` `BAD_SIGNATURE`·`UNKNOWN_KID` | Worker와 서버의 비밀 값이 다르다 | `docs/GAME_RESULT_SECRET_SOP.md`로 같은 값을 다시 넣는다 |
| `retry` `404 not_found`가 계속 | Worker에 비밀 값이 없다 | 같은 문서 3-2 |
| `retry` `503 DB_…` | DB 함수가 없다(0003 안 넣음) 또는 DB 장애 | `docs/DB_MIGRATION_SOP.md` |
| `rejected` `RESULT_CONFLICT` | 같은 결과 번호에 다른 내용(있으면 안 된다) | 로그의 `resultId`를 적어 두고 비율을 0으로. 코드 문제다 |
| 포인트가 두 번 들어갔다 | 브라우저가 옛 판(이 브랜치 전)이다 | 사용자 새로고침. 늘면 비율 0 |
| 포인트가 안 들어갔다 | 결과가 막혔거나 손님(닉네임 없음) | 5절 로그, 2절 SQL로 그 경기의 `players` 확인 |

## 7. 되돌리기

1. **비율 0**: 4-5 명령. 이것만으로 새 방은 모두 방장 판정이다(사이트 배포 필요 없음).
2. **주소 빼기**(사이트에서 게임 서버를 완전히 지울 때):

```powershell
cd E:\jobFolder\skala-data\team-project\fps
node tools/set-domain.mjs --game-server off
npm run check
```

   커밋 → PR → 머지 → 사이트 배포. 그 뒤 브라우저는 게임 서버에 아무것도 묻지 않는다(main과 같다).
3. 게임 서버를 끈다면 `sudo systemctl stop skala-server`. 남은 결과는 3초 더 보내 보고, 못 보낸 것은 로그 `match result dropped on shutdown`에 결과 번호가 남는다.
