/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 권위 서버의 순수 부품 시험. 메시지 검사(decodeClient)·이름 정리·스냅샷 줄, 토큰 버킷·위반 점수, 고정 간격 루프, 지표 출력, 로그 형식을 본다.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CLIENT_TYPES, KEY_MASK, MAX_SEQ, PRESS_MASK, PROTOCOL, ROW, cleanName, decodeClient, decodeRow, encodeRow } from '../src/protocol.mjs';
import { TokenBucket, createStrikes } from '../src/limits.mjs';
import { createLoop } from '../src/loop.mjs';
import { createMetrics } from '../src/metrics.mjs';
import { createLogger, memoryStream } from '../src/log.mjs';
import { loadConfig } from '../src/config.mjs';

const enc = (o) => JSON.stringify(o);

describe('decodeClient', () => {
  test('join: 방 id를 소문자로, 이름을 정리하고 모르는 팀·옵션은 버린다', () => {
    const r = decodeClient(enc({ t: 'join', v: PROTOCOL, room: ' Demo_1 ', name: '  철수‮\u0007 ', team: 'blue', opts: { map: 'arena', mode: 'ffa', ruleset: 'knife', x: 1 } }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.msg, { t: 'join', v: PROTOCOL, room: 'demo_1', name: '철수', team: null, opts: { map: 'arena', mode: 'ffa', ruleset: 'knife' } });
  });

  test('join: 방 id 형식과 버전 정수를 요구한다', () => {
    assert.equal(decodeClient(enc({ t: 'join', v: 1, room: '../etc' })).ok, false);
    assert.equal(decodeClient(enc({ t: 'join', v: 1, room: 'x'.repeat(33) })).ok, false);
    assert.equal(decodeClient(enc({ t: 'join', v: '1', room: 'a' })).ok, false);
    assert.equal(decodeClient(enc({ t: 'join', v: 99, room: 'a' })).ok, true, '버전이 달라도 형식은 맞다(서버가 bad_version으로 끊는다)');
  });

  test('in: yaw는 감고 pitch는 ±89°로 자르고 비트는 가린다', () => {
    const r = decodeClient(enc({ t: 'in', s: 5, k: 0xffff, y: Math.PI * 3, p: 5, w: 2, b: 0xff, vt: 120.5 }));
    assert.equal(r.ok, true);
    assert.equal(r.msg.k, KEY_MASK);
    assert.equal(r.msg.b, PRESS_MASK);
    assert.ok(Math.abs(Math.abs(r.msg.y) - Math.PI) < 1e-9);
    assert.ok(Math.abs(r.msg.p - (89 * Math.PI) / 180) < 1e-12);
    assert.equal(r.msg.w, 2);
    assert.equal(r.msg.vt, 120.5);
    const bare = decodeClient(enc({ t: 'in', s: 0, y: 0, p: 0 }));
    assert.deepEqual(bare.msg, { t: 'in', s: 0, k: 0, y: 0, p: 0, w: 0, b: 0, vt: null });
  });

  test('in: 숫자가 아니거나 범위를 벗어나면 버린다', () => {
    const bad = [
      { t: 'in', s: -1, y: 0, p: 0 }, { t: 'in', s: 1.5, y: 0, p: 0 }, { t: 'in', s: MAX_SEQ + 1, y: 0, p: 0 },
      { t: 'in', s: 1, y: 'x', p: 0 }, { t: 'in', s: 1, y: 0 }, { t: 'in', s: 1, y: 1e9, p: 0 },
      { t: 'in', s: 1, y: 0, p: 0, w: 5 }, { t: 'in', s: 1, y: 0, p: 0, k: 1.5 }, { t: 'in', s: 1, y: 0, p: 0, vt: 'x' }
    ];
    for (const m of bad) assert.equal(decodeClient(enc(m)).reason, 'bad_field', JSON.stringify(m));
    // JSON에는 NaN·Infinity가 없다: 1e999는 Infinity로 읽혀 거절된다
    assert.equal(decodeClient('{"t":"in","s":1,"y":1e999,"p":0}').reason, 'bad_field');
  });

  test('모르는 형식·깨진 JSON·배열은 이유와 함께 거절', () => {
    assert.equal(decodeClient('{"t":"chat","text":"hi"}').reason, 'unknown_type');
    assert.equal(decodeClient('{"t":"toString"}').reason, 'unknown_type', 'Object.prototype 이름도 형식이 아니다');
    assert.equal(decodeClient('{"t":"__proto__"}').reason, 'unknown_type');
    assert.equal(decodeClient('{"x":1}').reason, 'unknown_type');
    assert.equal(decodeClient('{oops').reason, 'bad_json');
    assert.equal(decodeClient('[1,2]').reason, 'bad_shape');
    assert.equal(decodeClient('null').reason, 'bad_shape');
    assert.deepEqual(CLIENT_TYPES, ['join', 'in', 'pick', 'team', 'start']);
  });

  test('pick·team·start', () => {
    assert.deepEqual(decodeClient(enc({ t: 'pick', w: 'sr_bolt' })).msg, { t: 'pick', w: 'sr_bolt' });
    assert.equal(decodeClient(enc({ t: 'pick', w: 'x'.repeat(25) })).ok, false);
    assert.deepEqual(decodeClient(enc({ t: 'team', team: 'charterer' })).msg, { t: 'team', team: 'charterer' });
    assert.equal(decodeClient(enc({ t: 'team', team: 'red' })).ok, false);
    assert.deepEqual(decodeClient(enc({ t: 'start', extra: 1 })).msg, { t: 'start' });
  });
});

describe('이름·스냅샷 줄', () => {
  test('cleanName은 코드 포인트 단위로 24자에서 자른다', () => {
    const name = '😀'.repeat(30);
    const out = cleanName(name);
    assert.equal(Array.from(out).length, 24);
    assert.ok(!/[\ud800-\udbff]$/.test(out), '서로게이트 반쪽이 남지 않는다');
    assert.equal(cleanName(12), '');
    assert.equal(cleanName('​﻿'), '');
  });

  test('encodeRow → decodeRow: cm·mrad로 줄였다가 되돌린다', () => {
    const row = encodeRow({ id: 'p1', pos: [1.234, 0.5, -7.891], yaw: 1.2345, pitch: -0.1, flags: 8 | 32, hp: 70, weapon: 'ar_std', ack: 41 });
    assert.equal(row.length, Object.keys(ROW).length);
    const r = decodeRow(row);
    assert.deepEqual(r.pos, [1.23, 0.5, -7.89]);
    assert.equal(r.yaw, 1.235);
    assert.equal(r.alive, true);
    assert.equal(r.crouch, true);
    assert.equal(r.ack, 41);
  });
});

describe('limits', () => {
  test('토큰 버킷: burst만큼 바로, 그 뒤는 초당 rate', () => {
    let now = 0;
    const b = new TokenBucket(10, 5, () => now);
    for (let i = 0; i < 5; i++) assert.equal(b.take(), true);
    assert.equal(b.take(), false);
    now += 100;   // 0.1초 = 토큰 1개
    assert.equal(b.take(), true);
    assert.equal(b.take(), false);
    now += 10000;
    for (let i = 0; i < 5; i++) assert.equal(b.take(), true, '오래 쉬어도 burst까지만 찬다');
    assert.equal(b.take(), false);
  });

  test('위반 점수는 시간에 따라 줄고 한도에서 true', () => {
    let now = 0;
    const s = createStrikes({ limit: 5, decayPerSec: 1, now: () => now });
    assert.equal(s.add(3, 'bad_json'), false);
    now += 2000;
    assert.equal(s.score(), 1);
    assert.equal(s.add(3, 'rate'), false);
    assert.equal(s.add(1, 'rate'), true);
    assert.deepEqual(s.reasons(), { bad_json: 1, rate: 2 });
  });
});

describe('loop', () => {
  /** 가짜 시계와 타이머로 루프를 돌린다 */
  function fakeClock() {
    let t = 0;
    let pending = null;
    return {
      now: () => t,
      setTimer: (fn, ms) => { pending = { fn, at: t + ms }; return pending; },
      clearTimer: () => { pending = null; },
      /** 다음 타이머까지(늦게 깨면 late ms 더) 시간을 보내고 부른다 */
      fire(late = 0) { const p = pending; pending = null; t = Math.max(t, p.at) + late; p.fn(); }
    };
  }

  test('늦게 깨면 밀린 틱을 따라잡아 평균 빈도를 지킨다', () => {
    const c = fakeClock();
    let steps = 0;
    const loop = createLoop({ hz: 30, step: () => steps++, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer });
    loop.start();               // 0 ms에 1틱
    for (let i = 0; i < 29; i++) c.fire(i % 3 === 0 ? 15 : 0);   // 세 번에 한 번 15 ms 늦게 깬다
    assert.ok(Math.abs(c.now() / (1000 / 30) - steps) <= 1.01, `시간 ${c.now()} ms에 ${steps}틱`);
    loop.stop();
  });

  test('따라잡지 못할 만큼 밀리면 건너뛰고 알린다', () => {
    const c = fakeClock();
    let steps = 0, lag = null;
    const loop = createLoop({ hz: 30, step: () => steps++, now: c.now, setTimer: c.setTimer, clearTimer: c.clearTimer, maxCatchUp: 5, onLag: (ms, skipped) => { lag = { ms, skipped }; } });
    loop.start();
    c.fire(1000);               // 1초 멈춤
    assert.equal(steps, 1 + 5, '최대 5틱만 몰아서 돈다');
    assert.ok(lag && lag.skipped >= 20, JSON.stringify(lag));
    loop.stop();
  });
});

describe('metrics·log·config', () => {
  test('Prometheus 텍스트: 라벨 이스케이프와 히스토그램', () => {
    const m = createMetrics();
    m.declare('skala_x_total', 'counter', '시험');
    m.inc('skala_x_total', { reason: 'a"b' });
    m.inc('skala_x_total', { reason: 'a"b' }, 2);
    m.histogram('skala_t_ms', '틱', [1, 5]);
    m.observe('skala_t_ms', 0.5);
    m.observe('skala_t_ms', 3);
    const text = m.render();
    assert.match(text, /skala_x_total\{reason="a\\"b"\} 3/);
    assert.match(text, /skala_t_ms_bucket\{le="1"\} 1/);
    assert.match(text, /skala_t_ms_bucket\{le="5"\} 2/);
    assert.match(text, /skala_t_ms_count 2/);
  });

  test('로그는 pino와 같은 필드의 JSON 한 줄', () => {
    const out = memoryStream();
    const log = createLogger({ level: 'info', stream: out, base: { service: 't' }, now: () => 1000 });
    log.debug('보이지 않는다');
    log.child({ room: 'r1' }).warn({ players: 2, err: new Error('boom') }, '느린 틱');
    const [line] = out.lines();
    assert.equal(out.lines().length, 1);
    assert.equal(line.level, 40);
    assert.equal(line.time, 1000);
    assert.equal(line.service, 't');
    assert.equal(line.room, 'r1');
    assert.equal(line.msg, '느린 틱');
    assert.equal(line.err.message, 'boom');
  });

  test('config: 인자와 환경 변수, 잘못된 값은 이유와 함께 거절', () => {
    const { config } = loadConfig(['--port', '9001', '--round-sec', '30', '--rounds-to-win', '2', '--max-rewind-ms', '0'], { LOG_LEVEL: 'warn', ALLOWED_ORIGINS: 'https://a.example, https://b.example' });
    assert.equal(config.port, 9001);
    assert.equal(config.logLevel, 'warn');
    assert.equal(config.maxRewindMs, 0);
    assert.deepEqual(config.allowedOrigins, ['https://a.example', 'https://b.example']);
    assert.deepEqual(config.matchRules, { roundTimeMs: 30000, roundsToWin: 2, maxRounds: 3 });
    assert.equal(loadConfig([], { PORT: '7000' }).config.port, 7000);
    assert.throws(() => loadConfig(['--port', '70000'], {}), /--port/);
    assert.throws(() => loadConfig(['--map', 'nowhere'], {}), /--map/);
    assert.throws(() => loadConfig(['--what'], {}));
  });
});
