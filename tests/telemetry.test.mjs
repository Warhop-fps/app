/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 익명 사용 기록 클라이언트(js/net/telemetry.js)를 가짜 window로 시험한다.
 *          꺼지는 때(API 주소 없음·Node·자동 조작·localhost·거부)에 아무것도 보내지 않는가, 처음 방문·세션·경기 시작과 끝·오류를 모아
 *          20개씩 보내는가, 보낸 본문이 Worker 검사(server/api/src/events.js readBatch)를 통과하는가, 무엇이 망가져도 예외를 던지지 않는가.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createBus } from '../js/core/bus.js';
import { ANON_KEY, BATCH_MAX, ERROR_MAX, FLUSH_MS, createTelemetry, installTelemetry, offReason, scrubText } from '../js/net/telemetry.js';
import { readBatch } from '../server/api/src/events.js';

const API = { url: 'https://api.test' };

function fakeEnv({ host = 'game.test', search = '', webdriver = false, storage = new Map(), beacon = true, dnt = null, brokenStorage = false } = {}) {
  const sent = [];
  const timers = [];
  const listeners = new Map();
  const target = (store) => ({
    addEventListener: (t, fn) => store.set(t, [...(store.get(t) || []), fn]),
    removeEventListener: (t, fn) => store.set(t, (store.get(t) || []).filter((f) => f !== fn))
  });
  const docListeners = new Map();
  const env = {
    ...target(listeners),
    document: { visibilityState: 'visible', ...target(docListeners) },
    location: { hostname: host, search },
    navigator: {
      webdriver,
      doNotTrack: dnt,
      sendBeacon: beacon ? (url, blob) => { sent.push({ via: 'beacon', url, text: blob.text }); return true; } : undefined
    },
    Blob: class { constructor(parts, opts) { this.text = parts.join(''); this.type = opts.type; } },
    fetch: (url, init) => { sent.push({ via: 'fetch', url, text: init.body, init }); return Promise.resolve(new Response('{}')); },
    localStorage: brokenStorage
      ? { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } }
      : { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)) },
    crypto: globalThis.crypto,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    matchMedia: () => ({ matches: false })
  };
  const fire = (type, e) => { for (const fn of listeners.get(type) || []) fn(e); };
  const bodies = () => sent.map((s) => JSON.parse(s.text));
  return { env, sent, timers, storage, fire, bodies };
}

describe('꺼지는 때', () => {
  test('Node(시험)에서는 전역으로 만들어도 꺼지고 아무것도 하지 않는다', () => {
    const t = createTelemetry({ config: API });
    assert.equal(t.enabled, false);
    assert.equal(t.reason, 'not_browser');
    assert.doesNotThrow(() => { t.track('ping'); t.flush(true); t.install({ bus: createBus() })(); });
    assert.doesNotThrow(() => installTelemetry({ bus: createBus() })());
  });

  test('API 주소가 없거나 틀리면 꺼진다', () => {
    const f = fakeEnv();
    assert.equal(createTelemetry({ config: { url: '' }, env: f.env }).reason, 'no_api');
    assert.equal(createTelemetry({ config: { url: 'ftp://x' }, env: f.env }).reason, 'no_api');
    assert.equal(createTelemetry({ env: f.env }).reason, 'no_api', 'env.SKALA_CONFIG가 없다');
    f.env.SKALA_CONFIG = { api: API };
    assert.equal(createTelemetry({ env: f.env }).enabled, true, 'config를 주지 않으면 env.SKALA_CONFIG.api를 읽는다');
  });

  test('자동 조작·localhost·거부·Do Not Track이면 꺼진다', () => {
    assert.equal(offReason(fakeEnv({ webdriver: true }).env, API.url), 'automation');
    assert.equal(offReason(fakeEnv({ search: '?autoplay=1' }).env, API.url), 'automation');
    assert.equal(offReason(fakeEnv({ host: 'localhost' }).env, API.url), 'local');
    assert.equal(offReason(fakeEnv({ host: '127.0.0.1' }).env, API.url), 'local');
    assert.equal(offReason(fakeEnv({ host: 'localhost', search: '?telemetry=1' }).env, API.url), null);
    assert.equal(offReason(fakeEnv({ search: '?telemetry=0' }).env, API.url), 'opt_out');
    assert.equal(offReason(fakeEnv({ dnt: '1' }).env, API.url), 'do_not_track');
    assert.equal(offReason(fakeEnv().env, API.url), null);
  });

  test('꺼져 있으면 install해도 아무것도 보내지 않는다', () => {
    const f = fakeEnv({ host: 'localhost' });
    const bus = createBus();
    const t = createTelemetry({ config: API, env: f.env });
    t.install({ bus });
    bus.emit('screen:change', { from: 'room', to: 'match', params: { mode: 'ffa', mapId: 'cqb' } });
    t.flush(true);
    assert.equal(f.sent.length, 0);
    assert.equal(f.storage.size, 0, 'anon id도 만들지 않는다');
  });
});

describe('켜져 있을 때', () => {
  test('처음 방문이면 first_visit, 다음 방문은 session_start만', () => {
    const f = fakeEnv();
    const t1 = createTelemetry({ config: API, env: f.env });
    t1.install({});
    t1.flush(true);
    const first = f.bodies()[0];
    assert.deepEqual(first.events.map((e) => e.name), ['first_visit', 'session_start']);
    assert.equal(first.anonId, f.storage.get(ANON_KEY));
    assert.match(first.sessionId, /^[a-f0-9]{32}$/);

    const t2 = createTelemetry({ config: API, env: f.env });
    t2.install({});
    t2.flush(true);
    const second = f.bodies()[1];
    assert.deepEqual(second.events.map((e) => e.name), ['session_start']);
    assert.equal(second.anonId, first.anonId);
    assert.notEqual(second.sessionId, first.sessionId);
  });

  test('경기 시작·끝: 모드·맵·걸린 초. 연습장도 센다. 본문이 Worker 검사를 통과한다', () => {
    const f = fakeEnv();
    let clock = 1_700_000_000_000;
    const bus = createBus();
    const t = createTelemetry({ config: API, env: f.env, now: () => clock });
    t.install({ bus });
    bus.emit('screen:change', { from: 'room', to: 'match', params: { mode: 'TDM', mapId: 'railyard' } });
    clock += 125_000;
    bus.emit('screen:change', { from: 'match', to: 'results', params: {} });
    bus.emit('screen:change', { from: 'menu', to: 'sandbox', params: { mapId: 'testyard' } });
    clock += 30_000;
    bus.emit('screen:change', { from: 'sandbox', to: 'menu', params: {} });
    t.flush(false);
    const body = f.bodies()[0];
    const evs = body.events.filter((e) => e.name.startsWith('match_'));
    assert.deepEqual(evs.map((e) => [e.name, e.mode, e.map]), [
      ['match_start', 'tdm', 'railyard'], ['match_end', 'tdm', 'railyard'],
      ['match_start', 'sandbox', 'testyard'], ['match_end', 'sandbox', 'testyard']
    ]);
    assert.equal(evs[1].value, 125);
    assert.equal(evs[1].props.to, 'results');
    assert.equal(evs[3].value, 30);
    assert.ok(readBatch(body), 'Worker가 받는 모양');
    assert.equal(f.sent[0].via, 'fetch');
    assert.equal(f.sent[0].init.keepalive, true);
    assert.equal(f.sent[0].init.credentials, 'omit');
    assert.equal(f.sent[0].url, 'https://api.test/v1/events');
  });

  test('페이지를 닫으면 하던 경기를 끝내고 sendBeacon으로 보낸다', () => {
    const f = fakeEnv();
    const bus = createBus();
    createTelemetry({ config: API, env: f.env }).install({ bus });
    bus.emit('screen:change', { from: 'room', to: 'match', params: { mode: 'bomb', mapId: 'observatory' } });
    f.fire('pagehide', {});
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].via, 'beacon');
    const names = f.bodies()[0].events.map((e) => e.name);
    assert.deepEqual(names.slice(-2), ['match_start', 'match_end']);
  });

  test('20개가 모이면 바로 보내고, 그 전에는 15초 타이머를 건다', () => {
    const f = fakeEnv();
    const t = createTelemetry({ config: API, env: f.env });
    t.track('ping');
    assert.equal(f.sent.length, 0);
    assert.equal(f.timers[0].ms, FLUSH_MS);
    for (let i = 1; i < BATCH_MAX; i++) t.track('ping', { value: i });
    assert.equal(f.sent.length, 1);
    assert.equal(f.bodies()[0].events.length, BATCH_MAX);
    assert.equal(t.pending(), 0);
  });

  test('오류: 세션당 5개, 이메일·주소 꼬리를 지우고 파일 이름만', () => {
    const f = fakeEnv();
    const t = createTelemetry({ config: API, env: f.env });
    t.install({});
    for (let i = 0; i < ERROR_MAX + 3; i++) {
      f.fire('error', { message: `boom kim@example.com https://x.test/a.js?token=abc ${i}`, filename: 'https://game.test/js/game/session.js?v=3', lineno: 42 });
    }
    t.flush(true);
    const errs = f.bodies().flatMap((b) => b.events).filter((e) => e.name === 'error');
    assert.equal(errs.length, ERROR_MAX);
    assert.equal(errs[0].props.src, 'session.js');
    assert.equal(errs[0].props.line, 42);
    assert.ok(!errs[0].props.msg.includes('kim@example.com'));
    assert.ok(!errs[0].props.msg.includes('token=abc'));
    for (const b of f.bodies()) assert.ok(readBatch(b));
  });

  test('저장소가 막힌 브라우저: 처음 방문은 모르지만 세션은 보낸다', () => {
    const f = fakeEnv({ brokenStorage: true });
    const t = createTelemetry({ config: API, env: f.env });
    assert.equal(t.enabled, true);
    t.install({});
    t.flush(true);
    assert.deepEqual(f.bodies()[0].events.map((e) => e.name), ['session_start']);
  });

  test('보내기가 망가져도 예외를 던지지 않는다', () => {
    const f = fakeEnv({ beacon: false });
    f.env.fetch = () => { throw new Error('network down'); };
    const t = createTelemetry({ config: API, env: f.env });
    assert.doesNotThrow(() => {
      t.install({ bus: { on() { throw new Error('bad bus'); } } });
      t.track('ping', { props: { ok: true, bad: { deep: 1 } } });
      t.track('match_end', null);
      t.flush(true);
    });
  });

  test('scrubText는 120자로 자른다', () => {
    assert.equal(scrubText('x'.repeat(300)).length, 120);
    assert.equal(scrubText(null), '');
  });
});
