/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 권위 서버의 지연 보정 시험. 위치 기록의 보간·순간이동·생존·링 버퍼, 되감기 상한 자르기, 그리고 방에서 움직이는 적을 지난 화면 기준으로 쐈을 때
 *          되감으면 맞고(되감기 양도 맞다), 되감지 않거나 상한 너머를 우기거나 되감기를 끄면 빗나가는 것을 본다.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createHistory, rewindTarget, TELEPORT_DIST } from '../server/core/lagcomp.js';
import { KEY, PRESS, aimFromTo, roomWith } from './server-room-kit.mjs';

const row = (id, x, extra = {}) => ({ id, team: 'owner', x, y: 0, z: 0, yaw: 0, crouch: 0, alive: true, ...extra });

describe('위치 기록', () => {
  test('소수 틱은 두 기록 사이를 섞는다(yaw는 짧은 쪽으로)', () => {
    const h = createHistory({ size: 8 });
    h.record(1, [row('a', 0, { yaw: 3.0, crouch: 0 })]);
    h.record(2, [row('a', 1, { yaw: -3.0, crouch: 1 })]);
    const [a] = h.sample(1.25);
    assert.ok(Math.abs(a.x - 0.25) < 1e-12);
    assert.ok(Math.abs(a.crouch - 0.25) < 1e-12);
    assert.ok(a.yaw > 3.0 || a.yaw < -3.0, `π 근처로 돈다: ${a.yaw}`);
    assert.deepEqual(h.sample(2), [row('a', 1, { yaw: -3.0, crouch: 1 })]);
    assert.deepEqual(h.range(), { oldest: 1, newest: 2 });
  });

  test('순간이동은 섞지 않고, 사이에 죽었으면 죽은 것으로, 한쪽에만 있으면 그 기록을 쓴다', () => {
    const h = createHistory({ size: 8 });
    h.record(1, [row('a', 0), row('b', 0), row('c', 0)]);
    h.record(2, [row('a', TELEPORT_DIST + 1), row('b', 0.1, { alive: false })]);
    const at = (t, id) => h.sample(t).find((r) => r.id === id);
    assert.equal(at(1.4, 'a').x, 0);
    assert.equal(at(1.6, 'a').x, TELEPORT_DIST + 1);
    assert.equal(at(1.1, 'b').alive, false);
    assert.equal(at(1.5, 'c').x, 0);
  });

  test('링 버퍼는 size만큼만 남긴다', () => {
    const h = createHistory({ size: 8 });
    for (let t = 1; t <= 20; t++) h.record(t, [row('a', t)]);
    assert.deepEqual(h.range(), { oldest: 13, newest: 20 });
    assert.equal(h.sample(5), null);
    assert.equal(h.sample(13)[0].x, 13);
  });
});

describe('rewindTarget', () => {
  const w = { now: 20, maxTicks: 9, oldest: 5, newest: 19 };
  test('상한 안은 그대로, 상한 너머는 상한으로, 없거나 미래면 가장 최근', () => {
    assert.deepEqual(rewindTarget(15.5, w), { tick: 15.5, clamped: false, rewind: 4.5 });
    assert.deepEqual(rewindTarget(10, w), { tick: 11, clamped: true, rewind: 9 });
    assert.deepEqual(rewindTarget(null, w), { tick: 19, clamped: false, rewind: 1 });
    assert.deepEqual(rewindTarget(25, w), { tick: 19, clamped: false, rewind: 1 });
  });
  test('상한 0이면 되감지 않고, 기록보다 오래된 틱은 가장 오래된 기록으로', () => {
    assert.equal(rewindTarget(12, { ...w, maxTicks: 0 }).tick, 19);
    assert.deepEqual(rewindTarget(1, { ...w, maxTicks: 100 }), { tick: 5, clamped: true, rewind: 15 });
  });
});

describe('방에서 되감아 맞히기', () => {
  /**
   * B가 옆으로 걷는 동안 A가 back틱 전 화면의 B 가슴을 겨눠 한 발 쏜다.
   * @returns {{hit:boolean, rewind:number|null, moved:number}} moved = 그 사이 B가 옮긴 거리(m)
   */
  function shootPast({ maxRewindMs = 300, back = 6, viewTick = 'past' } = {}) {
    const t = roomWith({ maxRewindMs, rules: { loadoutMs: 0, roundTimeMs: 60000, hp: 10000 } }, [{ team: 'owner' }, { team: 'charterer' }]);
    t.room.input(t.ids[0], { t: 'start' });
    t.steps(2);
    const A = t.actor(0), B = t.actor(1);
    A.spawn({ x: -6, z: 0, rotY: -Math.PI / 2 });
    B.spawn({ x: 6, z: -8, rotY: Math.PI / 2 });
    for (let i = 0; i < 45; i++) {   // 꺼내기·조준을 마치는 동안 B는 +z로 걷는다(약 5 m/s)
      t.input(0, { keys: KEY.AIM });
      t.input(1, { keys: KEY.LEFT });
      t.room.tick();
    }
    const now = t.room.currentTick;
    const past = now - back;
    const pastB = t.room.history.sample(past).find((r) => r.id === B.id);
    const { yaw, pitch } = aimFromTo(A, [pastB.x, pastB.y, pastB.z]);
    t.peers[0].clear();
    t.input(0, { keys: KEY.AIM | KEY.FIRE, press: PRESS.FIRE, yaw, pitch, viewTick: viewTick === 'past' ? past : viewTick });
    t.input(1, { keys: KEY.LEFT });
    t.room.tick();
    const evs = t.peers[0].events();
    const fire = evs.find((e) => e.type === 'fire' && e.id === A.id);
    assert.ok(fire, '쐈다');
    return {
      hit: evs.some((e) => e.type === 'damage' && e.victim === B.id),
      rewind: fire.rw,
      moved: Math.abs(B.state.pos[2] - pastB.z)
    };
  }

  test('쏜 사람이 본 틱으로 되감으면 움직이는 적을 맞힌다', () => {
    const r = shootPast({ back: 6 });
    assert.ok(r.moved > 0.9, `그 사이 B가 1 m 가까이 움직였다: ${r.moved}`);
    assert.equal(r.hit, true);
    assert.equal(r.rewind, 7, '되감기 = 지금 틱 − viewTick(이 입력은 다음 틱에 처리된다)');
  });

  test('되감지 않으면(viewTick 없음) 같은 조준이 빗나간다', () => {
    assert.equal(shootPast({ back: 6, viewTick: null }).hit, false);
  });

  test('상한(300 ms = 9틱)보다 오래된 화면을 우기면 상한까지만 되감아 빗나간다', () => {
    const r = shootPast({ back: 15 });
    assert.equal(r.rewind, 9);
    assert.equal(r.hit, false);
  });

  test('되감기를 끈 방(maxRewindMs 0)에서는 지난 화면 조준이 빗나간다', () => {
    const r = shootPast({ maxRewindMs: 0, back: 6 });
    assert.equal(r.hit, false);
    assert.equal(r.rewind, 1, '가장 최근 기록(지난 틱)만 쓴다');
  });
});
