<!--
  Date: 06NOV2026
  Author: Minkyu Jung
  Purpose: 권위 서버 시제품(server/)의 구조, 프로토콜, 틱·되감기 설계, 입력 검증, 브라우저 클라이언트를 붙이는 계획, 배포 계획(실행 환경 고르기·systemd·Caddy·Grafana Cloud·GitHub Actions·Durable Objects).
-->
# 권위 서버 시제품

지금 멀티플레이는 방장 브라우저가 판정한다(`docs/SECURITY.md` 2절). 그래서 방장 자신의 조작, 사칭, 사지 않은 무기 사용을 막지 못한다(같은 문서 5절).
`server/`는 이 판정을 서버로 옮기는 시제품이다. **클라이언트는 입력만 보내고, 서버가 30 Hz로 이동·사격·라운드를 판정해 상태를 보낸다.**
게임 규칙은 새로 쓰지 않고 브라우저가 쓰는 순수 모듈(`js/engine/physics.js`·`movement.js`·`player.js`, `js/game/match.js`, `js/weapons/*`)을 그대로 불러 쓴다.

브라우저 클라이언트는 아직 이 서버에 붙지 않는다. 지금은 가짜 클라이언트(`server/tools/fake-client.mjs`)가 실제 소켓으로 붙어 한 판을 끝까지 돈다.

| 측정(개발 PC, Windows, Node 24) | 값 |
|---|---|
| 3:3 한 판(가짜 클라이언트 6명, 한쪽 지연 30±10 ms, 2선승 짧은 라운드) | 9.4초에 끝, 사격 49발 중 46발 명중, 버린 메시지 0, 건너뛴 틱 0 |
| 지연 40 ms 사수 vs 1초마다 방향을 바꾸며 걷는 적(30발) | 되감기 켬 **100%** 명중(평균 되감기 218 ms) / 끔 **7%** |
| 틱 계산 시간(6명 방 하나가 도는 틱) | 평균 약 1.3 ms, 5 ms를 넘은 틱은 280개 중 4개 (30 Hz 한 틱은 33 ms) |
| 내려보내는 양 | 받는 사람 한 명당 틱마다 약 540 B = 약 16 KB/s. 6명 방 하나 약 0.8 Mbit/s |

## 1. 실행

```bash
npm --prefix server ci
```

```bash
npm run server -- --port 8787
```

```bash
npm run server:bots -- --bots 6 --latency 30
```

`npm --prefix server ci`는 처음 한 번만 한다(의존성은 `ws` 하나). 서버는 `ws://127.0.0.1:8787/ws`에서 받는다.
`server:bots`는 떠 있는 서버에 가짜 클라이언트를 붙여 한 판을 끝까지 돌리고 점수·킬·명중률·평균 되감기를 출력한다. 데모에서는 라운드를 짧게 하면 빨리 끝난다.

```bash
npm run server -- --round-sec 30 --loadout-sec 1 --round-end-sec 1 --rounds-to-win 2
```

| 옵션 | 기본 | 뜻 |
|---|---|---|
| `--port`, `PORT` | 8787 | 0이면 빈 포트 |
| `--host`, `HOST` | 0.0.0.0 | Caddy 뒤에서는 127.0.0.1 |
| `--hz` | 30 | 서버 틱 |
| `--room-size` | 6 | 방 정원 |
| `--max-rewind-ms` | 300 | 되감기 상한. 0이면 지연 보정 끔 |
| `--map`, `--mode`, `--ruleset` | arena, team, classic | 새 방의 기본값(방을 만드는 사람이 join의 opts로 바꿀 수 있다) |
| `--origins`, `ALLOWED_ORIGINS` | 없음 | 허용할 Origin 목록. 비우면 보지 않는다(개발) |
| `--trust-proxy` | 끔 | X-Forwarded-For를 접속 IP로 본다. 프록시 뒤에서만 |
| `--log-level`, `LOG_LEVEL` | info | trace~error, silent |

| HTTP | 내용 |
|---|---|
| `GET /ws` (업그레이드) | 게임 WebSocket |
| `GET /healthz` | `{ ok, version, protocol, uptimeSec, hz, ticks, rooms, players, connections }` |
| `GET /metrics` | Prometheus 텍스트(접속·방·사람 수, 틱 시간 히스토그램, 받은·버린·보낸 메시지, 끊은 이유) |

시험은 `npm run test:server`(58개, 약 25초)다. 기존 `npm run check`는 서버 의존성 없이 그대로 돈다. 서버 파일의 머리말과 금지 단어만 함께 검사한다.

## 2. 구조

```
server/
  package.json        의존성 ws 8.22.0(정확히 고정, ws 자체는 런타임 의존성 없음). 사이트에는 여전히 npm 패키지가 없다
  src/main.mjs        실행 진입점. 설정 → startServer, SIGINT·SIGTERM에 정리하고 종료
  src/config.mjs      기본값 표 + 명령줄·환경 변수 검사
  src/server.mjs      HTTP(/healthz·/metrics) + WebSocket 업그레이드, 접속별 제한, 모든 방을 도는 고정 틱 루프
  src/room.mjs        방 하나: match + 월드 + 사람 + 수류탄. 소켓을 모른다(시험에서 직접 돌린다)
  src/actor.mjs       사람 하나: 입력 줄 → createLocalPlayer(이동) + createArsenal(무기)
  src/combat.mjs      펠릿 판정(traceShot)과 칼 판정(meleeTrace)
  src/lagcomp.mjs     위치 기록 링 버퍼 + 되감기 상한
  src/protocol.mjs    메시지 검사와 스냅샷 줄 형식
  src/maps.mjs        js/maps + buildCollision으로 월드를 만들고 맵마다 한 번만 만들어 나눠 쓴다. 서버 시험장 arena
  src/limits.mjs      토큰 버킷, 위반 점수
  src/loop.mjs        밀려도 평균 빈도를 지키는 고정 간격 루프
  src/log.mjs         pino와 같은 형식의 JSON 줄 로그
  src/metrics.mjs     Prometheus 텍스트 지표
  tools/fake-client.mjs  가짜 클라이언트(지연 흉내, 보간, 조준 봇)
  tools/bots.mjs      떠 있는 서버에 가짜 클라이언트를 붙여 한 판 돌리기
  test/*.test.mjs     node:test 시험
```

```
브라우저(나중) / 가짜 클라이언트
   │  WebSocket 텍스트 JSON: join · in(입력) · pick · team · start
   ▼
server.mjs ── 업그레이드 검사(경로·Origin·접속 수·IP당) → 메시지 검사(크기·속도·형식) → 방으로
   │
   ▼  30 Hz 고정 틱(모든 방)
room.mjs ── actor.step(입력 하나) ──▶ createLocalPlayer.tick ×2 (1/60초)   ← js/engine/player.js, movement.js, physics.js
   │                               └▶ arsenal.update ×2 → fire·melee·throw  ← js/weapons/logic.js
   │         fire → lagcomp(쏜 사람이 본 틱으로 되감기) → combat.resolveShot(traceShot) → match.claimHit
   │         수류탄 → grenade.js가 굴리고 터지면 explosionDamage → match.claimExplosion
   │         match.tick → 라운드 이벤트 → 스폰·얼림·로드아웃 적용                ← js/game/match.js, modes.js
   │         기록 → 스냅샷(틱마다) · 이벤트 · 점수판
   ▼
클라이언트: 스냅샷을 보간해 그린다(js/engine/interp.js SnapshotBuffer)
```

### 그대로 불러 쓰는 브라우저 모듈

| 모듈 | 서버에서 하는 일 |
|---|---|
| `js/engine/player.js` `createLocalPlayer` | 이동 전부: 키 → moveQuake, 앉기·일어서기, 점프 버퍼, 발판·포털, 맵 밖 낙하. 카메라 없이 돈다 |
| `js/engine/movement.js`, `physics.js` | Quake식 가속·버니합, 충돌, `traceShot`·`raycastPlayers`·`lineOfSight` |
| `js/weapons/logic.js` `createArsenal` | 무기 상태 머신: 연사·점사·볼트·탄퍼짐·반동·재장전·교체·칼 선딜·수류탄 핀 |
| `js/weapons/grenade.js` | 수류탄 궤적(1/120초 고정 적분)과 폭발 피해(엄폐 확인) |
| `js/game/match.js`, `modes.js` | 라운드·점수·피해 계산·연사 검사·개인전 부활, 규칙별 허용 무기, 아군 통과 |
| `js/maps/index.js`, `collision.js` | 브라우저와 같은 맵 데이터·충돌체·스폰 |
| `js/engine/interp.js`, `js/game/protocol.js`의 `FLAG` | 각도 보간, 상태 비트(브라우저 상태 메시지와 같은 값) |

옮겨 적은 것은 칼 판정 `meleeTrace` 하나다. `js/game/world.js`가 three.js를 불러 node에서 import할 수 없어서다(8절에서 공용 모듈로 뺀다).
서버 이동이 브라우저와 같다는 것은 시험이 직접 확인한다: 같은 키를 1/60초 두 번씩 돌린 `createLocalPlayer`와 위치·속도가 1e-9까지 같다(걷기·점프·버니합·앉기).

## 3. 프로토콜 (버전 1)

WebSocket 텍스트 프레임 하나에 JSON 객체 하나. `t`가 형식이다. 코드는 `server/src/protocol.mjs`.

### 클라이언트 → 서버

| t | 필드 | 뜻 |
|---|---|---|
| `join` | `v` 프로토콜, `room` `[a-z0-9_-]{1,32}`, `name`(24자), `team?`, `opts?: { map, mode, ruleset }` | 접속 뒤 한 번. opts는 방을 처음 만들 때만 쓴다 |
| `in` | `s` 입력 번호, `k` 누르고 있는 키, `y` yaw, `p` pitch, `w?` 무기 칸, `b?` 새로 누른 키, `vt?` 그린 틱 | **입력 하나 = 서버 틱 하나(1/30초)** |
| `pick` | `w` 무기 id | 라운드 전 무기 선택(match.setLoadout이 규칙을 본다) |
| `team` | `team` | 대기실에서만 |
| `start` | | 방장(가장 먼저 들어온 사람)만. 경기가 끝난 뒤에는 새 판 |

- `k`(누르고 있는 키): 앞 1, 뒤 2, 왼쪽 4, 오른쪽 8, 점프 16, 앉기 32, 천천히 걷기 64, 사격 128, 조준 256.
  조준은 "지금 조준하고 싶다"는 뜻이다. 토글 설정은 클라이언트가 풀어서 보낸다.
- `b`(이번 입력 사이에 새로 누른 키): 점프 1, 사격 2, 조준 4, 재장전 8, 다음 무기 16, 이전 무기 32.
  한 입력(33 ms) 안에서 눌렀다 뗀 클릭도 놓치지 않으려고 누르고 있는 키와 따로 싣는다.
- `w`: 이번에 숫자 키로 고른 칸(1~4), 없으면 0.
- `y`·`p`: 라디안. 서버가 yaw를 감고 pitch를 ±89°로 자른다.
- `vt`: 이 입력을 만들 때 다른 사람을 그린 서버 틱(소수). 되감기 기준이다(5절).

### 서버 → 클라이언트

| t | 필드 | 언제 |
|---|---|---|
| `welcome` | `id`, `team`, `room`, `hz`, `tick`, `map`, `mode`, `ruleset`, `leader`, `maxRewindMs`, `row`(줄 칸 이름) | join 직후 |
| `s` | `k` 틱, `p` 줄 배열, `me` 받는 사람만의 상태 | 틱마다 |
| `e` | `k`, `e` 이벤트 배열 | 이벤트가 있던 틱 끝 |
| `m` | `k`, `m`(match.snapshot()), `leader`, `ping`(사람별 왕복 ms) | 이벤트가 있을 때와 0.5초마다 |
| `err` | `code`, `msg` | 끊기 직전 |

- 스냅샷 줄: `[id, x, y, z, yaw, pitch, flags, hp, weapon, ack]`. 위치 cm 정수, 각도 0.001 rad 정수,
  flags는 `js/game/protocol.js`의 `FLAG`(땅 1, 줌 2, 걷기 4, 생존 8, 재장전 16, 앉음 32). **ack = 서버가 그 사람의 입력 중 마지막으로 처리한 번호**.
- `me`: `ack`, `v` 속도(cm/s), `g` 땅, `mm` 이동 기억(착지 후·A/D 교체 후 시간, 마지막 A/D), `ws` 무기 상태, `am` [탄창, 예비(무제한 −1)], `rk` 반동(mrad), `sp` 이동 배율.
  다음 단계의 예측·보정이 쓴다.
- 이벤트: match.js 이벤트(join, leave, team, loadout, roundStart, phase, damage, kill, roundEnd, matchEnd, spawn) +
  서버 연출 이벤트 `fire {id, w, o 눈, h 탄착, hk 맞은 것, rw 되감은 틱}`, `swing`, `nade {gid, pos, vel, fuse}`, `boom {gid, pos}`, `leader {id}`.
  `reject`는 요청한 사람에게만 간다.
- 닫기 코드: 1001 서버 종료, 1008 위반 누적, 1009 프레임 너무 큼, 4001 방이 가득 참, 4002 프로토콜 버전, 4003 join 시간 초과, 4004 방 수 상한, 4005 입장 거절, 4006 받는 쪽이 못 따라옴, 4007 방 오류.

형식이 호환되지 않게 바뀌면 `PROTOCOL`을 올리고, 서버는 다른 버전의 join을 4002로 끊는다. 모르는 `t`는 버린다(새 클라이언트가 옛 서버에 붙어도 바로 끊기지 않게).

## 4. 틱 설계

- **30 Hz, 입력 하나 = 틱 하나.** 이동은 그 입력으로 1/60초씩 두 번 돈다(`substeps` 2). 이동 수치(`MOVE`)는 브라우저 60 Hz 고정 틱에 맞춰 튜닝돼 있어서 점프 높이·버니합·마찰이 그대로 나온다. 무기 상태 머신도 같은 간격으로 두 번 돈다.
- **틱 순서**: ① 사람마다 입력 하나(이동 → 무기, 사격은 그 자리에서 되감아 판정) ② 수류탄 ③ `match.tick` → 라운드 이벤트 적용 ④ 위치 기록 ⑤ 스냅샷·이벤트·점수판. 입장·퇴장·무기 선택처럼 틱 밖에서 생긴 일도 다음 틱 끝에 함께 나간다.
- **사람 처리 순서는 틱마다 한 칸씩 돈다.** 같은 틱에 서로 쏜 두 사람 중 늘 같은 사람이 먼저 맞히지 않게 한다(먼저 처리된 사람의 킬로 상대는 그 틱에 쏘지 못한다).
- **입력 줄**(`actor.mjs`)
  - 틱마다 정확히 한 걸음. 밀린 입력을 한 틱에 여러 개 처리하지 않으므로 시간을 당겨 빨리 달리는 조작(speed hack)이 통하지 않는다.
  - 줄이 비면(입력이 늦으면) 마지막 입력의 누르고 있는 키를 한 틱 더 쓴다. 새로 누름과 무기 칸은 되풀이하지 않고 시점도 그대로 둔다. ack는 늘지 않는다.
  - 줄이 4개(약 133 ms)를 넘으면 가장 오래된 입력의 이동은 버리고 새로 누름·무기 칸만 다음 입력에 합친다.
  - 번호가 이미 받은 것보다 크지 않으면 버린다(중복·순서 조작).
- **판정은 match.js가 확정한다.** 서버는 펠릿을 `traceShot`으로 따라가 잰 부위·거리·펠릿 수로 `match.claimHit`을 부르고, match가 피해 계산·연사 검사·규칙 검사를 한 번 더 한다. 브라우저 방장 판정과 같은 함수다.
- **루프**(`loop.mjs`): 다음 틱 시각을 1/30초씩 늘려 가며 잠든다. 늦게 깨면 밀린 틱을 최대 5개까지 몰아서 돌고, 그보다 밀리면 건너뛰고 경고 로그와 `skala_ticks_skipped_total`을 남긴다. 방 하나가 틱 중에 던지면 그 방만 4007로 닫고 다른 방은 계속 돈다.
- **보내는 양**: 앞부분(모두의 줄)은 틱마다 한 번만 직렬화하고 받는 사람마다 `me`만 덧붙인다. 측정값은 받는 사람 한 명당 틱마다 약 540 B(16 KB/s), 올리는 입력은 약 70 B × 30/s(2 KB/s).
  6명 방 하나는 약 0.8 Mbit/s, 한 시간에 약 350 MB, 한 달 내내 돌리면 약 250 GB다.

## 5. 지연 보정(되감기)

쏜 사람은 다른 사람을 **과거의 자리**에서 본다. 스냅샷이 오는 데 한쪽 지연만큼 걸리고, 끊김 없이 그리려고 받은 스냅샷 사이를 100 ms 늦게 보간하기 때문이다.
그 화면에서 정확히 겨눴는데 서버가 지금 자리로 판정하면 빗나간다(시험: 걷는 적을 7%만 맞힌다).

```
서버 틱:   … k-8 … k-2  k-1  k   ← 지금 처리 중(입력이 도착한 틱)
기록:      틱이 끝날 때마다 사람 자리(발 위치·yaw·앉음·생존)를 남긴다. 기록 k = 스냅샷 k
클라이언트: 받은 최신 스냅샷 k' + 받은 뒤 흐른 시간 − 100 ms 를 그린다 → 그 값을 vt(소수 틱)로 입력에 싣는다
서버:      vt를 [지금 − 상한, 가장 최근 기록] 안으로 자르고, 그 틱 앞뒤 두 기록을 같은 비율로 섞어 그 화면을 다시 만든다
```

- **되감는 것은 맞는 사람뿐이다.** 쏜 사람의 눈은 지금 서버 자리다(그 사람 자신의 입력은 이미 반영돼 있다).
- 섞을 때 한 틱 사이에 4 m 넘게 옮겼으면(스폰·포털) 섞지 않고 가까운 쪽을 쓴다. 두 기록 모두에서 살아 있어야 하고, **지금도 살아 있어야** 맞는다(되감은 화면에서는 살아 있어도 그 사이에 다른 사람에게 죽었으면 끝).
- 팀전은 되감은 목록에서 아군을 뺀다(총알이 아군 몸을 통과한다, `modes.shotTargets`). 칼도 같은 방법으로 되감는다. 수류탄은 서버가 굴리는 물체라 지금 자리로 계산한다.
- **상한 300 ms(9틱)**: 왕복 지연 150 ms까지는 끝까지 보정한다(150 + 보간 100 + 입력 줄 약 50). 그보다 지연이 큰 사람이나 지난 화면을 우기는 조작은 상한까지만 되감는다. 상한이 클수록 맞는 사람은 엄폐한 뒤에 맞는다("벽 뒤에서 맞았다"). 시험 기준 평균 되감기는 지연 30~40 ms에서 약 220~240 ms다.
- 시험(`lagcomp.test.mjs`): 6틱 전 화면을 겨누고 vt를 실으면 맞고 되감은 양이 정확히 7틱이다. 같은 조준에 vt가 없으면, 상한 너머(15틱 전)를 우기면, 되감기를 끄면 빗나간다.
  끝에서 끝까지(`match.test.mjs`): 지연 40 ms 사수가 걷는 적을 쏘면 켬 100% / 끔 7%.

## 6. 입력 검증과 남용 막이

| 막는 것 | 방법 | 어기면 |
|---|---|---|
| 큰 프레임 | `maxPayload` 4 KB(ws가 읽기 전에 막는다) | 1009로 끊김 |
| 큰 메시지 | 512 B 초과 | 버림 + 위반 2점 |
| 과속 | 토큰 버킷 초당 60개, 순간 90개 | 버림 + 1점 |
| 깨진 JSON·잘못된 필드·바이너리·join 전 메시지 | `decodeClient` 형식별 검사(숫자 범위, 각도, 비트, 방 id, 이름) | 버림 + 1점 |
| 모르는 형식 | `t`가 표에 없음(`toString` 같은 이름도) | 버림 + 0.25점 |
| 위반 누적 | 점수는 초당 1점씩 준다 | 20점이면 1008로 끊김 |
| 사칭 | 사람 id는 서버가 정하고, 메시지의 주인은 그 소켓이다 | — |
| 정원 | 방 6명, 방 50개, 접속 300개, IP당 접속 32개(한 공인 IP 뒤의 교실·사무실을 생각해 넉넉히) | 4001·4004·503·429 |
| 방 채우기 | 한 IP가 만든 열린 방 4개까지(1인 방으로 방 수 상한을 채우지 못하게) | 4004 `too_many_rooms` |
| 깨진 요청 대상 | `http://[` 같은 대상은 URL로 읽지 못해도 던지지 않는다 | 400 |
| 말 없는 접속 | join 5초, ping 5초마다(다음 ping까지 pong이 없으면) | 4003, 끊김 |
| 느린 받는 쪽 | 보낼 데이터가 256 KB 넘게 쌓임 | 4006 |
| 다른 사이트 | Origin 허용 목록(운영) | 403 |

이름은 제어 문자와 글자 방향을 뒤집는 문자를 지우고 코드 포인트 단위로 24자에서 자른다. 로그에는 IP 원문 대신 프로세스마다 다른 소금을 친 해시 앞 12자만 남긴다(`docs/SECURITY.md` 1절과 같은 원칙).

**`docs/SECURITY.md` 5절의 한계와 이 서버**

1. 방장 자신의 조작 → **해결**. 판정하는 브라우저가 없다.
2. 사칭 → **해결**(id는 서버가 정한다). 끊긴 뒤 다시 들어오는 사람을 같은 사람으로 알아보는 일은 계정 인증이 필요하다(8절).
3. 정보 치트(벽 투시) → **아직**. 모두의 자리를 모두에게 보낸다. 받는 사람마다 `me`를 따로 붙이는 구조라, 보이지 않는 사람을 줄에서 빼는 시야 걸러내기를 같은 자리에 넣을 수 있다.
4. 사지 않은 무기 → **절반**. 규칙이 허용하는 무기만 고를 수 있고 무기 상태 머신이 서버에 있다. 계정이 그 무기를 가졌는지는 서버가 계정 DB를 읽어야 안다(8절).
5. 한도 안의 농사 → **다음 단계**. 경기 결과를 서버가 알므로 서버가 포인트·전적을 기록하면 클라이언트 계산을 믿지 않아도 된다.

## 7. 브라우저 클라이언트를 붙이는 계획 (다음 단계)

1. **전송**: `js/net`에 Supabase Realtime 대신 이 서버로 가는 방 구현을 더한다. `index.html` CSP의 `connect-src`에 `wss://서버 주소`를 더하고 `tests/web-security.test.mjs`도 함께 고친다. 방 목록은 서버에 `GET /rooms`를 더하거나 지금 로비(Presence)를 그대로 쓴다.
2. **입력**: 60 Hz 고정 틱 두 번마다 입력 하나를 보낸다(서버 substeps 2와 같다). 누르고 있는 키, 새로 누른 키, 시점, 입력 번호, 그린 틱(vt)을 싣는다.
3. **예측(prediction)**: 내 플레이어는 지금처럼 `createLocalPlayer`로 바로 움직인다. 보낸 입력은 번호와 함께 보관한다.
4. **보정(reconciliation)**: 스냅샷이 오면 내 줄의 서버 상태(위치, `me`의 속도·땅·이동 기억)로 되돌리고 ack보다 뒤의 입력을 다시 돌린다. 차이가 작으면 화면 위치만 몇 프레임에 걸쳐 따라가고, 크면(포털·밀침) 바로 옮긴다.
   정확히 맞추려면 `player.js` 안쪽 변수(점프 버퍼, 앉은 채 점프 뒤 유지, 발판 대기 시간)를 꺼내고 넣는 함수가 필요하다. 그 값을 `me`에 더한다.
5. **원격 플레이어**: 지금의 100 ms 보간(`js/game/interp.js`, `SnapshotBuffer`)을 서버 틱 시각으로 그대로 쓰고, 그린 틱을 vt로 보낸다.
6. **사격**: 총구 불꽃·탄 자국·반동은 바로 보여 주되(예측), 히트마커와 피해는 서버의 `damage`·`kill` 이벤트로만 표시한다. 탄퍼짐 난수는 서버 것이 정답이므로 화면의 탄 자국은 연출이다. 탄약·재장전은 `me.am`·`me.ws`로 맞춘다.
7. **방장 경로 끄기**: 서버 모드에서는 `session.js`의 방장 판정(createMatch·anticheat·강퇴)을 쓰지 않고 서버 이벤트를 화면에 그대로 쓴다.
8. **공용화**: `meleeTrace`를 `js/game/melee.js` 같은 순수 모듈로 빼 브라우저와 서버가 한 파일을 쓴다.
9. **계정 연결**: join에 기기 토큰을 실어(WSS 안에서만) 서버가 Supabase에서 계정을 확인하고 가진 무기를 읽는다. 경기가 끝나면 서버가 결과를 기록한다(경기 id로 한 번만). Supabase 비밀 키는 서버에만 둔다.

## 8. 배포 계획

### 8.1 어디에 띄우나

이 서버는 상시 떠 있는 Node 프로세스 하나다(`ws`는 순수 JS라 x86·ARM 어디서나 빌드할 것이 없다). 아래 8.2~8.5는 어느 리눅스 VM에서나 같다.
가격과 한도는 2026-11 조사 기준이라 가입할 때 다시 확인한다.

| 길 | 비용 | 메모 |
|---|---|---|
| Cloudflare Durable Objects | 무료(요청 하루 10만) | 무료로 가장 오래 쓸 수 있다. `room.mjs`는 소켓을 몰라 DO 클래스가 방을 들고 alarm으로 틱을 돌리는 어댑터를 얹는다. 한도와 CPU는 9절 |
| 네이버클라우드 Micro | 결제 정보 등록일부터 1년 무료, 그 뒤 자동 과금 | 1인 1대, 한국 거주자, 성능 보장 없음. 공인 IP는 계속 과금(월 약 6천 원), 아웃바운드 월 20 GB 무료 |
| AWS 무료 플랜 | 크레딧 최대 $200, 6개월 | 6개월 뒤 계정이 닫힌다. 이어서 쓰려면 아래 Lightsail |
| AWS Lightsail 서울 | 월 $5 | 고정 IP·방화벽이 붙어 가장 단순하다 |

- **나가는 양**: 6명 방 하나가 한 시간 경기하면 약 350 MB를 내려보낸다(4절). 하루 한 시간씩 한 달이면 약 10 GB라 무료 아웃바운드가 작은 VM에서도 데모는 충분하다. 하루 종일 여는 서버라면 아웃바운드 요금을 먼저 본다.
- **OS**: Ubuntu 24.04. Node는 24 LTS(Node 20은 2026-04에 지원이 끝났다).
- **방화벽**: 클라우드 방화벽(네이버클라우드 ACG, AWS 보안 그룹·Lightsail 방화벽)에서 80·443만 열고 22는 내 IP로 좁힌다. 서버는 `--host 127.0.0.1`로 띄워 8787을 밖에 열지 않는다.
- **배치**: `/opt/skala/releases/<커밋>`에 `js/`와 `server/`만 둔다(서버가 `../../js/`를 불러 쓴다). `npm --prefix server ci --omit=dev` 뒤 `/opt/skala/current`를 그 릴리스로 가리키게 한다. 로그인할 수 없는 `skala` 사용자로 돈다.

### 8.2 systemd

`/etc/systemd/system/skala-server.service`

```ini
[Unit]
Description=SKALA 작전 권위 서버
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=skala
Group=skala
WorkingDirectory=/opt/skala/current
ExecStart=/usr/bin/node server/src/main.mjs --host 127.0.0.1 --port 8787 --trust-proxy --origins https://jungmk0720.github.io
Environment=NODE_ENV=production
Environment=LOG_LEVEL=info
Restart=on-failure
RestartSec=2
TimeoutStopSec=10
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
LockPersonality=true
MemoryMax=512M
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
```

- SIGTERM을 받으면 모든 접속에 `server_shutdown`(1001)을 보내고 닫는다. 처리하지 못한 예외는 fatal 로그를 남기고 끝내고, systemd가 2초 뒤 다시 띄운다.
- 로그는 표준 출력 → journald. 보기: `journalctl -u skala-server -o cat | jq`.

### 8.3 Caddy로 WSS

브라우저는 HTTPS 페이지(GitHub Pages)에서 `ws://`에 붙지 못하므로 TLS가 필요하다. Caddy는 인증서를 자동으로 받고 갱신하며 WebSocket 업그레이드를 그대로 넘긴다.
도메인이 없으면 DuckDNS 같은 무료 하위 도메인을 VM 공인 IP에 연결한다.

`/etc/caddy/Caddyfile`

```
game.example.com {
	@ws path /ws
	reverse_proxy @ws 127.0.0.1:8787
	handle /healthz {
		reverse_proxy 127.0.0.1:8787
	}
	respond 404
}
```

- `/metrics`는 밖에 내보내지 않는다(같은 VM의 수집기만 127.0.0.1로 읽는다).
- Caddy가 X-Forwarded-For를 붙이므로 서버는 `--trust-proxy`로 IP당 제한을 진짜 접속 IP에 건다. 프록시 없이 직접 받을 때는 켜지 않는다(누구나 헤더를 꾸밀 수 있다).
- 운영 Origin은 `https://jungmk0720.github.io`만 허용한다. 쿠키를 쓰지 않아 교차 사이트 WebSocket 탈취 위험은 작지만, 다른 사이트가 이 서버를 끌어다 쓰는 것을 막는다.

### 8.4 로그와 지표: Grafana Cloud 무료

- 로그는 이미 pino와 같은 JSON 한 줄(`level`·`time`·`pid`·`hostname`·`msg` + 필드)이다. VM에 Grafana Alloy를 두고 journald에서 읽어 Grafana Cloud Logs(Loki)로 보낸다. 무료 등급은 월 50 GB · 14일 보관이고, 이 서버의 info 로그는 입장·퇴장·방 생성·종료뿐이라 하루 몇 MB도 되지 않는다.
- 지표는 Alloy가 `127.0.0.1:8787/metrics`를 긁어 Grafana Cloud Metrics로 보낸다. 시계열은 30개 안팎이다.
- 라벨은 서비스·수준 정도만 단다. 방·사람 id를 라벨로 달면 시계열이 폭발하므로 JSON 필드로 두고 검색한다.
- 대시보드: 틱 시간 99퍼센타일(`histogram_quantile(0.99, rate(skala_tick_duration_ms_bucket[5m]))`), 방·사람 수, 이유별 버린 메시지·끊은 접속, 건너뛴 틱. 경보: 틱 99퍼센타일 > 20 ms, 건너뛴 틱 > 0, `/healthz` 실패.

```
loki.source.journal "skala" {
  matches    = "_SYSTEMD_UNIT=skala-server.service"
  forward_to = [loki.process.skala.receiver]
}
loki.process "skala" {
  stage.json {
    expressions = { level = "level" }
  }
  stage.labels {
    values = { level = "" }
  }
  forward_to = [loki.write.cloud.receiver]
}
loki.write "cloud" {
  endpoint {
    url = sys.env("LOKI_URL")
    basic_auth {
      username = sys.env("LOKI_USER")
      password = sys.env("GRAFANA_TOKEN")
    }
  }
}
prometheus.scrape "skala" {
  targets    = [{ "__address__" = "127.0.0.1:8787" }]
  forward_to = [prometheus.remote_write.cloud.receiver]
}
prometheus.remote_write "cloud" {
  endpoint {
    url = sys.env("PROM_URL")
    basic_auth {
      username = sys.env("PROM_USER")
      password = sys.env("GRAFANA_TOKEN")
    }
  }
}
```

### 8.5 GitHub Actions 배포

1. **CI**(모든 푸시·PR): Node 24 → `npm run check` → `npm --prefix server ci` → `npm run test:server`.
2. **배포**(`main`에 `server/**` 또는 `js/**`가 바뀌어 CI가 통과했을 때): SSH로 VM에 붙어 새 릴리스 폴더에 올리고 `npm ci --omit=dev` → `current` 링크를 바꾸고 `systemctl restart` → `/healthz`가 200이 아니면 이전 릴리스로 되돌린다.
3. **비밀**: `DEPLOY_HOST`, `DEPLOY_USER`(배포 전용 사용자), `DEPLOY_KEY`(ed25519, 이 VM 전용), `DEPLOY_KNOWN_HOSTS`(서버 키를 고정해 중간자 공격을 막는다). 배포 사용자의 sudo는 `systemctl restart skala-server` 하나만 허락한다. 외부 액션은 커밋 SHA로 고정한다.
4. **진행 중인 경기**: 재시작하면 판이 끊긴다. 처음에는 `/healthz`의 `players`가 0일 때만 재시작하고, 다음 단계에서 새 방을 받지 않고 진행 중인 판이 끝나기를 기다리는 배수(drain)를 더한다.

```yaml
name: server
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - run: npm run check
      - run: npm --prefix server ci
      - run: npm run test:server
  deploy:
    needs: test
    if: github.ref == 'refs/heads/main' && github.event_name == 'push'
    runs-on: ubuntu-latest
    concurrency: deploy-server
    steps:
      - uses: actions/checkout@v4
      - name: 올리고 재시작
        env:
          KEY: ${{ secrets.DEPLOY_KEY }}
          HOSTS: ${{ secrets.DEPLOY_KNOWN_HOSTS }}
          TARGET: ${{ secrets.DEPLOY_USER }}@${{ secrets.DEPLOY_HOST }}
        run: |
          install -m 600 /dev/null ~/.ssh_key && printf '%s\n' "$KEY" > ~/.ssh_key
          printf '%s\n' "$HOSTS" > ~/known_hosts
          SSH="ssh -i ~/.ssh_key -o UserKnownHostsFile=~/known_hosts"
          REL=/opt/skala/releases/${GITHUB_SHA}
          tar czf - --exclude=server/node_modules js server | $SSH "$TARGET" "mkdir -p $REL && tar xzf - -C $REL"
          $SSH "$TARGET" "cd $REL && npm --prefix server ci --omit=dev && /opt/skala/bin/switch.sh $REL"
```

`switch.sh`(VM에 둔다)는 `current`를 새 릴리스로 바꾸고 재시작한 뒤 `/healthz`를 몇 번 확인하고, 실패하면 이전 릴리스로 되돌려 다시 시작한다.

## 9. 설계 결정

| 결정 | 이유 | 대가 |
|---|---|---|
| WebSocket(TCP) | 모든 브라우저가 지원하고 Caddy·Grafana로 운영하기 쉽다 | 패킷 하나가 늦으면 뒤가 줄줄이 늦는다. 입력 줄(4개)과 되풀이로 흡수하고, 나중에 WebTransport(UDP 계열)를 볼 수 있다 |
| JSON 텍스트 | 사람이 읽고 로그·시험으로 확인하기 쉽다 | 이진보다 크다(받는 사람당 16 KB/s). 필요하면 줄을 이진으로 바꾼다 |
| 30 Hz + 이동 두 번 | 서버 CPU·대역폭은 60 Hz의 절반, 이동 튜닝은 그대로 | 입력 반응은 33 ms 단위. 예측이 붙으면 체감하지 않는다 |
| 틱마다 입력 정확히 하나 | 시간 조작(speed hack)을 구조로 막는다 | 끊겼던 입력은 되풀이로 메운다. 예측과 조금 어긋나면 보정이 고친다 |
| vt를 믿되 300 ms에서 자른다 | 클라이언트가 그린 그 순간을 정확히 다시 만든다(지연 추정이 필요 없다) | 상한 안에서는 지난 화면을 우길 수 있다. 다음 단계에서 왕복 지연과 맞는지 함께 본다 |
| 맵 월드를 방끼리 나눠 씀 | 충돌체는 바뀌지 않고 node는 한 스레드다 | 맵을 부수는 기능이 생기면 방마다 따로 만든다 |
| 방 로직은 소켓을 모른다 | 시험에서 직접 돌리고, 같은 방을 Cloudflare Durable Objects 같은 다른 실행 환경에 얹을 수 있다 | 연결 관리 코드가 server.mjs에 따로 있다 |

**Durable Objects로 옮길 때**: 방 하나 = 객체 하나로 두고, 객체가 `createRoom`을 들고 안에서 고정 간격 루프로 틱을 돌린다(접속 관리는 server.mjs 대신 객체의 WebSocket 처리기가 맡는다). 요금 모델을 먼저 본다(2026-11 조사 값).
들어오는 WebSocket 메시지 20개가 요청 1개라 6명 방은 입력만 초당 180개 = 요청 9개이고, 무료 한도(하루 10만 요청)로 하루 약 3시간 돈다. 실행 시간 무료 한도(하루 13,000 GB-s, 객체당 128 MB로 약 28시간)는 그보다 넉넉하다.
무료 플랜의 CPU 한도가 호출당 10 ms라면 틱 하나가 그 안에 끝나야 한다. 이 PC에서 6명 방 틱은 평균 약 1.3 ms였고 280틱 중 4틱이 5 ms를 넘었다. 실제 객체에서 다시 잰다.

## 10. 알려진 한계와 다음 단계

- 브라우저 클라이언트가 아직 붙지 않는다(7절).
- 다시 들어오기가 없다. 끊기면 새 사람이고 그 사람의 기록은 match에 접속 끊김으로 남는다.
- 인증이 없다. 이름은 아무거나 쓸 수 있다(계정 연결은 7절 9).
- 시야 걸러내기가 없어 벽 투시를 막지 못한다.
- 총 버리기·줍기, 이모트, 채팅은 아직 서버에 없다(모르는 형식이라 버린다).
- 방 하나는 프로세스 하나 안에 있다. 사람이 많아지면 방을 여러 프로세스(또는 VM)에 나누고 방을 찾아 주는 로비가 필요하다.
- **부하 측정이 다음 일이다**: `tools/bots.mjs`로 방을 여러 개 띄워 방 수에 따른 틱 99퍼센타일·CPU·메모리·대역폭을 재고, 그 수치로 VM 한 대가 받을 방 수를 정한다.
