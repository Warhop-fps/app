<!--
  Date: 06NOV2026
  Author: Minkyu Jung
  Purpose: 게임 서버(EC2, Node)가 API Worker로 보내는 서명한 경기 결과의 약속. 모양, 정규 직렬화, HMAC-SHA256 서명과 열쇠 번호(kid)·교체,
           시간 창, 같은 결과 한 번만, 한도, 응답 코드, 게임 서버가 공용 모듈을 쓰는 법, 시험 벡터, 아직 남은 일.
-->
# 서명한 경기 결과 약속 (match result contract)

11-22 소유자 결정: 경기 판정은 방장 브라우저에서 EC2의 Node 게임 서버로 옮긴다. **포인트는 게임 서버가 서명한 결과로만 바뀌게 한다.**
지금은 브라우저가 변화량(`p_delta`)을 보내 포인트가 바뀐다(`docs/POINTS_SOP.md`). 모든 방이 서버 판정이 될 때까지 그 길은 그대로 둔다.

```
게임 서버(EC2) ──POST /v1/match-result { kid, sig, result }──▶ skala-api Worker ──비밀 키──▶ fps_api_apply_match_result (0003)
   서명: GAME_RESULT_SECRET(AWS SSM)            검증: GAME_RESULT_SECRET(+ _PREV)(wrangler secret)     한 번만 넣고 포인트 더하기
```

- 공용 모듈: `server/api/src/result-sign.js` (서명·검증·모양 검사·정규 직렬화. WebCrypto만 쓰고 다른 파일을 import 하지 않는다)
- 받는 쪽: `server/api/src/match-result.js`, DB: `supabase/migrations/0003_match_results.sql`
- 시험: `tests/result-sign.test.mjs`, `tests/api-match-result.test.mjs`

## 1. 결과(result) 모양

칸은 정확히 이것뿐이다. 모르는 칸이 있거나 빠지면 거절한다. 숫자는 모두 **정수**다(소수 없음).

| 칸 | 모양 | 뜻 |
|---|---|---|
| `protocol` | `1` | 약속 번호. 모양이 바뀌면 올린다 |
| `resultId` | `"<roomId>:<matchSeq>"` | 결과 번호. 아래 두 칸을 `:`로 이은 것과 같아야 한다. **같은 번호는 한 번만 들어간다** |
| `roomId` | `[A-Za-z0-9_-]{1,64}` | 게임 서버가 만든 방 번호(서버 안에서 겹치지 않게) |
| `matchSeq` | 1 ~ 10억 | 그 방의 몇 번째 경기인가 |
| `serverId` | `[A-Za-z0-9_.:-]{1,64}` | 게임 서버 인스턴스 이름(예: `ec2-a:1`) |
| `mode` | `[a-z0-9_-]{1,24}` | 모드 id(`ffa`, `tdm`, `bomb`, `br`, `zombie` …) |
| `map` | `[a-z0-9_-]{1,32}` | 맵 id |
| `startedAt`, `endedAt` | 밀리초(ms) | 경기 시작·끝. `startedAt ≤ endedAt`, 길이 6시간 이하 |
| `signedAt` | 밀리초(ms) | 서명한 시각. `endedAt ≤ signedAt`. 다시 보낼 때는 새로 채워 다시 서명한다 |
| `players` | 1 ~ 32개 | 사람마다 하나. 봇·로그인 안 한 손님은 넣지 않는다 |

`players[]` 한 칸:

| 칸 | 모양 | 뜻 |
|---|---|---|
| `tokenHash` | 소문자 hex 64글자 | 그 사람 **기기 토큰의 SHA-256**(hex). DB가 `fps_player_id`로 사람을 찾는 값과 같다. 같은 결과 안에서 겹치면 거절 |
| `kills`, `deaths` | 0 ~ 10000 | 기록용(포인트 계산은 게임 서버가 이미 끝냈다) |
| `placement` | 1 ~ 32 또는 `null` | 순위(팀전처럼 순위가 없으면 `null`) |
| `points` | 0 ~ 2000 | **게임 서버 규칙으로 계산한** 이 경기의 포인트. DB에 이만큼 더한다 |

- 이름·이메일·IP·원래 기기 토큰은 넣지 않는다. 기기 토큰 원문은 계정 열쇠라 게임 서버도 갖지 않는다.
- 브라우저는 방에 들어갈 때 `sha256(기기 토큰)`을 hex로 게임 서버에 알린다. 게임 서버는 이 값을 **다른 사람에게 보내지 않는다**.
- 남의 해시를 적어 내면 그 사람이 포인트를 받을 뿐 빼앗기지는 않는다(포인트는 0 이상만 더한다). 더 막으려면 나중에 입장표(서명한 join ticket)를 더한다.

## 2. 정규 직렬화 (canonical serialization)

서명은 글자에 하는 것이라, 양쪽이 같은 글자를 만들어야 한다.

1. 객체 열쇠를 **사전순**(JS 기본 `sort`, UTF-16 코드 단위)으로 늘어놓는다. 안쪽 객체도 똑같이.
2. 빈칸·줄바꿈 없이 JSON으로 적는다. 글자는 `JSON.stringify`와 같은 방식, 숫자는 정수 그대로(안전한 정수 범위만).
3. 배열은 순서를 바꾸지 않는다.
4. 소수·`NaN`·`undefined`·날짜 객체 등이 있으면 적지 않고 오류를 낸다.

`canonicalize(value)`가 이 규칙이다. 서명할 글자는 `"skala-match-result.v1." + canonicalize(result)`.

## 3. 서명과 열쇠

| 무엇 | 값 |
|---|---|
| 방식 | HMAC-SHA256, 결과는 base64url(채움 `=` 없음, 43글자) |
| 비밀 값 | `GAME_RESULT_SECRET`, **32글자 이상**. Worker는 wrangler secret, 게임 서버는 AWS SSM `/skala-fps/game/GAME_RESULT_SECRET` |
| 이전 비밀 값 | `GAME_RESULT_SECRET_PREV`(Worker만). 교체하는 동안만 둔다 |
| 열쇠 번호 `kid` | `"k" + hex(SHA-256("skala-result-kid.v1." + 비밀 값))`의 앞 16글자. 비밀 값에서 저절로 나오므로 따로 설정하지 않는다 |

보내는 본문(봉투, envelope)은 칸 세 개뿐이다:

```json
{ "kid": "k3838131de372e21d", "sig": "ycL25j3JSKtERRFj5Y2tGghVKqSiYtYwUOmOFEitE0M", "result": { … } }
```

Worker는 `kid`가 지금 값 또는 이전 값의 번호와 같은 것을 골라 검증한다. 모르는 번호면 401 `UNKNOWN_KID`.

**교체(rotation)**: (1) 새 값 만들기 → (2) Worker에 옛 값을 `GAME_RESULT_SECRET_PREV`로, 새 값을 `GAME_RESULT_SECRET`으로 → (3) SSM 값을 새 값으로 바꾸고 게임 서버 재시작 → (4) 하루 뒤 `GAME_RESULT_SECRET_PREV`를 지운다. 절차는 `docs/GAME_RESULT_SECRET_SOP.md`.

## 4. 받는 쪽 규칙

| 규칙 | 값 |
|---|---|
| 주소 | `POST https://skala-api.skala-fps.workers.dev/v1/match-result`, `content-type: application/json` |
| 브라우저 금지 | `Origin` 헤더가 있으면 403(서버끼리만 부른다). CORS 헤더를 주지 않는다 |
| 꺼짐 | Worker에 `GAME_RESULT_SECRET`(32글자 이상)이 없으면 404(주소가 없는 것처럼) |
| 본문 크기 | 16 KB 이하(32명이어도 8 KB 안쪽) |
| 시간 창 | `signedAt`이 Worker 시계와 **10분** 넘게 다르면 401 `RESULT_STALE` |
| 한 번만 | `resultId`가 이미 있으면 다시 더하지 않는다. `signedAt`만 다르고 나머지가 같으면 200 `duplicate:true`, 내용이 다르면 409 `RESULT_CONFLICT` |
| 한도 | 32명, 한 사람 한 경기 2,000P. 더한 뒤 포인트는 1,000만을 넘지 않는다(`fps_players` 제약) |
| 모르는 사람 | `tokenHash`로 회원을 못 찾으면 그 사람만 건너뛴다(`skipped`에 센다) |

응답:

| 코드 | 본문 | 게임 서버가 할 일 |
|---|---|---|
| 200 | `{ ok:true, duplicate:false, applied, skipped, points }` | 끝 |
| 200 | `{ ok:true, duplicate:true }` | 끝(이미 들어갔다) |
| 400 | `{ ok:false, error:'BAD_REQUEST' \| 'RESULT_INVALID', problem? }` | 다시 보내지 않는다. 로그를 남긴다(코드 버그) |
| 401 | `{ ok:false, error:'BAD_SIGNATURE' \| 'UNKNOWN_KID' \| 'RESULT_STALE' }` | STALE이면 `signedAt`을 새로 채워 다시 서명해 보낸다. 나머지는 비밀 값이 어긋났다(운영자에게 알림) |
| 403 | `{ ok:false, error:'origin_not_allowed' }` | `Origin` 헤더를 빼고 보낸다 |
| 404 | `{ ok:false, error:'not_found' }` | Worker에 비밀 값이 없다. 잠시 뒤 다시(쌓아 둔다) |
| 409 | `{ ok:false, error:'RESULT_CONFLICT' }` | 같은 번호로 다른 내용을 보냈다. 다시 보내지 않는다(방 번호가 겹쳤다는 뜻) |
| 503 | `{ ok:false, error:'DB_…' }` | 잠시 뒤 같은 결과를 다시(새 `signedAt`으로) |

다시 보내기: 503·404·네트워크 오류는 1초, 5초, 30초, 2분, 10분 … 간격으로 같은 `resultId`를 보낸다. 같은 번호라 두 번 더해지지 않는다.

## 5. 게임 서버에서 쓰는 법

공용 모듈은 import 하나 없는 파일이라 그대로 가져다 쓴다.

```js
// 저장소 안 상대 경로(예: server/game/src/report.js에서)
import { signResult } from '../../api/src/result-sign.js';

const secret = process.env.GAME_RESULT_SECRET;          // SSM /skala-fps/game/GAME_RESULT_SECRET 에서 읽어 넣는다
const result = {
  protocol: 1, resultId: `${roomId}:${seq}`, roomId, matchSeq: seq, serverId, mode, map,
  startedAt, endedAt, signedAt: Date.now(),
  players: humans.map((p) => ({ tokenHash: p.tokenHash, kills: p.kills, deaths: p.deaths, placement: p.place ?? null, points: p.points }))
};
const envelope = await signResult(result, secret);    // 모양이 틀리면 여기서 예외
await fetch(`${API_URL}/v1/match-result`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) });
```

- 도커 이미지에 `server/api`를 넣지 않는다면 이 파일 하나를 **그대로 복사**하고, 6절 벡터로 같은 값이 나오는지 시험에 넣는다.
- Node 20 이상(`globalThis.crypto`가 있다). 다른 패키지는 필요 없다.

## 6. 시험 벡터

| 무엇 | 값 |
|---|---|
| 비밀 값 | `test-secret-0123456789abcdef-0123456789` |
| result | `tests/result-vectors.mjs`의 `vecResult()` (방 `room-A1`, 3번째 경기, `ffa`/`cqb`, 두 사람 170P·40P) |
| kid | `k3838131de372e21d` |
| sig | `ycL25j3JSKtERRFj5Y2tGghVKqSiYtYwUOmOFEitE0M` |

서명할 글자(한 줄):

```
skala-match-result.v1.{"endedAt":1795000600000,"map":"cqb","matchSeq":3,"mode":"ffa","players":[{"deaths":3,"kills":12,"placement":1,"points":170,"tokenHash":"aaaa…(a 64개)"},{"deaths":9,"kills":4,"placement":2,"points":40,"tokenHash":"bbbb…(b 64개)"}],"protocol":1,"resultId":"room-A1:3","roomId":"room-A1","serverId":"ec2-a:1","signedAt":1795000601000,"startedAt":1795000000000}
```

## 7. DB에서 일어나는 일 (0003)

- `fps_match_results`: 결과 한 줄(번호, 모드, 맵, 시작·끝, 서버, 원문 jsonb, 받은 시각). 같은 번호는 한 줄뿐.
- `fps_match_points`: 사람마다 더한 양(결과 번호, 회원 id, 더한 양, 전·후 포인트). 장부다.
- `fps_api_apply_match_result(p_result)`: 한 트랜잭션에서 위 두 표에 넣고 `fps_players.points`를 더한다. 다시 검사한다(Worker를 믿지 않는다).
- 포인트를 더하면 `points_adjust`도 같이 늘어난다(옛 탭이 저장할 때 되돌리지 못하게, `docs/POINTS_SOP.md`). `fps_points_log`에는 `actor`가 `match:<결과 번호>`로 남는다.
- 전적(`stats`의 kills·wins)은 지금 건드리지 않는다. 브라우저 저장이 합계를 덮어쓰기 때문이다. 서버 판정이 다 옮겨진 뒤 따로 정한다.

## 8. 아직 남은 일

- **두 번 받기 막기**: 서버 판정 방에서는 브라우저가 그 경기 보상을 `p_delta`에 넣으면 안 된다(그러면 두 번 받는다). 게임 쪽에서 "서버 판정 방이면 보상을 더하지 않고 서버 값을 다시 읽기"를 넣어야 한다.
- 모든 방이 서버 판정이 되면 `fps_save_profile`의 포인트 증가를 막는다(이때 브라우저 길을 닫는다).
- 입장표(누가 그 해시의 주인인지 서명으로 증명)는 나중 일이다.
