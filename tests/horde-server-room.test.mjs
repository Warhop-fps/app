/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 게임 서버 좀비 방(server/core/horde-room.js)과 그 메시지(horde-protocol.js·js/net/hordeproto.js)를 소켓 없이 보는 시험.
 *          손님 형식 검사, 이벤트 번호 거름망, 대기실 → start → 10 Hz 스냅샷, 꼭 닿아야 하는 이벤트를 3초 동안만 다시 싣기, 거절은 보낸 사람에게만,
 *          위치 속도 검사, 정원 4명, 판 끝 요약(onMatchEnd)을 본다.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeClient } from '../server/core/protocol.js';
import { createHordeServerRoom, zombieMapId, ZOMBIE_MAP_IDS } from '../server/core/horde-room.js';
import { createEventFilter, encodeHordeAction, encodeHordeState, isReliableEvent } from '../js/net/hordeproto.js';
import { applyHordeSnapshot } from '../js/game/horde/wire.js';

const dec = (obj) => decodeClient(JSON.stringify(obj));

/** 보낸 글자를 사람마다 모으는 좀비 방 */
function makeRoom(extra = {}) {
  const got = new Map();
  const room = createHordeServerRoom({ send: (pid, text) => { const l = got.get(pid) || []; l.push(JSON.parse(text)); got.set(pid, l); }, id: 'zt', map: 'restarea', seed: 777, rules: { prepMs: 1000 }, ...extra });
  const msgs = (pid, t) => (got.get(pid) || []).filter((m) => !t || m.t === t);
  const input = (pid, obj) => { const r = dec(obj); assert.ok(r.ok, JSON.stringify(obj)); room.input(pid, r.msg); };
  return { room, got, msgs, input };
}

describe('좀비 방 메시지 검사', () => {
  test('맞는 형식은 정리해서 받고, 틀린 값은 버린다', () => {
    assert.deepEqual(dec({ t: 'zs', x: 1, y: 0.5, z: -2, yaw: 0.3, slot: 1, air: true }).msg, { t: 'zs', x: 1, y: 0.5, z: -2, yaw: 0.3, slot: 1, air: true, alive: true });
    assert.deepEqual(dec({ t: 'zs', alive: false }).msg, { t: 'zs', alive: false });
    assert.equal(dec({ t: 'zs', x: 'a', z: 1 }).ok, false);
    assert.equal(dec({ t: 'zs', x: 1e9, z: 1 }).ok, false);
    assert.equal(dec({ t: 'zhit', victimId: 'z3', weaponId: 'ar_std', part: 'head', dist: 9, kind: 'shot', count: 1, shotId: 4 }).ok, true);
    assert.equal(dec({ t: 'zhit', victimId: 'z3', weaponId: 'ar_std', dist: -1 }).ok, false);
    assert.equal(dec({ t: 'zhit', victimId: '<b>', weaponId: 'ar_std' }).ok, false);
    assert.equal(dec({ t: 'zswing', weaponId: 'ml_yasuo', kind: 'yasuoSwing', shotId: 2 }).ok, true);
    const boom = dec({ t: 'zboom', c: [1, 2, 3], v: [[5, 80], [6, 12.5]], k: 'gl' });
    assert.deepEqual(boom.msg, { t: 'zboom', center: { x: 1, y: 2, z: 3 }, victims: [{ id: 'z5', dmg: 80 }, { id: 'z6', dmg: 12.5 }], kind: 'gl' });
    assert.equal(dec({ t: 'zboom', c: [1, 2], v: [] }).ok, false);
    assert.equal(dec({ t: 'zboom', c: [1, 2, 3], v: new Array(41).fill([1, 1]) }).ok, false);
    assert.deepEqual(dec({ t: 'zcard', act: 'pick', card: 'hp' }).msg, { t: 'zcard', act: 'pick', card: 'hp' });
    assert.deepEqual(dec({ t: 'zcard', act: 'reroll', card: 'x' }).msg, { t: 'zcard', act: 'reroll' });
    assert.equal(dec({ t: 'zcard', act: 'steal' }).ok, false);
    assert.equal(dec({ t: 'zloot', id: 0 }).ok, false);
    assert.deepEqual(dec({ t: 'zrev', id: 'p2', on: 1 }).msg, { t: 'zrev', id: 'p2', on: true });
  });

  test('봇 행동 → 손님 형식 → 서버 검사가 왕복한다(폭발은 512바이트 안)', () => {
    const victims = Array.from({ length: 40 }, (_, i) => ({ id: 'z' + (1000 + i), dmg: 99.5 }));
    const enc = encodeHordeAction({ t: 'explode', center: { x: 10.123, y: 1, z: -3 }, victims, kind: 'gl' });
    assert.ok(JSON.stringify(enc).length < 512, `폭발 ${JSON.stringify(enc).length} B`);
    assert.equal(dec(enc).msg.victims.length, 40);
    for (const a of [{ t: 'hit', victimId: 'z1', weaponId: 'ar_std', part: 'body', dist: 3, kind: 'shot', count: 1, shotId: 1 }, { t: 'pick', cardId: 'hp' }, { t: 'reroll' }, { t: 'loot', lootId: 3 }, { t: 'revive', targetId: 'p2', on: true }]) {
      assert.equal(dec(encodeHordeAction(a)).ok, true, a.t);
    }
    assert.equal(dec(encodeHordeState({ x: 1, y: 0, z: 2, yaw: 0.1, slot: 1, air: false, alive: true })).ok, true);
    assert.deepEqual(encodeHordeState({ alive: false }), { t: 'zs', alive: false });
  });

  test('이벤트 거름망: 번호가 같으면 한 번만, 번호 없는 거절은 늘 받는다', () => {
    const accept = createEventFilter(4);
    assert.equal(accept({ type: 'phase', eid: 1 }), true);
    assert.equal(accept({ type: 'phase', eid: 1 }), false);
    assert.equal(accept({ type: 'reject' }), true);
    assert.equal(accept({ type: 'reject' }), true);
    for (let i = 2; i <= 6; i++) accept({ type: 'x', eid: i });
    assert.equal(accept({ type: 'phase', eid: 1 }), true, '오래된 번호는 잊는다(keep개)');
    assert.ok(isReliableEvent({ type: 'offer' }) && isReliableEvent({ type: 'over' }) && !isReliableEvent({ type: 'crit' }));
  });

  test('좀비 맵만 고른다', () => {
    assert.deepEqual([...ZOMBIE_MAP_IDS].sort(), ['restarea', 'subway']);
    assert.equal(zombieMapId('subway'), 'subway');
    assert.equal(zombieMapId('arena'), 'restarea');
    assert.equal(zombieMapId(undefined), 'restarea');
  });
});

describe('좀비 방(소켓 없이)', () => {
  test('대기실 → 방장 start → 10 Hz 스냅샷, 다시 실은 이벤트는 3초 뒤 빠진다', () => {
    const { room, msgs, input } = makeRoom();
    assert.equal(room.join('p1', { name: 'A' }).ok, true);
    assert.equal(room.join('p2', { name: 'B' }).ok, true);
    assert.equal(msgs('p1', 'welcome')[0].mode, 'zombie');
    room.tick();
    assert.equal(msgs('p2', 'zlobby').at(-1).players.length, 2);
    assert.equal(msgs('p2', 'zsnap').length, 0, '시작 전에는 스냅샷이 없다');
    input('p2', { t: 'start' });
    room.tick();
    assert.ok(msgs('p2', 'zev').some((m) => m.events.some((e) => e.type === 'reject' && e.reason === 'not_leader')), '방장이 아니면 거절');
    assert.ok(!msgs('p1', 'zev').some((m) => m.events.some((e) => e.type === 'reject')), '거절은 보낸 사람에게만');
    input('p1', { t: 'start' });
    for (let i = 0; i < 30; i++) room.tick();
    assert.equal(room.phase, 'playing');
    const snaps = msgs('p1', 'zsnap');
    assert.ok(snaps.length >= 9 && snaps.length <= 11, `1초에 스냅샷 ${snaps.length}개`);
    const view = applyHordeSnapshot(snaps.at(-1).s);
    assert.ok(view && view.players.length === 2, '스냅샷을 화면 쪽 함수로 푼다');
    const ev = msgs('p1', 'zev').flatMap((m) => m.events).filter((e) => Number.isInteger(e.eid));
    assert.ok(ev.some((e) => e.type === 'phase'), '단계 이벤트');
    assert.ok(snaps.at(-1).ev.some((e) => e.type === 'phase' || e.type === 'spawn'), '꼭 닿아야 하는 이벤트를 스냅샷에 다시 싣는다');
    const eids = ev.map((e) => e.eid);
    assert.deepEqual(eids, [...eids].sort((a, b) => a - b), '번호는 늘어나기만 한다');
    const first = ev.find((e) => e.type === 'phase');
    for (let i = 0; i < 100; i++) room.tick();
    assert.ok(!msgs('p1', 'zsnap').at(-1).ev.some((e) => e.eid === first.eid), '3초가 지나면 다시 싣지 않는다');
    room.dispose();
  });

  test('정원은 4명, 판 중에 들어오면 다음 스테이지에 나온다', () => {
    const { room, msgs, input } = makeRoom();
    for (const id of ['p1', 'p2', 'p3']) room.join(id, { name: id });
    input('p1', { t: 'start' });
    room.tick();
    assert.equal(room.join('p4', { name: 'p4' }).ok, true);
    assert.deepEqual(room.join('p5', { name: 'p5' }), { ok: false, code: 'room_full' });
    for (let i = 0; i < 6; i++) room.tick();
    assert.ok(msgs('p1', 'zev').some((m) => m.events.some((e) => e.type === 'join' && e.id === 'p4')));
    room.dispose();
  });

  test('위치가 초당 12 m보다 빨리 움직이면 거기까지만 받는다(부활 자리로 옮겨지는 것은 정상)', () => {
    const { room, input } = makeRoom();
    room.join('p1', { name: 'A' });
    input('p1', { t: 'start' });
    room.tick();
    input('p1', { t: 'zs', x: 0, y: 0, z: 0, yaw: 0, slot: 1, air: false });
    room.tick();
    input('p1', { t: 'zs', x: 100, y: 0, z: 0, yaw: 0, slot: 1, air: false });
    room.tick();
    assert.equal(room.stats().clamped, 1);
    input('p1', { t: 'zs', x: 1.6, y: 0, z: 0, yaw: 0, slot: 1, air: false });
    room.tick();
    assert.equal(room.stats().clamped, 1, '한 틱에 1.6 m(여유 안)는 받는다');
    room.dispose();
  });

  test('가만히 선 한 명이 쓰러지면 판이 끝나 onMatchEnd를 한 번, 방장의 start로 새 씨앗의 새 판', () => {
    const ends = [];
    let n = 0;
    const { room, msgs, input } = makeRoom({ seed: () => 1000 + (++n), onMatchEnd: (s) => ends.push(s) });
    room.join('p1', { name: 'A' });
    input('p1', { t: 'start' });
    room.tick();
    const seed1 = room.seed;
    const sp = msgs('p1', 'zev').flatMap((m) => m.events).find((e) => e.type === 'spawn' && e.spawn).spawn;
    for (let i = 0; i < 30 * 300 && room.phase === 'playing'; i++) {
      if (i % 3 === 0) input('p1', { t: 'zs', x: sp.x, y: sp.y || 0, z: sp.z, yaw: 0, slot: 1, air: false });
      room.tick();
    }
    assert.equal(room.phase, 'over', '쏘지 않으면 쓰러져 끝난다');
    assert.equal(ends.length, 1);
    assert.equal(ends[0].reason, 'wiped');
    assert.equal(ends[0].seed, seed1);
    assert.equal(ends[0].players[0].id, 'p1');
    for (let i = 0; i < 40; i++) room.tick();
    assert.ok(msgs('p1', 'zsnap').at(-1).s.over, '끝난 뒤에도 1초마다 결과가 담긴 스냅샷');
    assert.equal(ends.length, 1, '한 번만');
    input('p1', { t: 'start' });
    room.tick();
    assert.equal(room.phase, 'playing');
    assert.notEqual(room.seed, seed1, '판마다 새 씨앗');
    room.leave('p1');
    assert.equal(ends.length, 2, '모두 나가도 판 끝');
    assert.equal(ends[1].reason, 'left');
    room.dispose();
  });

  test('방장이 나가면 다음 사람이 방장', () => {
    const { room, msgs } = makeRoom();
    room.join('p1', { name: 'A' });
    room.join('p2', { name: 'B' });
    room.leave('p1');
    room.tick();
    assert.equal(room.leader, 'p2');
    assert.ok(msgs('p2', 'zev').some((m) => m.events.some((e) => e.type === 'leader' && e.id === 'p2')));
    assert.equal(msgs('p2', 'zlobby').at(-1).leader, 'p2');
    room.dispose();
  });
});
