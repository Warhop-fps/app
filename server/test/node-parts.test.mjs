/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: VM용 Node 어댑터 부품 시험(server/node). 고정 간격 루프, Prometheus 지표 출력, pino 형식 로그, 명령줄·환경 변수 설정을 본다.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createLoop } from '../node/loop.js';
import { createMetrics } from '../node/metrics.js';
import { createLogger, memoryStream } from '../node/log.js';
import { loadConfig } from '../node/config.js';

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
    assert.equal(loadConfig(['--stats-sec', '5'], {}).config.statsIntervalMs, 5000);
    assert.throws(() => loadConfig(['--port', '70000'], {}), /--port/);
    assert.throws(() => loadConfig(['--map', 'nowhere'], {}), /--map/);
    assert.throws(() => loadConfig(['--what'], {}));
  });
});
