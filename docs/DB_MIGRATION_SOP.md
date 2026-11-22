<!--
  Date: 06NOV2026
  Author: Minkyu Jung
  Purpose: 실서버 Supabase에 번호 마이그레이션(supabase/migrations/0001·0002·0003)을 적용하고 API Worker를 다시 배포하는 절차(SOP).
           용어 풀이, 값 지도, 단계별 절차와 성공 모습, 실패 시 표. 새 번호 파일을 만드는 법과 사용 기록(fps_events) 읽는 법도 적는다.
-->
# DB 마이그레이션 적용 (SOP)

지금까지는 바뀔 때마다 `supabase/schema.sql` 전체를 SQL Editor에서 다시 실행했다. 11-20에는 실서버에서 그걸 빼먹어 새 무기 가격 줄이 없었고, 산 사람의 포인트만 사라졌다(`docs/POINTS_SOP.md`).
이제는 바뀐 내용을 **번호 붙은 파일**로 나눠 두고, 실서버에 **몇 번까지 넣었는지 DB가 스스로 기록**한다. 그래서 "실행했나?"를 기억이 아니라 한 줄 SQL로 확인한다.

## 1. 용어 풀이

| 말 | 뜻 |
|---|---|
| 마이그레이션 | DB 구조를 바꾸는 SQL 파일 하나. `supabase/migrations/0001_baseline.sql`처럼 **4자리 번호 + 이름**이다. 번호 순서대로 한 번씩 실행한다 |
| 번호(version) | 파일 이름 앞 4자리. 0001부터 빈 번호 없이 이어진다(`npm run check`가 확인) |
| `fps_schema_migrations` | "어느 번호까지 실행했나"를 적는 표. 파일마다 맨 끝에서 자기 번호를 한 줄 넣는다. 같은 파일을 두 번 실행해도 한 줄이다 |
| 0001 기준선(baseline) | 11-23까지의 `schema.sql` 전체 + 위 번호 표. 실서버에는 내용이 이미 있으므로 실행해도 **바뀌는 것은 없고 번호 1만 적힌다** |
| 0002 사용 기록(events) | 익명 사용 기록 표 `fps_events`와 그것을 넣는 함수 `fps_api_log_events`. 게임 → API Worker `POST /v1/events` → 이 함수 |
| 0003 경기 결과(match_results) | 게임 서버가 서명한 경기 결과 표 `fps_match_results`, 사람마다 더한 포인트 장부 `fps_match_points`, 그것을 넣는 함수 `fps_api_apply_match_result`. 게임 서버 → API Worker `POST /v1/match-result` → 이 함수(`docs/MATCH_RESULT_CONTRACT.md`) |
| `schema.sql` | 이제 **자동으로 만드는 전체 사본**이다(모든 번호 파일을 이어 붙인 것). 직접 고치지 않는다. 새 Supabase 프로젝트를 처음 만들 때만 이 파일 하나를 통째로 실행한다 |
| SQL Editor | Supabase 대시보드 왼쪽의 SQL Editor. 여기서 실행한 SQL은 소유자 권한으로 바로 실서버에 들어간다 |
| API Worker | 로그인·결제·사용 기록을 받는 Cloudflare 서버 `skala-api`(`server/api`). DB에는 이 서버만 비밀 키로 쓴다 |
| 다시 배포 | 저장소의 `server/api` 코드를 Cloudflare에 올리는 것(`npm run deploy`). 올리기 전까지 실서버 Worker는 옛 코드다 |

## 2. 값 지도

| 무엇 | 값 / 자리 |
|---|---|
| 실서버 Supabase 주소 | `js/config.js`의 `supabase.url` (`https://tvsoacvbjvggqdgnzijc.supabase.co`) |
| 실행할 파일 | `supabase/migrations/0001_baseline.sql`, `0002_events.sql`, `0003_match_results.sql` (이 순서) |
| 확인 SQL | `select max(version) from public.fps_schema_migrations;` → `3` |
| 경기 결과 받는 주소 | `https://skala-api.skala-fps.workers.dev/v1/match-result` (게임 서버만. 서명 값 `GAME_RESULT_SECRET`이 없으면 404) |
| API Worker 이름·주소 | `skala-api`, `https://skala-api.skala-fps.workers.dev` (`js/config.js`의 `api.url`) |
| Worker 코드 자리 | `server/api` (배포 명령은 이 폴더에서) |
| 사용 기록 받는 주소 | `https://skala-api.skala-fps.workers.dev/v1/events` |
| Worker가 받는 게임 주소 목록 | `server/api/wrangler.toml`의 `ALLOWED_ORIGINS` |
| 사용 기록이 꺼지는 때 | `localhost`·`127.0.0.1`에서 연 게임, 주소 끝 `?telemetry=0`, 브라우저 추적 거부, 자동 시험 브라우저 |

## 3. 순서

> **SQL 먼저(3-2) → Worker 배포(3-3) → 확인(3-4).** 이 브랜치가 main에 합쳐진 뒤에 한다.
> 순서가 어긋나도 게임은 망가지지 않는다: Worker가 옛 코드면 게임의 사용 기록 요청은 404로 버려지고, SQL을 아직 안 넣었으면 Worker가 503으로 버린다. 기록이 그동안 쌓이지 않을 뿐이다.

### 3-1. 최신 main 받기

```powershell
cd E:\jobFolder\skala-data\team-project\fps
git checkout main
git pull
```

성공 모습: `supabase\migrations` 폴더에 `0001_baseline.sql`, `0002_events.sql`이 보인다.

### 3-2. SQL Editor에서 0001, 0002 실행

1. Supabase 대시보드 → 게임 프로젝트(주소가 위 값 지도와 같은지 확인) → **SQL Editor** → **New query**.
2. `supabase/migrations/0001_baseline.sql`을 메모장 등으로 열어 **전체** 복사 → 붙여 넣기 → **Run**.
   - 성공 모습: 아래에 `Success. No rows returned`. (실서버에는 이미 있는 내용이라 데이터는 그대로다)
3. 새 query를 열고 `0002_events.sql` 전체를 같은 방법으로 **Run**.
   - 성공 모습: `Success. No rows returned`.
4. 새 query를 열고 `0003_match_results.sql` 전체를 같은 방법으로 **Run**.
   - 성공 모습: `Success. No rows returned`. 이미 1·2를 했다면 이 파일 하나만 하면 된다.
   - 브라우저 포인트 저장(`p_delta`)은 그대로다. 이 파일은 표와 함수를 더하고, 운영자 조정 기록(`fps_points_log`)의 `actor`에 경기 결과 번호를 적게 할 뿐이다.
5. 확인:

```sql
select version, name, applied_at from public.fps_schema_migrations order by version;
select max(version) from public.fps_schema_migrations;
```

성공 모습: 첫 줄은 `1 baseline`, `2 events`, `3 match_results` 세 줄, 둘째 줄은 `3`.

0003 뒤에는 경기 결과 서명 값을 넣어야 주소가 열린다: `docs/GAME_RESULT_SECRET_SOP.md` 3절(Worker 배포 3-3 뒤에).

### 3-3. API Worker 다시 배포

이 PC는 wrangler 로그인이 되어 있다.

```powershell
cd E:\jobFolder\skala-data\team-project\fps\server\api
npm install
npm run check
npm run deploy
```

- `npm run check`: 올리기 전 묶음 검사(실제로 올리지 않음). 오류 없이 끝나야 한다.
- 성공 모습: `npm run deploy` 끝에 `https://skala-api.skala-fps.workers.dev`와 `Current Version ID`가 찍힌다.
- 브라우저로 `https://skala-api.skala-fps.workers.dev/features`를 열어 `"db":true`가 보이면 Worker가 DB에 닿는다.

### 3-4. 사용 기록이 들어오는지 확인

1. 평소 쓰는 브라우저로 **배포된 게임 주소**를 연다(localhost에서는 보내지 않는다). 연습장에 들어갔다가 메뉴로 나온다.
2. 기록은 15초 모았다가 보내거나 탭을 닫을 때 보낸다. 30초쯤 기다리거나 탭을 닫는다.
3. SQL Editor에서:

```sql
select at, name, mode, map, value from public.fps_events order by id desc limit 20;
```

성공 모습: `session_start`, `match_start`(mode `sandbox`), `match_end`(value = 머문 초) 줄이 보인다. 처음 연 브라우저면 `first_visit`도 있다.

### 3-5. 자주 쓰는 읽기 SQL (선택)

```sql
-- 날짜별 방문 브라우저 수와 세션 수
select date_trunc('day', at) as day, count(distinct anon_id) as visitors, count(*) as sessions
from public.fps_events where name = 'session_start' group by 1 order by 1 desc limit 14;

-- 모드별 경기 수와 평균 시간(초)
select mode, count(*) as matches, round(avg(value)) as avg_seconds
from public.fps_events where name = 'match_end' and at > now() - interval '7 days' group by 1 order by 2 desc;

-- 최근 화면 오류
select at, props ->> 'msg' as msg, props ->> 'src' as file, props ->> 'line' as line
from public.fps_events where name = 'error' order by id desc limit 30;
```

## 4. 새 번호 파일 만들기 (개발할 때)

1. `supabase/migrations/`에 다음 번호로 파일을 만든다. 예: `0003_shop_prices.sql`(소문자·숫자·밑줄).
2. 맨 위 머리말 3줄(Date·Author·Purpose)은 다른 파일에서 복사한다.
3. 다시 실행해도 안전하게 쓴다: `create table if not exists`, `create or replace function`, 지우는 문장(`delete`·`truncate`·`drop table`) 없음.
4. 맨 끝 문장은 자기 번호를 넣는 줄이다:
   `insert into public.fps_schema_migrations (version, name) values (3, 'shop_prices') on conflict (version) do nothing;`
5. `node tools/check-migrations.mjs --write`로 `schema.sql` 사본을 다시 만든다. `npm run check`를 통과시키고 둘 다 커밋한다.
6. **`schema.sql`을 직접 고치지 않는다.** 고치면 `npm run check`가 "schema.sql이 마이그레이션을 이어 붙인 것과 다릅니다"로 떨어진다.
7. PR 본문에 "실서버에 0003 실행 필요"라고 적는다. 소유자는 머지 뒤 그 파일 하나만 3-2처럼 실행하고 `max(version)`이 3인지 본다.

> 새 무기·상품처럼 **DB 값이 먼저 있어야 하는 기능**은, 클라이언트가 배포되기 전에 SQL을 먼저 실행한다. 확인은 `max(version)` 한 줄이다.

## 5. 실패 시

| 보이는 것 | 뜻 | 할 일 |
|---|---|---|
| 0002 실행 중 `relation "public.fps_schema_migrations" does not exist` | 0001을 먼저 안 했다 | 0001을 실행한 뒤 0002를 다시 실행한다 |
| `max(version)`이 `null`이거나 표가 없다는 오류 | 0001을 아직 안 했다 | 3-2의 2번부터 |
| `max(version)`이 1 | 0002를 아직 안 했다 | 3-2의 3번 |
| `max(version)`이 2 | 0003을 아직 안 했다 | 3-2의 4번 |
| 0003 실행 중 `relation "public.fps_players" does not exist` | 0001을 안 했거나 다른 프로젝트에 실행했다 | 프로젝트 주소 확인, 0001부터 |
| `/v1/match-result` **404** | Worker가 옛 코드이거나 `GAME_RESULT_SECRET`이 없다 | 3-3, 그 다음 `docs/GAME_RESULT_SECRET_SOP.md` |
| `/v1/match-result` **503** `DB_MISSING` | 0003을 안 했다 | 3-2의 4번. 그래도면 `notify pgrst, 'reload schema';` |
| 실행 중 다른 오류가 났다 | 붙여 넣기가 잘렸거나 다른 프로젝트에 실행했다 | 프로젝트 주소를 확인하고 파일 **전체**를 다시 복사해 처음부터 실행한다. 여러 번 실행해도 안전하다 |
| `npm run deploy`가 `not logged in`·`Authentication error` | wrangler 로그인이 풀렸다 | `npx wrangler login` 뒤 다시 배포 |
| `/features`에서 `"db":false` | Worker 비밀 키(`SUPABASE_SECRET_KEY`)가 없거나 틀렸다 | `server/api/README.md` 5절대로 secret을 다시 넣고 배포 |
| `fps_events`가 비어 있다 | (1) Worker가 옛 코드 (2) 0002 미실행 (3) localhost에서 열었다 (4) 브라우저 추적 거부가 켜져 있다 | (1) 3-3 다시 (2) 3-2 (3) 배포된 주소로 연다 (4) 정상, 그 브라우저는 보내지 않는다 |
| 브라우저 개발자 도구에 `/v1/events` **404** | Worker가 옛 코드 | 3-3 |
| `/v1/events` **503** `DB_MISSING` | 0002를 안 했거나 API가 새 함수를 아직 모른다 | 0002 실행. 그래도면 SQL Editor에서 `notify pgrst, 'reload schema';` |
| `/v1/events` **403** `origin_not_allowed` | 게임 주소가 Worker 허용 목록에 없다(예: CloudFront로 옮긴 뒤) | `server/api/wrangler.toml`의 `ALLOWED_ORIGINS`에 새 게임 주소(https://…)를 더하고 3-3 |
| `/v1/events` **429** | 같은 IP·같은 브라우저가 너무 많이 보냈다 | 정상 동작. 1분~1시간 뒤 풀린다 |
| `npm run check`가 `schema.sql이 … 다릅니다` | 누가 `schema.sql`을 직접 고쳤다 | 그 내용을 새 번호 파일로 옮기고 `node tools/check-migrations.mjs --write` |
| `npm run check`가 `0003번이 와야 합니다` | 번호를 건너뛰었거나 두 사람이 같은 번호를 썼다 | 늦게 만든 쪽의 번호를 다음 번호로 바꾸고 맨 끝 번호 줄도 같이 바꾼다 |
