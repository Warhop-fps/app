-- Date: 06NOV2026
-- Author: Minkyu Jung
-- Purpose: 마이그레이션 0003. 게임 서버가 서명한 경기 결과(fps_match_results)와 사람마다 더한 포인트 장부(fps_match_points),
--          그리고 한 번만 넣고 포인트를 더하는 fps_api_apply_match_result. 게임 서버(EC2) → API Worker POST /v1/match-result(서명 검증) → 이 함수.
--          약속은 docs/MATCH_RESULT_CONTRACT.md. 한도(32명, 한 사람 한 경기 2,000P)는 server/api/src/result-sign.js와 같다.
--          표는 RLS를 켜고 권한을 모두 없앤다(브라우저가 직접 읽거나 쓰지 못한다). 함수는 service_role만 부른다.
--          여러 번 실행해도 안전하다(docs/DB_MIGRATION_SOP.md).

-- ───────────── 표 ─────────────

-- 한 줄 = 경기 결과 하나. result_id = '<방 번호>:<경기 순번>'. 같은 번호는 한 줄뿐이라 두 번 더해지지 않는다.
create table if not exists public.fps_match_results (
  result_id text primary key check (result_id ~ '^[A-Za-z0-9_-]{1,64}:[0-9]{1,10}$'),
  mode text not null check (mode ~ '^[a-z0-9_-]{1,24}$'),
  map text not null check (map ~ '^[a-z0-9_-]{1,32}$'),
  started_at timestamptz not null,
  ended_at timestamptz not null,
  server_id text not null check (server_id ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  players int not null check (players between 1 and 32),
  points_total int not null check (points_total between 0 and 64000),
  raw jsonb not null check (jsonb_typeof(raw) = 'object' and pg_column_size(raw) <= 32768),
  received_at timestamptz not null default now()
);
create index if not exists fps_match_results_ended_idx on public.fps_match_results (ended_at desc);
alter table public.fps_match_results enable row level security;
revoke all on public.fps_match_results from public, anon, authenticated;

-- 한 줄 = 한 경기에서 한 사람에게 더한 포인트. 회원이 지워지면 장부 줄도 지운다.
create table if not exists public.fps_match_points (
  result_id text not null references public.fps_match_results (result_id) on delete cascade,
  player_id bigint not null references public.fps_players (id) on delete cascade,
  points int not null check (points between 0 and 2000),
  before_points int not null,
  after_points int not null,
  primary key (result_id, player_id)
);
create index if not exists fps_match_points_player_idx on public.fps_match_points (player_id);
alter table public.fps_match_points enable row level security;
revoke all on public.fps_match_points from public, anon, authenticated;

-- ───────────── 운영자 조정 기록 고침 ─────────────

-- 0001의 같은 함수에서 actor 한 칸만 바꾼다: 경기 결과가 바꾼 포인트는 'match:<결과 번호>'로 남긴다(운영자 조정과 구분).
-- points_adjust는 그대로 쌓는다. 그래야 합계를 보내는 옛 탭이 저장할 때 더해 준 포인트를 되돌리지 못한다(docs/POINTS_SOP.md).
create or replace function public.fps_points_adjust_track() returns trigger
language plpgsql set search_path = public, extensions as $$
begin
  if new.points is distinct from old.points and coalesce(current_setting('fps.saving', true), '') <> 'on' then
    new.points_adjust := old.points_adjust + (new.points - old.points);
    insert into public.fps_points_log (player_id, before_points, after_points, actor)
    values (old.id, old.points, new.points, coalesce(nullif(current_setting('fps.match_result', true), ''), current_user));
  end if;
  return new;
end $$;

-- ───────────── Worker 함수 ─────────────

-- 서명을 검증한 경기 결과 하나를 넣는다(Worker가 검증하지만 여기서도 모양과 한도를 다시 본다).
-- 같은 result_id가 이미 있으면 아무것도 바꾸지 않는다: signedAt만 다르면 { ok:true, duplicate:true }, 내용이 다르면 RESULT_CONFLICT.
-- 처음이면 한 트랜잭션에서 결과 줄 → 사람마다 포인트 더하기(1,000만 넘지 않게) → 장부 줄. tokenHash로 회원을 못 찾으면 그 사람만 건너뛴다.
-- 결과: { ok:true, duplicate:false, applied, skipped, points } 또는 { ok:true, duplicate:true } 또는 { ok:false, error }.
-- 코드: RESULT_INVALID, RESULT_CONFLICT
create or replace function public.fps_api_apply_match_result(p_result jsonb) returns jsonb
language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_id text;
  v_players jsonb;
  v_count int;
  v_old jsonb;
  v_p jsonb;
  v_pid bigint;
  v_pts int;
  v_before int;
  v_after int;
  v_applied int := 0;
  v_skipped int := 0;
  v_total int := 0;
begin
  -- 모양: 객체, 칸 이름, 번호, 사람 수
  if p_result is null or jsonb_typeof(p_result) <> 'object' or pg_column_size(p_result) > 32768 then
    return jsonb_build_object('ok', false, 'error', 'RESULT_INVALID');
  end if;
  if (select array_agg(k order by k collate "C") from jsonb_object_keys(p_result) as k)
     is distinct from array['endedAt', 'map', 'matchSeq', 'mode', 'players', 'protocol', 'resultId', 'roomId', 'serverId', 'signedAt', 'startedAt'] then
    return jsonb_build_object('ok', false, 'error', 'RESULT_INVALID');
  end if;
  v_id := case when jsonb_typeof(p_result -> 'resultId') = 'string' then p_result ->> 'resultId' end;
  v_players := p_result -> 'players';
  if v_id is null or v_id !~ '^[A-Za-z0-9_-]{1,64}:[0-9]{1,10}$'
     or p_result -> 'protocol' is distinct from '1'::jsonb
     or jsonb_typeof(p_result -> 'mode') is distinct from 'string' or (p_result ->> 'mode') !~ '^[a-z0-9_-]{1,24}$'
     or jsonb_typeof(p_result -> 'map') is distinct from 'string' or (p_result ->> 'map') !~ '^[a-z0-9_-]{1,32}$'
     or jsonb_typeof(p_result -> 'serverId') is distinct from 'string' or (p_result ->> 'serverId') !~ '^[A-Za-z0-9_.:-]{1,64}$'
     or jsonb_typeof(p_result -> 'startedAt') is distinct from 'number' or (p_result ->> 'startedAt') !~ '^[0-9]{13,14}$'
     or jsonb_typeof(p_result -> 'endedAt') is distinct from 'number' or (p_result ->> 'endedAt') !~ '^[0-9]{13,14}$'
     or jsonb_typeof(v_players) is distinct from 'array' then
    return jsonb_build_object('ok', false, 'error', 'RESULT_INVALID');
  end if;
  v_count := jsonb_array_length(v_players);
  if v_count < 1 or v_count > 32 then return jsonb_build_object('ok', false, 'error', 'RESULT_INVALID'); end if;

  -- 사람마다: 해시 모양, 포인트는 0~2000 정수. 해시가 겹치면 거절
  if exists (
    select 1 from jsonb_array_elements(v_players) as e
    where jsonb_typeof(e) <> 'object'
       or jsonb_typeof(e -> 'tokenHash') is distinct from 'string' or (e ->> 'tokenHash') !~ '^[0-9a-f]{64}$'
       or jsonb_typeof(e -> 'points') is distinct from 'number' or (e ->> 'points') !~ '^[0-9]{1,4}$'
  ) then
    return jsonb_build_object('ok', false, 'error', 'RESULT_INVALID');
  end if;
  if exists (select 1 from jsonb_array_elements(v_players) as e where (e ->> 'points')::int > 2000)
     or (select count(distinct e ->> 'tokenHash') from jsonb_array_elements(v_players) as e) <> v_count then
    return jsonb_build_object('ok', false, 'error', 'RESULT_INVALID');
  end if;

  -- 한 번만: 같은 번호가 동시에 오면 뒤의 것은 앞의 트랜잭션이 끝날 때까지 기다렸다가 여기서 걸린다
  insert into public.fps_match_results (result_id, mode, map, started_at, ended_at, server_id, players, points_total, raw)
  values (v_id, p_result ->> 'mode', p_result ->> 'map',
          to_timestamp((p_result ->> 'startedAt')::numeric / 1000), to_timestamp((p_result ->> 'endedAt')::numeric / 1000),
          p_result ->> 'serverId', v_count,
          (select coalesce(sum((e ->> 'points')::int), 0) from jsonb_array_elements(v_players) as e), p_result)
  on conflict (result_id) do nothing;
  if not found then
    select r.raw into v_old from public.fps_match_results r where r.result_id = v_id;
    if (v_old - 'signedAt') = (p_result - 'signedAt') then
      return jsonb_build_object('ok', true, 'duplicate', true);
    end if;
    return jsonb_build_object('ok', false, 'error', 'RESULT_CONFLICT');
  end if;

  perform set_config('fps.match_result', 'match:' || v_id, true);   -- fps_points_adjust_track가 actor로 적는다
  for v_p in select e from jsonb_array_elements(v_players) as e loop
    v_pts := (v_p ->> 'points')::int;
    v_pid := public.fps_player_id(v_p ->> 'tokenHash');
    if v_pid is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    -- 기기 토큰 둘이 같은 회원이면 한 번만 더한다
    if exists (select 1 from public.fps_match_points m where m.result_id = v_id and m.player_id = v_pid) then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    select p.points into v_before from public.fps_players p where p.id = v_pid for update;
    v_after := least(v_before::bigint + v_pts, 10000000)::int;
    if v_after <> v_before then
      update public.fps_players set points = v_after, updated_at = now() where id = v_pid;
    end if;
    insert into public.fps_match_points (result_id, player_id, points, before_points, after_points)
    values (v_id, v_pid, v_after - v_before, v_before, v_after);
    v_applied := v_applied + 1;
    v_total := v_total + (v_after - v_before);
  end loop;
  perform set_config('fps.match_result', '', true);
  return jsonb_build_object('ok', true, 'duplicate', false, 'applied', v_applied, 'skipped', v_skipped, 'points', v_total);
end $$;

-- ───────────── 실행 권한 ─────────────
revoke all on function public.fps_points_adjust_track() from public, anon, authenticated;
revoke all on function public.fps_api_apply_match_result(jsonb) from public, anon, authenticated;
grant execute on function public.fps_api_apply_match_result(jsonb) to service_role;

-- API가 새 함수를 바로 보도록 스키마 캐시를 다시 읽게 한다.
notify pgrst, 'reload schema';

-- ───────────── 이 파일의 번호 ─────────────
insert into public.fps_schema_migrations (version, name) values (3, 'match_results') on conflict (version) do nothing;
