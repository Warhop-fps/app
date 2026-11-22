-- Date: 06NOV2026
-- Author: Minkyu Jung
-- Purpose: 마이그레이션 0002. 게임 사용 기록(fps_events)과 그것을 넣는 fps_api_log_events.
--          브라우저(js/net/telemetry.js)가 server/api Worker의 POST /v1/events로 보내고, Worker만 비밀 키로 이 함수를 부른다.
--          개인 정보는 받지 않는다: 이름·이메일·IP·기기 토큰 없이, 브라우저가 만든 무작위 번호(anon_id·session_id)만 쓴다.
--          표는 RLS를 켜고 권한을 모두 없앤다(브라우저가 직접 읽거나 쓰지 못한다). 소유자는 대시보드 SQL Editor에서 읽는다.
--          여러 번 실행해도 안전하다(docs/DB_MIGRATION_SOP.md).

-- ───────────── 표 ─────────────

-- 한 줄 = 사건 하나. name은 정한 6가지만, props는 작은 객체(1 KB 이하)만 받는다.
create table if not exists public.fps_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  anon_id text not null check (anon_id ~ '^[a-f0-9]{32}$'),
  session_id text not null check (session_id ~ '^[a-f0-9]{32}$'),
  name text not null check (name in ('first_visit', 'session_start', 'match_start', 'match_end', 'ping', 'error')),
  mode text check (mode is null or mode ~ '^[a-z0-9_-]{1,24}$'),
  map text check (map is null or map ~ '^[a-z0-9_-]{1,32}$'),
  value numeric check (value is null or abs(value) <= 1000000000),
  props jsonb check (props is null or (jsonb_typeof(props) = 'object' and pg_column_size(props) <= 1024))
);
create index if not exists fps_events_at_idx on public.fps_events (at desc);
create index if not exists fps_events_name_idx on public.fps_events (name, at desc);
alter table public.fps_events enable row level security;
revoke all on public.fps_events from public, anon, authenticated;
revoke all on sequence public.fps_events_id_seq from public, anon, authenticated;

-- ───────────── Worker 함수 ─────────────

-- 사건 묶음(1~20개)을 넣는다. 같은 anon_id는 한 시간에 600개까지(fps_rate에 'events:<anon_id>'로 센다).
-- 모양이 틀린 사건은 버리고 나머지만 넣는다. 시각(at, 밀리초)이 지금과 하루 넘게 다르면 지금 시각으로 바꾼다.
-- 결과: { ok:true, n } 또는 { ok:false, error }. 코드: EVENTS_INVALID, RATE_LIMITED
create or replace function public.fps_api_log_events(p_anon_id text, p_session_id text, p_events jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_count int;
  v_hits int;
  v_n int;
begin
  if p_anon_id is null or p_anon_id !~ '^[a-f0-9]{32}$' or p_session_id is null or p_session_id !~ '^[a-f0-9]{32}$'
     or p_events is null or jsonb_typeof(p_events) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'EVENTS_INVALID');
  end if;
  v_count := jsonb_array_length(p_events);
  if v_count < 1 or v_count > 20 then return jsonb_build_object('ok', false, 'error', 'EVENTS_INVALID'); end if;

  insert into public.fps_rate as r (bucket, window_start, hits)
  values ('events:' || p_anon_id, now(), v_count)
  on conflict (bucket) do update
    set hits = case when r.window_start < now() - interval '1 hour' then v_count else r.hits + v_count end,
        window_start = case when r.window_start < now() - interval '1 hour' then now() else r.window_start end
  returning hits into v_hits;
  if v_hits > 600 then return jsonb_build_object('ok', false, 'error', 'RATE_LIMITED'); end if;

  insert into public.fps_events (at, anon_id, session_id, name, mode, map, value, props)
  select
    -- 숫자인지 먼저 보고 나서 바꾼다(Postgres는 and의 앞쪽을 먼저 계산한다고 약속하지 않는다)
    case when jsonb_typeof(e -> 'at') = 'number' then
      case when abs((e ->> 'at')::numeric - extract(epoch from now())::numeric * 1000) < 86400000
           then to_timestamp((e ->> 'at')::numeric / 1000) else now() end
    else now() end,
    p_anon_id, p_session_id, e ->> 'name',
    case when jsonb_typeof(e -> 'mode') = 'string' and (e ->> 'mode') ~ '^[a-z0-9_-]{1,24}$' then e ->> 'mode' end,
    case when jsonb_typeof(e -> 'map') = 'string' and (e ->> 'map') ~ '^[a-z0-9_-]{1,32}$' then e ->> 'map' end,
    case when jsonb_typeof(e -> 'value') = 'number' then
      case when abs((e ->> 'value')::numeric) <= 1000000000 then (e ->> 'value')::numeric end
    end,
    case when jsonb_typeof(e -> 'props') = 'object' and pg_column_size(e -> 'props') <= 1024 then e -> 'props' end
  from jsonb_array_elements(p_events) as e
  where jsonb_typeof(e) = 'object'
    and e ->> 'name' in ('first_visit', 'session_start', 'match_start', 'match_end', 'ping', 'error');
  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'n', v_n);
end $$;

-- ───────────── 실행 권한 ─────────────
revoke all on function public.fps_api_log_events(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.fps_api_log_events(text, text, jsonb) to service_role;

-- API가 새 함수를 바로 보도록 스키마 캐시를 다시 읽게 한다.
notify pgrst, 'reload schema';

-- ───────────── 이 파일의 번호 ─────────────
insert into public.fps_schema_migrations (version, name) values (2, 'events') on conflict (version) do nothing;
