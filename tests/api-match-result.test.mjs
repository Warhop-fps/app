/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 서명한 경기 결과 받기(POST /v1/match-result)를 시험한다. 비밀 값 없으면 404, 브라우저 Origin 403, 서명·kid·시간 창·모양·크기,
 *          이전 열쇠, DB 결과 전달(적용·중복·충돌·DB 꺼짐), 그리고 supabase/migrations/0003_match_results.sql이 같은 한도·권한인지 글자로 대조한다.
 */
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { route, resetPingCache } from '../server/api/src/worker.js';
import { RESULT_BODY_LIMIT, resultSecrets } from '../server/api/src/match-result.js';
import { MAX_PLAYERS, MAX_POINTS, WINDOW_MS, signResult } from '../server/api/src/result-sign.js';
import { VEC_SECRET, vecResult } from './result-vectors.mjs';

const GAME = 'https://game.test';
const NOW = 1795000601000;
const PREV = 'previous-secret-abcdefghijklmnopqrstuvwx';
const ENV = Object.freeze({
  ALLOWED_ORIGINS: GAME, SUPABASE_URL: 'https://db.test', SUPABASE_SECRET_KEY: 'sb_secret_test',
  GAME_RESULT_SECRET: VEC_SECRET, GAME_RESULT_SECRET_PREV: PREV
});

function fakeFetch(reply = () => ({ ok: true, duplicate: false, applied: 2, skipped: 0, points: 210 })) {
  const calls = [];
  const fetch = async (url, init) => {
    const fn = String(url).split('/rpc/')[1];
    const args = JSON.parse(init.body);
    calls.push({ fn, args });
    const body = reply(args, fn);
    return new Response(JSON.stringify(body), { status: body && body.status ? body.status : 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

function post(body, { origin = null, raw = null } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (origin) headers.Origin = origin;
  return new Request('https://api.test/v1/match-result', { method: 'POST', headers, body: raw ?? JSON.stringify(body) });
}

async function send(body, { env = ENV, f = fakeFetch(), now = NOW, origin = null, raw = null, logs = [] } = {}) {
  const res = await route(post(body, { origin, raw }), env, { fetch: f.fetch, now: () => now, log: (l) => logs.push(l) });
  return { res, status: res.status, body: await res.json(), calls: f.calls, logs };
}

beforeEach(() => resetPingCache());

describe('비밀 값', () => {
  test('지금 값이 없거나 32글자보다 짧으면 주소를 닫는다(404)', async () => {
    assert.deepEqual(resultSecrets({}), []);
    assert.deepEqual(resultSecrets({ GAME_RESULT_SECRET: 'short', GAME_RESULT_SECRET_PREV: PREV }), [], '이전 값만으로는 열지 않는다');
    assert.deepEqual(resultSecrets({ GAME_RESULT_SECRET: VEC_SECRET }), [VEC_SECRET]);
    assert.deepEqual(resultSecrets({ GAME_RESULT_SECRET: VEC_SECRET, GAME_RESULT_SECRET_PREV: VEC_SECRET }), [VEC_SECRET]);
    assert.deepEqual(resultSecrets(ENV), [VEC_SECRET, PREV]);
    const env = await signResult(vecResult(), VEC_SECRET);
    const { GAME_RESULT_SECRET, GAME_RESULT_SECRET_PREV, ...off } = ENV;
    const r = await send(env, { env: off });
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'not_found');
    assert.equal(r.calls.length, 0);
  });
});

describe('POST /v1/match-result', () => {
  test('맞는 결과는 fps_api_apply_match_result로 넘기고 200 적용', async () => {
    const r = await send(await signResult(vecResult(), VEC_SECRET));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, duplicate: false, applied: 2, skipped: 0, points: 210 });
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].fn, 'fps_api_apply_match_result');
    assert.deepEqual(Object.keys(r.calls[0].args), ['p_result']);
    assert.deepEqual(r.calls[0].args.p_result, vecResult());
    assert.equal(r.res.headers.get('access-control-allow-origin'), null, 'CORS 헤더 없음');
    assert.ok(r.logs.some((l) => l.t === 'match_result' && l.id === 'room-A1:3'));
  });

  test('이전 열쇠로 서명한 결과도 받는다(교체 중)', async () => {
    const r = await send(await signResult(vecResult(), PREV));
    assert.equal(r.status, 200);
    assert.equal(r.calls.length, 1);
  });

  test('같은 결과를 다시 보내면 DB가 알려 준 대로 200 중복', async () => {
    const f = fakeFetch(() => ({ ok: true, duplicate: true }));
    const r = await send(await signResult(vecResult(), VEC_SECRET), { f });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, duplicate: true });
  });

  test('같은 번호에 다른 내용이면 409', async () => {
    const f = fakeFetch(() => ({ ok: false, error: 'RESULT_CONFLICT' }));
    const r = await send(await signResult(vecResult(), VEC_SECRET), { f });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'RESULT_CONFLICT');
  });

  test('DB가 모양을 거절하면 400, DB가 없거나 꺼지면 503', async () => {
    const env = await signResult(vecResult(), VEC_SECRET);
    assert.equal((await send(env, { f: fakeFetch(() => ({ ok: false, error: 'RESULT_INVALID' })) })).status, 400);
    const missing = await send(env, { f: fakeFetch(() => ({ status: 404 })) });
    assert.equal(missing.status, 503);
    assert.equal(missing.body.error, 'DB_MISSING');
    const { SUPABASE_URL, ...noDb } = ENV;
    const off = await send(env, { env: noDb });
    assert.equal(off.status, 503);
    assert.equal(off.body.error, 'DB_OFF');
  });

  test('브라우저(Origin 헤더)는 허용 목록에 있어도 403, DB를 부르지 않는다', async () => {
    const env = await signResult(vecResult(), VEC_SECRET);
    for (const origin of [GAME, 'https://evil.test']) {
      const r = await send(env, { origin });
      assert.equal(r.status, 403);
      assert.equal(r.calls.length, 0);
    }
  });

  test('서명이 틀리면 401 BAD_SIGNATURE, 모르는 열쇠면 401 UNKNOWN_KID', async () => {
    const env = await signResult(vecResult(), VEC_SECRET);
    env.result.players[0].points = MAX_POINTS;   // 서명한 뒤 포인트를 올렸다
    const bad = await send(env);
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error, 'BAD_SIGNATURE');
    const stranger = await send(await signResult(vecResult(), 'stranger-secret-0000000000000000000000'));
    assert.equal(stranger.status, 401);
    assert.equal(stranger.body.error, 'UNKNOWN_KID');
    assert.equal(bad.calls.length + stranger.calls.length, 0);
  });

  test('10분 창을 넘은 결과는 401 RESULT_STALE', async () => {
    const env = await signResult(vecResult(), VEC_SECRET);
    const late = await send(env, { now: NOW + WINDOW_MS + 1 });
    assert.equal(late.status, 401);
    assert.equal(late.body.error, 'RESULT_STALE');
    const early = await send(env, { now: NOW - WINDOW_MS - 1 });
    assert.equal(early.status, 401);
    assert.equal(late.calls.length + early.calls.length, 0);
  });

  test('깨진 JSON·모양이 틀린 봉투·너무 큰 본문은 400 BAD_REQUEST', async () => {
    const env = await signResult(vecResult(), VEC_SECRET);
    for (const opts of [
      { raw: '{not json' },
      { raw: '[]' },
      { raw: JSON.stringify({ ...env, extra: 1 }) },
      { raw: JSON.stringify(env) + ' '.repeat(RESULT_BODY_LIMIT) }
    ]) {
      const r = await send(null, opts);
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'BAD_REQUEST');
      assert.equal(r.calls.length, 0);
    }
  });

  test('열쇠를 가진 쪽이라도 한도를 넘는 결과는 서명하지 못하고, 직접 만든 봉투는 400 RESULT_INVALID', async () => {
    const r = vecResult();
    r.players = Array.from({ length: MAX_PLAYERS + 1 }, (_, i) => ({ tokenHash: i.toString(16).padStart(64, '0'), kills: 0, deaths: 0, placement: null, points: 1 }));
    await assert.rejects(() => signResult(r, VEC_SECRET));
    const { createHmac } = await import('node:crypto');
    const { keyId, signingText } = await import('../server/api/src/result-sign.js');
    const sig = createHmac('sha256', VEC_SECRET).update(signingText(r)).digest('base64url');
    const res = await send({ kid: await keyId(VEC_SECRET), sig, result: r });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'RESULT_INVALID');
    assert.equal(res.body.problem, 'players');
    assert.equal(res.calls.length, 0);
  });

  test('GET은 이 주소가 없다(404)', async () => {
    const res = await route(new Request('https://api.test/v1/match-result'), ENV, { fetch: fakeFetch().fetch });
    assert.equal(res.status, 404);
  });
});

describe('0003_match_results.sql ↔ Worker', () => {
  const sql = readFileSync(new URL('../supabase/migrations/0003_match_results.sql', import.meta.url), 'utf8');
  const code = sql.split(/\r?\n/).filter((l) => !l.trimStart().startsWith('--')).join('\n');
  const fn = code.match(/create or replace function public\.fps_api_apply_match_result\(p_result jsonb\)[\s\S]*?\$\$([\s\S]*?)\$\$;/);

  test('함수는 SECURITY DEFINER이고 service_role만 부른다', () => {
    assert.ok(fn, '함수 정의');
    assert.match(fn[0], /security definer set search_path = public, extensions/);
    assert.match(code, /revoke all on function public\.fps_api_apply_match_result\(jsonb\) from public, anon, authenticated;/);
    assert.match(code, /grant execute on function public\.fps_api_apply_match_result\(jsonb\) to service_role;/);
    assert.ok(!/grant [^;]*fps_api_apply_match_result[^;]*\b(anon|authenticated)\b/.test(code));
  });

  test('표는 RLS를 켜고 권한을 없앤다. 정책을 만들지 않는다', () => {
    for (const t of ['fps_match_results', 'fps_match_points']) {
      assert.match(code, new RegExp(`alter table public\\.${t} enable row level security;`), t);
      assert.match(code, new RegExp(`revoke all on public\\.${t} from public, anon, authenticated;`), t);
    }
    assert.ok(!/create policy/i.test(code));
  });

  test('한도가 Worker 모듈과 같다(사람 수·한 사람 포인트·칸 이름)', () => {
    const body = fn[1];
    assert.match(body, new RegExp(`v_count < 1 or v_count > ${MAX_PLAYERS}\\b`));
    assert.match(body, new RegExp(`::int > ${MAX_POINTS}\\b`));
    assert.match(code, new RegExp(`points int not null check \\(points between 0 and ${MAX_POINTS}\\)`));
    assert.match(code, new RegExp(`players int not null check \\(players between 1 and ${MAX_PLAYERS}\\)`));
    const keys = body.match(/is distinct from array\[([^\]]*)\]/)[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
    assert.deepEqual(keys, Object.keys(vecResult()).sort(), '칸 이름(정렬)이 result와 같다');
  });

  test('한 번만 넣는다: on conflict do nothing 뒤 signedAt을 뺀 비교로 중복·충돌을 가른다', () => {
    const body = fn[1];
    assert.match(body, /on conflict \(result_id\) do nothing;\s*if not found then/);
    assert.match(body, /\(v_old - 'signedAt'\) = \(p_result - 'signedAt'\)/);
    assert.match(body, /'RESULT_CONFLICT'/);
    assert.match(body, /least\(v_before::bigint \+ v_pts, 10000000\)/, '포인트 상한 1,000만');
    assert.match(body, /public\.fps_player_id\(v_p ->> 'tokenHash'\)/, '로그인 기기 토큰도 같은 회원으로 찾는다');
  });

  test('운영자 조정 기록에는 결과 번호가 actor로 남고 points_adjust는 그대로 쌓인다', () => {
    assert.match(code, /new\.points_adjust := old\.points_adjust \+ \(new\.points - old\.points\);/);
    assert.match(code, /coalesce\(nullif\(current_setting\('fps\.match_result', true\), ''\), current_user\)/);
    assert.match(fn[1], /set_config\('fps\.match_result', 'match:' \|\| v_id, true\)/);
  });
});
