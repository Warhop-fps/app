# 좀비 물량 막기 — 게임 서버로 옮기기 준비

좀비 모드(`horde`)의 판정은 지금 방장 브라우저가 한다. 앞으로는 EC2의 node 게임 서버가 방 하나를 한 줄짜리 행위자(30 Hz)로 돌리며 판정한다.
이 문서는 그 준비 단계(G1)를 적는다: 시뮬레이션을 브라우저 없이 node에서 돌리고, 같은 씨앗·같은 입력이면 같은 결과가 나오게 했다.
**사람이 보는 게임 동작은 바뀌지 않았다**(아래 3절의 버그 하나만 고쳤다).

## 1. 의존 지도 (2026-11-23, main 5f293b8 기준)

| 파일 | three.js | DOM·window | 소리 | 타이머 | `Math.random` | 벽시계 | 서버에서 |
|---|---|---|---|---|---|---|---|
| `horde/rules.js` 규칙 값·공식·`makeRng` | - | - | - | - | - | - | 그대로 쓴다 |
| `horde/cards.js` 증강 카드·제안 | - | - | - | - | - (씨앗 해시) | - | 그대로 |
| `horde/bosses.js` 보스 표 | - | - | - | - | - (`pickBosses(rng)`) | - | 그대로 |
| `horde/damage.js` 피해 공식 (새로 뗌) | - | - | - | - | - | - | 그대로 |
| `horde/wire.js` 스냅샷 모양·풀기 (새로 뗌) | - | - | - | - | - | - | 그대로 |
| `horde/contact.js` 검기·C4 닿기 계산 | - | - | - | - | - | - | 그대로(지금은 화면만 씀) |
| `horde/director.js` 시뮬레이션 | - | - | - | - | **씨앗을 안 주면 한 번** | - (자기 시계) | 그대로 |
| `horde/sim/*` 화면 없는 방·봇·지문 (새로 만듦) | - | - | - | - | - | - | 서버가 쓴다 |
| `horde/client.js` 화면 쪽 진행·HUD | 넘겨받음 | ui·input 객체 | - | `performance.now` | - | 씀 | 안 씀(손님 화면) |
| `horde/view.js` 좀비·보스 그리기 | 넘겨받음 | - | `play()` | - | 화면 꾸밈만 | 씀 | 안 씀 |
| `horde/solo.js` 혼자 하기 묶음 | - | ui | - | `ctx.onTick` | - | `performance.now`(통계) | 안 씀 |
| `game/session.js` 멀티 방장 루프(좀비 밖) | - | - | - | `setInterval` 100 ms | 씨앗 없음 → director가 만듦 | `now()` | 서버 방이 대신한다 |

director가 기대는 것(모두 순수): `engine/physics.js`(충돌·이동·시야), `weapons/defs.js`(무기 값), `core/consts.js`, `game/navgrid.js`(길찾기. 만들 때 걸린 시간만 `performance.now`로 잰다),
`maps/collision.js`·`engine/movers.js`(맵 충돌·움직이는 지형). `core/i18n.js`는 `localStorage`·`navigator`를 `typeof`로 확인하므로 node에서는 한국어로 뜬다.

시뮬레이션의 시간과 난수:

- **시계**: `S.clock`은 `tick(dtMs)`가 1000/30 ms씩 고정 간격으로만 올린다. 벽시계를 읽지 않는다. 한 번 부를 때 최대 2000 ms·90간격까지만 돈다.
- **난수**: `makeRng(hashSeed(seed, 'run'))` 하나. 카드 제안은 `(seed, 사람, 스테이지, 다시 뽑기, 회차)` 해시라 순서와 상관없다. 길찾기 `randomPoint`에도 같은 rng를 넘긴다.
  `o.seed`를 주지 않으면 `Math.random`으로 씨앗을 한 번 만든다(지금 멀티 방장이 그렇다). 서버는 씨앗을 꼭 준다.
- **입력**: 사람 위치는 `getPositions()`가 tick마다 준다(`{ x, y, z, yaw, slot, air }`). 사격·폭발·카드·보급품·살리기는 메서드 호출로 들어온다.
- **움직이는 지형**: 브라우저에서는 World가 맵 충돌 월드의 리프트·문을 틱마다 옮기고 director는 같은 월드를 읽는다. 화면 없는 방은 방 시계로 직접 옮긴다(`stepMovers`).

## 2. 지금 손님(브라우저)이 정하는 것 — 서버가 믿어야 하는 값

서버로 옮겨도 아래는 당분간 손님이 보낸 값을 믿는다. 치트 방지는 G2 이후에 하나씩 서버로 가져온다.

| 무엇 | 지금 어디서 | 서버가 하는 검사 |
|---|---|---|
| 사람 위치·바라보는 방향·든 슬롯·점프 중 | 각 손님 | 없음(속도만 12 m/s로 자름) |
| 총 맞은 좀비·부위·거리(`claimHit`) | 손님 World 레이캐스트 | 무기·사거리·관통 수·카드 무기 |
| 수류탄·발사기 맞은 좀비와 피해(`claimExplosion`) | 손님 World 폭발 계산 | 종류 배율·80 m 안·카드(번개·특이점포) |
| 검기 닿은 좀비(`waveStab`) | 손님 `view.js`+`contact.js` | 칼·증강·거리·검기당 상한 |
| 제우스 번개 튀는 좀비, C4 붙는 자리 | 손님 `world.js` | 카드·여섯 마리 상한 |
| 탄약·수류탄 수·연사·재장전(`modsFromPerks`) | 손님 `client.js`·무기 모듈 | 없음 |
| 보급품 줍기, 동료 살리기 | 손님이 요청 | 거리·상태(방장이 확정) |

좀비 이동·공격·보스 스킬·투사체·장판·사람이 받는 피해·쓰러짐·경험치·증강 제안·보급품 떨어뜨리기는 이미 시뮬레이션이 정한다.

## 3. 이번에 바꾼 것

- `horde/damage.js`: `zombieHitDamage`·`nadeDamage`·`BLAST_MUL`·`targetDamageMul`을 director에서 그대로 옮겼다. 화면의 피해 숫자(`client.js`)가 이제 시뮬레이션 전체를 불러오지 않는다.
- `horde/wire.js`: 스냅샷 판 번호·단계 번호·좀비 깃발(`ZF`)·`BOSS_CODE_BASE`·`zombieIdOf`·`applyHordeSnapshot`·`hordeSummary`를 옮겼다. `view.js`가 여기서 가져온다.
  director는 둘 다 다시 내보내므로 `session.js`·`solo.js`·시험·QA의 import는 그대로다.
- `horde/sim/room.js` `createHordeRoom`: 맵 데이터로 충돌 월드·길찾기·좀비 문을 만들고(브라우저와 같은 규칙), 입력을 줄 세워 30 Hz 한 틱씩 돌린다. 씨앗이 없으면 만들지 않는다.
- `horde/sim/bots.js` `createHordeBot`: 대본 봇(쏘기·수류탄·증강 고르기와 다시 뽑기·보급품·살리기). 자기 씨앗만 쓴다. 부하 측정에도 쓸 수 있다.
- `horde/sim/digest.js`: 이벤트 줄 지문(키 정렬 JSON + FNV 두 벌, 16자리).
- **버그 고침**: 투사체나 장판에 마지막 사람이 쓰러지면 `gameOver`가 목록을 비운 뒤 같은 반복이 빈 칸을 읽어 `TypeError`가 났다(그 틱의 `over` 이벤트도 사라졌다).
  화면 없는 방으로 60·100스테이지를 돌리다 찾았다. 반복 맨 위에서 `S.phase === 'over'`면 멈춘다. 다른 경우에는 동작이 같다.
- 시험 `tests/horde-headless.test.mjs`: 봇 4명이 `restarea`에서 7스테이지까지(보스 3·6스테이지, 증강 30번, 다시 뽑기, 쓰러짐·살리기). 같은 씨앗이면 지문이 같고, 다른 씨앗이면 다르고,
  지문은 고정 값 `f89f5d3d5afc8012`와 같아야 한다. 이 값은 **옮기기 전 main의 director로 잰 값**이라, 옮긴 뒤에도 같다는 것이 동작이 그대로라는 증거다.
  나갔다 다시 들어오기, 전멸 버그 재현도 같이 본다.

화면 없는 방 측정(이 PC, node 24, 봇 4명, 30 Hz):

| 판 | 틱 평균 | 틱 p99 | 틱 최대 | 스냅샷 JSON 평균·최대 | 맵 준비 |
|---|---|---|---|---|---|
| restarea 1→7스테이지 | 0.15 ms | 2.3 ms | 16 ms | 0.96 KB · 1.6 KB | 약 0.1초 |
| restarea 20스테이지(좀비 40마리) | 0.48 ms | 5.9 ms | 14 ms | 1.5 KB · 2.3 KB | |
| subway 1→9스테이지 | 0.03 ms | 0.3 ms | 3.9 ms | 1.1 KB · 1.6 KB | |

틱 하나가 33 ms 안에 넉넉히 끝나므로 프로세스 하나에 방 여러 개를 돌릴 수 있다. 가끔 튀는 값은 길찾기(flow field)를 다시 만들 때다.

## 4. 결정성을 깨는 것 (하지 말 것)

- director·rules·cards·bosses·damage·wire에서 `Math.random`·`Date.now`·`performance.now`·`setTimeout`을 쓰지 않는다. 난수는 director의 `rng`, 시간은 `S.clock`.
- 카드처럼 순서와 상관없어야 하는 무작위는 `hashSeed(seed, ...)`로 만든다.
- `Set`·`Map`은 넣은 순서로 돈다. 순서가 판정에 영향을 주면 넣는 순서도 정해져 있어야 한다(사람은 들어온 순서).
- 지문이 바뀌는 것은 정상일 수 있다: 규칙·좀비·보스·카드·봇을 **일부러** 바꾸면 `GOLDEN.digest`를 새 값으로 고친다. 일부러 바꾼 게 없는데 바뀌면 동작이 몰래 바뀐 것이다.

## 5. 좀비 콘텐츠를 추가하는 팀원 규칙

| 추가하는 것 | 넣을 곳 | 넣지 말 곳 |
|---|---|---|
| 수치(체력·피해·시간·확률) | `rules.js`의 `HORDE`·`ZOMBIE_TYPES`, `bosses.js`, `cards.js`의 `PERK_BASE` | director 안의 상수(꼭 필요하면 이름 붙인 상수로) |
| 새 좀비·보스 행동, 새 증강 효과의 판정 | `director.js`(또는 새 순수 파일을 `horde/`에) | `view.js`·`client.js` |
| 피해 공식 | `damage.js` | director·client에 따로 쓰기 |
| 스냅샷에 새 값 | director `snapshot()` + `wire.js` `applyHordeSnapshot` 같이, 판 번호 올리기 | 이벤트에 잦은 값 싣기 |
| 그리기·소리·HUD·입력 | `view.js`·`client.js`·`ui/horde.js` | director |

- 판정 파일은 `THREE`·`document`·`window`·`play()`를 import하지 않는다. 필요하면 화면이 이벤트·스냅샷을 보고 그린다.
- 새 판정 함수는 시간을 인자(`S.clock`)로, 난수를 `rng`로 받는다.
- 위치는 `[x, y, z]` 배열이나 `{ x, y, z }`만 쓴다. THREE 벡터를 시뮬레이션에 넘기지 않는다.
- 손님 화면에서 판정한 값(맞은 좀비·피해)을 새로 받는다면, director에서 **검사할 수 있는 만큼 검사**하고 2절 표에 한 줄 적는다.
- 고친 뒤 `npm run check`(지문 시험 포함)와 `npm run qa:hidden -- --only zombie,zombie-coop`.

## 6. 다음 단계 (G2)

1. 서버 방에서 `createHordeRoom({ map, players, seed, rules })`를 만들고 30 Hz로 `room.step()`. 맵은 `js/maps/<id>.js`의 default를 import한다(`maps/index.js`는 top-level await로 전부 부른다).
2. 손님 메시지를 `room.input(id, { x, y, z, yaw, slot, air, alive })`와 `room.send(id, { t: 'hit' | 'swing' | 'explode' | 'pick' | 'reroll' | 'loot' | 'revive', ... })`로 바꾼다.
   필드는 지금 손님이 방장에게 보내는 것과 같다(`session.js`의 `hitClaim`·`explosion`·카드·보급품·살리기 처리 참고). 거절 이벤트에는 `by`가 붙으니 보낸 사람에게만 돌려준다.
3. 보낼 것: 이벤트는 그 틱에, `room.snapshot()`은 10 Hz(지금 방장과 같은 주기). 손님은 지금처럼 `applyHordeSnapshot`→`createHordeClient.apply`로 푼다.
   좀비·보스·투사체·장판·보급품·불길·분신 상태가 모두 스냅샷에 있다. 지금 세션은 이벤트를 3초 동안 스냅샷마다 다시 싣는다(director.js 머리말) — 서버도 같은 보장을 하거나 손님이 번호로 중복을 거른다.
4. 증강: 레벨업·보물 상자 제안은 이미 시뮬레이션이 정하고(`offer` 이벤트·스냅샷 `offer` 열), 고르기는 `pick`으로 들어온다. 시간이 지나면 시뮬레이션이 무작위로 준다. 서버는 그대로 두면 된다.
5. 방장 이전(`restoreHorde`)은 서버에는 필요 없다. 서버가 죽으면 판이 끝난다.
6. 부하 측정: `sim/bots.js`로 방 N개를 한 프로세스에서 돌려 틱 시간과 스냅샷 크기를 잰다(3절 표가 시작점).
7. 그 뒤(G3~): 2절 표의 손님 판정을 서버로(사격은 `physics.traceShot`과 좀비 몸 자리, 폭발은 수류탄 비행을 서버에서). 탄약 수도 서버가 세면 보급품·탄창 증강을 믿을 수 있다.

## 7. 이번에 못 한 것

- `session.js`·`solo.js`의 좀비 문 규칙(`isZombieMap` → 레드 스폰)은 `sim/room.js`의 `zombieGates`와 같은 내용이 따로 있다. 좀비 밖 파일(`session.js`)은 건드리지 않기로 해서 합치지 않았다.
- 스냅샷 만들기(`snapshot()`)는 director 안의 상태를 바로 읽어서 `wire.js`로 옮기지 않았다(옮기면 내부 상태를 다 넘겨야 한다).
- 방장 이전 뒤 판은 결정적이지 않다(복원한 director가 난수를 처음부터 다시 돈다). 서버에는 필요 없다.
- 브라우저와 화면 없는 방의 움직이는 지형 시계는 다르다(브라우저: 방장 시계, 방: 틱 수). restarea 리프트 위치만 다르고 규칙은 같다.
