/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 게임 사용 기록(POST /v1/events)을 시험한다. Worker 검사(이름 목록·칸·크기·개수·모르는 칸), Origin 확인, IP 한도, DB 결과 전달,
 *          그리고 supabase/migrations/0002_events.sql의 표·함수가 Worker와 같은 규칙인지(이름 목록, 20개, RLS, service_role만) 글자로 대조한다.
 */
import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { route, resetPingCache } from '../server/api/src/worker.js';
import { EVENT_NAMES, EVENTS_BODY_LIMIT, IP_LIMIT, cleanEvent, createIpLimiter, readBatch, resetEventLimits } from '../server/api/src/events.js';

const GAME = 'https://game.test';
const ENV = Object.freeze({ ALLOWED_ORIGINS: GAME, SUPABASE_URL: 'https://db.test', SUPABASE_SECRET_KEY: 'sb_secret_test' });
const A = 'a'.repeat(32);
const S = 'b'.repeat(32);

function fakeFetch(reply = (args) => ({ ok: true, n: args.p_events.length })) {
  const calls = [];
  const fetch = async (url, init) => {
    const fn = String(url).split('/rpc/')[1];
    const args = JSON.parse(init.body);
    calls.push({ fn, args, headers: init.headers });
    const body = reply(args, fn);
    return new Response(JSON.stringify(body), { status: body && body.status ? body.status : 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

function post(body, { origin = GAME, ip = '203.0.113.5', raw = null, type = 'text/plain;charset=UTF-8' } = {}) {
  const headers = { 'content-type': type };
  if (origin) headers.Origin = origin;
  if (ip) headers['cf-connecting-ip'] = ip;
  return new Request('https://api.test/v1/events', { method: 'POST', headers, body: raw ?? JSON.stringify(body) });
}

const batch = (events, over = {}) => ({ anonId: A, sessionId: S, events, ...over });

beforeEach(() => {
  resetEventLimits();
  resetPingCache();
});

describe('사건 검사(events.js)', () => {
  test('정한 이름만 받고 칸을 깨끗이 옮긴다', () => {
    for (const name of EVENT_NAMES) assert.deepEqual(cleanEvent({ name }), { name });
    assert.equal(cleanEvent({ name: 'purchase' }), null);
    assert.deepEqual(cleanEvent({ name: 'match_end', at: 1700000000000.4, mode: 'ffa', map: 'railyard', value: 312, props: { won: true } }),
      { name: 'match_end', at: 1700000000000, mode: 'ffa', map: 'railyard', value: 312, props: { won: true } });
  });

  test('개인 정보가 들어갈 수 있는 모르는 칸·모양이 틀린 값은 거절한다', () => {
    assert.equal(cleanEvent({ name: 'ping', email: 'x@y.z' }), null);
    assert.equal(cleanEvent({ name: 'ping', mode: 'FFA' }), null);
    assert.equal(cleanEvent({ name: 'ping', map: 'a/b' }), null);
    assert.equal(cleanEvent({ name: 'ping', value: Infinity }), null);
    assert.equal(cleanEvent({ name: 'ping', value: 2e9 }), null);
    assert.equal(cleanEvent({ name: 'ping', at: '1' }), null);
    assert.equal(cleanEvent({ name: 'ping', props: [] }), null);
    assert.equal(cleanEvent({ name: 'ping', props: { deep: { a: 1 } } }), null);
    assert.equal(cleanEvent({ name: 'ping', props: { 'bad key': 1 } }), null);
    assert.equal(cleanEvent({ name: 'ping', props: { s: 'x'.repeat(121) } }), null);
    const many = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, i]));
    assert.equal(cleanEvent({ name: 'ping', props: many }), null);
    const big = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`k${i}`, 'y'.repeat(110)]));
    assert.equal(cleanEvent({ name: 'ping', props: big }), null, '합쳐 512자를 넘는다');
  });

  test('묶음: 번호 모양, 1~20개, 모르는 칸, 하나라도 틀리면 전체 거절', () => {
    assert.ok(readBatch(batch([{ name: 'ping' }])));
    assert.equal(readBatch(batch([])), null);
    assert.equal(readBatch(batch(Array.from({ length: 21 }, () => ({ name: 'ping' })))), null);
    assert.ok(readBatch(batch(Array.from({ length: 20 }, () => ({ name: 'ping' })))));
    assert.equal(readBatch(batch([{ name: 'ping' }], { anonId: 'A'.repeat(32) })), null);
    assert.equal(readBatch(batch([{ name: 'ping' }], { sessionId: 'b'.repeat(31) })), null);
    assert.equal(readBatch(batch([{ name: 'ping' }], { name: '철수' })), null);
    assert.equal(readBatch(batch([{ name: 'ping' }, { name: 'nope' }])), null);
  });

  test('IP 한도는 창이 지나면 다시 센다', () => {
    const lim = createIpLimiter({ limit: 5, windowMs: 1000 });
    assert.ok(lim.take('1.1.1.1', 5, 0));
    assert.ok(!lim.take('1.1.1.1', 1, 10));
    assert.ok(lim.take('2.2.2.2', 1, 10), '다른 IP는 따로 센다');
    assert.ok(lim.take('1.1.1.1', 1, 1000));
    assert.ok(lim.take(null, 999, 0), 'IP를 모르면 DB 한도에 맡긴다');
  });
});

describe('POST /v1/events', () => {
  test('맞는 묶음은 fps_api_log_events로 넘기고 CORS 헤더를 붙인다', async () => {
    const f = fakeFetch();
    const r = await route(post(batch([{ name: 'session_start' }, { name: 'match_start', mode: 'tdm', map: 'cqb' }])), ENV, { fetch: f.fetch });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, n: 2 });
    assert.equal(r.headers.get('access-control-allow-origin'), GAME);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].fn, 'fps_api_log_events');
    assert.deepEqual(Object.keys(f.calls[0].args).sort(), ['p_anon_id', 'p_events', 'p_session_id']);
    assert.equal(f.calls[0].args.p_events[1].map, 'cqb');
  });

  test('허용하지 않은 Origin은 DB를 부르지 않고 403', async () => {
    const f = fakeFetch();
    const r = await route(post(batch([{ name: 'ping' }]), { origin: 'https://evil.test' }), ENV, { fetch: f.fetch });
    assert.equal(r.status, 403);
    assert.equal(f.calls.length, 0);
  });

  test('틀린 묶음·깨진 JSON·너무 큰 본문은 400', async () => {
    const f = fakeFetch();
    for (const req of [
      post(batch([{ name: 'nope' }])),
      post(null, { raw: '{not json' }),
      post(null, { raw: JSON.stringify(batch([{ name: 'ping', props: { s: 'x' } }])) + ' '.repeat(EVENTS_BODY_LIMIT) })
    ]) {
      const r = await route(req, ENV, { fetch: f.fetch });
      assert.equal(r.status, 400);
      assert.equal((await r.json()).error, 'BAD_REQUEST');
    }
    assert.equal(f.calls.length, 0);
  });

  test('같은 IP가 1분에 한도를 넘으면 429', async () => {
    const f = fakeFetch();
    const twenty = Array.from({ length: 20 }, () => ({ name: 'ping' }));
    let last;
    for (let i = 0; i * 20 <= IP_LIMIT; i++) last = await route(post(batch(twenty)), ENV, { fetch: f.fetch, now: () => 1000 });
    assert.equal(last.status, 429);
    assert.equal(f.calls.length, IP_LIMIT / 20);
  });

  test('DB 한도·DB 꺼짐은 상태 코드로 알린다', async () => {
    const limited = fakeFetch(() => ({ ok: false, error: 'RATE_LIMITED' }));
    assert.equal((await route(post(batch([{ name: 'ping' }])), ENV, { fetch: limited.fetch })).status, 429);
    const off = await route(post(batch([{ name: 'ping' }])), { ALLOWED_ORIGINS: GAME }, { fetch: fakeFetch().fetch });
    assert.equal(off.status, 503);
    assert.equal((await off.json()).error, 'DB_OFF');
  });
});

describe('0002_events.sql ↔ Worker', () => {
  const sql = readFileSync(new URL('../supabase/migrations/0002_events.sql', import.meta.url), 'utf8');
  const code = sql.split(/\r?\n/).filter((l) => !l.trimStart().startsWith('--')).join('\n');
  const names = (re) => code.match(re)[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));

  test('표와 함수의 이름 목록이 Worker와 같다', () => {
    assert.deepEqual(names(/name text not null check \(name in \(([^)]*)\)\)/), [...EVENT_NAMES]);
    assert.deepEqual(names(/e ->> 'name' in \(([^)]*)\)/), [...EVENT_NAMES]);
    assert.match(code, /v_count < 1 or v_count > 20/);
  });

  test('표는 브라우저가 못 읽고 못 쓴다. 함수는 service_role만 부른다', () => {
    assert.match(code, /alter table public\.fps_events enable row level security;/);
    assert.match(code, /revoke all on public\.fps_events from public, anon, authenticated;/);
    assert.match(code, /revoke all on sequence public\.fps_events_id_seq from public, anon, authenticated;/);
    assert.ok(!/create policy/i.test(code));
    assert.match(code, /revoke all on function public\.fps_api_log_events\(text, text, jsonb\) from public, anon, authenticated;/);
    assert.match(code, /grant execute on function public\.fps_api_log_events\(text, text, jsonb\) to service_role;/);
    assert.ok(!/grant [^;]*fps_api_log_events[^;]*\b(anon|authenticated)\b/.test(code));
  });

  test('개인 정보 칸이 없다', () => {
    const table = code.match(/create table if not exists public\.fps_events \(([\s\S]*?)\n\);/)[1];
    // name 칸은 사건 이름(정한 6가지)이라 괜찮다
    for (const bad of ['email', 'ip', 'token', 'token_hash', 'player_id', 'nickname']) {
      assert.ok(!new RegExp(`^\\s*${bad}\\b`, 'm').test(table), bad);
    }
  });
});
