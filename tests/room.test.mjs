/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 권위 서버의 방 로직(server/core/room.js)을 소켓 없이 직접 돌리는 시험. 입장·정원·방장, 틱마다 입력 하나와 ack, 밀린 입력 합치기,
 *          브라우저와 같은 이동 결과, 로드아웃 얼림, 팀전 한 판(사격 → 킬 → 라운드 → 경기 끝), 죽은 몸, 아군 통과, 개인전 부활, 칼, 수류탄, 보내는 메시지를 본다.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createBus } from '../js/core/bus.js';
import { createLocalPlayer } from '../js/engine/player.js';
import { INPUT_QUEUE_MAX } from '../server/core/actor.js';
import { createRoom } from '../server/core/room.js';
import { ROW } from '../server/core/protocol.js';
import { KEY, PRESS, FAST_RULES, aimFromTo, roomWith } from './server-room-kit.mjs';

const TWO = [{ name: '블루', team: 'owner' }, { name: '오렌지', team: 'charterer' }];

/** 사람 i가 j의 가슴을 겨눈 입력 */
function aimInput(t, i, j, extra = {}) {
  const a = t.actor(i), b = t.actor(j);
  const { yaw, pitch } = aimFromTo(a, b.state.pos);
  return { yaw, pitch, ...extra };
}

/** 경기 시작 → live까지 */
function goLive(t, ticks = 40) {
  t.room.input(t.ids[0], { t: 'start' });
  for (let i = 0; i < ticks && t.room.phase !== 'live'; i++) t.room.tick();
  assert.equal(t.room.phase, 'live');
}

describe('방 만들기·입장·정원·방장', () => {
  test('send 없이는 만들 수 없다(방은 보낼 곳만 받는다)', () => {
    assert.throws(() => createRoom({ map: 'arena' }), /send/);
  });

  test('6명까지 받고 7번째는 room_full, 같은 신원은 두 번 못 들어오고, 먼저 온 사람이 방장', () => {
    const people = Array.from({ length: 6 }, (_, i) => ({ name: `n${i}`, team: i % 2 ? 'charterer' : 'owner' }));
    const t = roomWith({ roomSize: 6 }, people);
    assert.equal(t.room.size, 6);
    assert.equal(t.room.leader, t.ids[0]);
    assert.deepEqual(t.room.join('p7', { name: 'late' }), { ok: false, code: 'room_full' });
    assert.deepEqual(t.room.join('p1', { name: 'again' }), { ok: false, code: 'duplicate_id' });
    const welcome = JSON.parse(t.peers[2].texts[0]);
    assert.equal(welcome.t, 'welcome');
    assert.equal(welcome.playerId, t.ids[2]);
    assert.equal(welcome.leader, t.ids[0]);
    assert.equal(welcome.hz, 30);
    assert.deepEqual(welcome.row, ROW);
    // 팀은 3:3으로 고르게
    const teams = t.ids.map((id) => t.room.actor(id).team);
    assert.equal(teams.filter((x) => x === 'owner').length, 3);
  });

  test('방장이 나가면 다음 사람이 방장이 되고 모두에게 알린다', () => {
    let emptied = 0;
    const t = roomWith({ onEmpty: () => emptied++ }, TWO);
    t.room.leave(t.ids[0]);
    t.room.tick();
    assert.equal(t.room.leader, t.ids[1]);
    const evs = t.peers[1].events();
    assert.ok(evs.some((e) => e.type === 'leave' && e.id === t.ids[0]));
    assert.ok(evs.some((e) => e.type === 'leader' && e.id === t.ids[1]));
    t.room.leave(t.ids[1]);
    assert.equal(emptied, 1);
  });

  test('방장이 아닌 사람의 start는 그 사람에게만 거절이 간다', () => {
    const t = roomWith({}, TWO);
    t.room.input(t.ids[1], { t: 'start' });
    t.room.tick();
    assert.equal(t.room.phase, 'warmup');
    assert.ok(t.peers[1].events().some((e) => e.type === 'reject' && e.reason === 'not_leader'));
    assert.ok(!t.peers[0].events().some((e) => e.type === 'reject'));
  });
});

describe('입력 줄', () => {
  test('틱마다 입력 하나만 처리하고 ack는 그 번호다', () => {
    const t = roomWith({}, TWO);
    for (let i = 0; i < 3; i++) t.input(0, { keys: KEY.FORWARD });
    const a = t.actor(0);
    t.room.tick();
    assert.equal(a.ack, 0);
    assert.equal(a.queued, 2);
    t.room.tick();
    t.room.tick();
    assert.equal(a.ack, 2);
    const snap = t.peers[0].snapshots().pop();
    const mine = snap.players.find((r) => r[ROW.ID] === t.ids[0]);
    assert.equal(mine[ROW.ACK], 2, '스냅샷 줄에 그 사람의 ack');
    assert.equal(snap.me.ack, 2);
    assert.equal(snap.tick, t.room.currentTick);
  });

  test('번호가 늘지 않은 입력은 버린다', () => {
    const t = roomWith({}, TWO);
    const msg = (seq) => ({ t: 'input', seq, keys: 0, press: 0, slot: 0, yaw: 0, pitch: 0, viewTick: null });
    t.room.input(t.ids[0], msg(5));
    t.room.input(t.ids[0], msg(5));
    t.room.input(t.ids[0], msg(3));
    const a = t.actor(0);
    assert.equal(a.queued, 1);
    assert.equal(a.stats.stale, 2);
  });

  test('밀린 입력은 상한까지만 두고, 버린 입력의 새로 누름(점프)은 다음 입력에 합친다', () => {
    const t = roomWith({}, TWO);
    const a = t.actor(0);
    t.input(0, { press: PRESS.JUMP });
    for (let i = 0; i < 6; i++) t.input(0, {});
    assert.equal(a.queued, INPUT_QUEUE_MAX);
    assert.equal(a.stats.folded, 7 - INPUT_QUEUE_MAX);
    assert.equal(a.state.onGround, true);
    t.room.tick();
    assert.equal(a.ack, 7 - INPUT_QUEUE_MAX, '가장 오래 남은 입력부터 처리');
    assert.equal(a.state.onGround, false, '합쳐진 점프가 살아 있다');
  });

  test('입력이 끊기면 누르던 키를 되풀이하고 ack는 그대로', () => {
    const t = roomWith({}, TWO);
    const a = t.actor(0);
    t.input(0, { keys: KEY.FORWARD });
    t.room.tick();
    const p1 = a.state.pos.slice();
    for (let i = 0; i < 9; i++) t.room.tick();
    assert.equal(a.ack, 0);
    assert.equal(a.stats.repeated, 9);
    assert.ok(Math.hypot(a.state.pos[0] - p1[0], a.state.pos[2] - p1[2]) > 1, '계속 걷는다');
  });
});

describe('이동은 브라우저 코드와 같다', () => {
  test('같은 키를 1/60초 두 번씩 돌린 createLocalPlayer와 위치·속도가 같다(걷기·점프·버니합·앉기)', () => {
    const t = roomWith({}, TWO);
    const a = t.actor(0);
    const bus = createBus();
    const keys = {};
    const ref = createLocalPlayer({ bus, input: { state: keys, enabled: true, consumeLook: () => ({ dx: 0, dy: 0 }) }, camera: null, getWorld: () => t.room.world });
    ref.spawn({ x: a.state.pos[0], y: a.state.pos[1], z: a.state.pos[2], rotY: a.state.yaw });
    ref.setSpeedScale(a.state.speedScale);
    const plan = (i) => {
      if (i < 20) return { keys: KEY.FORWARD };
      if (i < 50) return { keys: KEY.FORWARD | KEY.RIGHT | KEY.JUMP, press: i === 20 ? PRESS.JUMP : 0, yaw: -1.2 + i * 0.03 };
      if (i < 70) return { keys: KEY.BACK | KEY.CROUCH, yaw: 0.4 };
      return { keys: KEY.LEFT | KEY.WALK, yaw: 0.4 };
    };
    for (let i = 0; i < 90; i++) {
      const inp = { yaw: a.state.yaw, pitch: 0, press: 0, ...plan(i) };
      t.input(0, inp);
      t.room.tick();
      Object.assign(keys, {
        forward: !!(inp.keys & KEY.FORWARD), back: !!(inp.keys & KEY.BACK), left: !!(inp.keys & KEY.LEFT), right: !!(inp.keys & KEY.RIGHT),
        jump: !!(inp.keys & KEY.JUMP), crouch: !!(inp.keys & KEY.CROUCH), walk: !!(inp.keys & KEY.WALK), aim: false
      });
      if (inp.press & PRESS.JUMP) bus.emit('input:jump');
      ref.state.yaw = inp.yaw;
      ref.tick(1 / 60);
      ref.tick(1 / 60);
      for (let k = 0; k < 3; k++) {
        assert.ok(Math.abs(ref.state.pos[k] - a.state.pos[k]) < 1e-9, `틱 ${i} pos[${k}] ${ref.state.pos[k]} vs ${a.state.pos[k]}`);
        assert.ok(Math.abs(ref.state.vel[k] - a.state.vel[k]) < 1e-9, `틱 ${i} vel[${k}]`);
      }
      assert.equal(ref.state.crouch, a.state.crouch, `틱 ${i} crouch`);
    }
  });

  test('로드아웃 단계에는 움직이지 못한다', () => {
    const t = roomWith({ rules: { loadoutMs: 1000 } }, TWO);
    t.room.input(t.ids[0], { t: 'start' });
    t.room.tick();
    assert.equal(t.room.phase, 'loadout');
    const a = t.actor(0);
    const p0 = a.state.pos.slice();
    for (let i = 0; i < 10; i++) { t.input(0, { keys: KEY.FORWARD | KEY.FIRE, press: PRESS.FIRE }); t.room.tick(); }
    assert.deepEqual(a.state.pos, p0);
    assert.ok(!t.peers[0].events().some((e) => e.type === 'fire'), '쏘지도 못한다');
  });
});

describe('경기', () => {
  test('팀전 한 판: 쏴서 죽이고 라운드가 넘어가 2선승으로 끝난다', () => {
    const t = roomWith({ rules: { ...FAST_RULES, loadoutMs: 0, roundEndMs: 200 } }, TWO);
    goLive(t);
    let ended = null;
    for (let i = 0; i < 600 && !ended; i++) {
      if (t.actor(1).alive && t.actor(0).alive) t.input(0, aimInput(t, 0, 1, { keys: KEY.FIRE | KEY.AIM }));
      else t.input(0, { keys: 0 });
      t.room.tick();
      ended = t.peers[1].events().find((e) => e.type === 'matchEnd');
    }
    assert.ok(ended, '경기가 끝난다');
    assert.equal(ended.winner, 'owner');
    assert.equal(ended.reason, 'wins');
    const evs = t.peers[1].events();
    assert.equal(evs.filter((e) => e.type === 'roundStart').length, 2);
    assert.equal(evs.filter((e) => e.type === 'kill' && e.victim === t.ids[1]).length, 2);
    assert.ok(evs.filter((e) => e.type === 'roundEnd').every((e) => e.reason === 'elimination'));
    assert.equal(t.room.phase, 'matchEnd');
    // 경기가 끝나면 다시 start로 새 판
    t.room.input(t.ids[0], { t: 'start' });
    t.room.tick();
    assert.notEqual(t.room.phase, 'matchEnd');
    assert.equal(t.room.match.state.round, 1);
  });

  test('죽은 몸이 맵 밖으로 떨어져도(player.js의 낙하 복귀) 다시 살아나지 않는다', () => {
    const t = roomWith({ rules: { loadoutMs: 0, roundTimeMs: 60000 } }, [{ team: 'owner' }, { team: 'charterer' }, { team: 'charterer' }]);
    goLive(t);
    const B = t.actor(1);
    B.kill();
    B.state.pos[1] = -50;    // 바다로 떨어진 시체
    t.steps(2);
    assert.equal(B.state.alive, false);
    assert.equal(B.alive, false);
    const row = t.peers[0].snapshots().pop().players.find((r) => r[ROW.ID] === B.id);
    assert.equal(row[ROW.FLAGS] & 8, 0, '스냅샷에도 죽은 채');
  });

  test('팀전 총알은 아군 몸을 지나 뒤의 적에게 맞는다', () => {
    const t = roomWith({ rules: { loadoutMs: 0, roundTimeMs: 60000 } }, [{ team: 'owner' }, { team: 'charterer' }, { team: 'owner' }]);
    goLive(t);
    t.actor(0).spawn({ x: -6, z: 0, rotY: -Math.PI / 2 });
    t.actor(2).spawn({ x: 0, z: 0, rotY: -Math.PI / 2 });   // 사이에 선 아군
    t.actor(1).spawn({ x: 6, z: 0, rotY: Math.PI / 2 });
    t.steps(30);   // 꺼내기 끝
    t.peers[0].clear();
    t.input(0, aimInput(t, 0, 1, { keys: KEY.FIRE | KEY.AIM, press: PRESS.FIRE }));
    t.room.tick();
    const dmg = t.peers[0].events().filter((e) => e.type === 'damage');
    assert.equal(dmg.length, 1);
    assert.equal(dmg[0].victim, t.ids[1]);
  });

  test('개인전: 죽으면 부활하고 목표 킬에서 끝난다', () => {
    const t = roomWith({ mode: 'ffa', rules: { killTarget: 5, respawnMs: 200, spawnProtectMs: 0, loadoutMs: 0, timeLimitMs: 60000 } }, [{}, {}]);
    goLive(t);
    let end = null;
    for (let i = 0; i < 1200 && !end; i++) {
      t.input(0, t.actor(1).alive ? aimInput(t, 0, 1, { keys: KEY.FIRE | KEY.AIM }) : { keys: 0 });
      t.room.tick();
      end = t.peers[0].events().find((e) => e.type === 'matchEnd');
    }
    assert.ok(end, '경기가 끝난다');
    assert.equal(end.mode, 'ffa');
    assert.equal(end.winner, t.ids[0]);
    assert.ok(t.peers[0].events().filter((e) => e.type === 'spawn' && e.id === t.ids[1]).length >= 5);
  });

  test('칼전: 가까이서 찌르면(우클릭) 칼 피해가 들어간다', () => {
    const t = roomWith({ ruleset: 'knife', rules: { loadoutMs: 0, roundTimeMs: 60000 } }, TWO);
    goLive(t);
    t.actor(0).spawn({ x: 0, z: 0, rotY: -Math.PI / 2 });
    t.actor(1).spawn({ x: 1.2, z: 0, rotY: Math.PI / 2 });
    t.steps(20);
    t.input(0, aimInput(t, 0, 1, { keys: KEY.AIM, press: PRESS.AIM }));
    t.steps(12);   // 찌르기 선딜 0.22초
    const dmg = t.peers[0].events().filter((e) => e.type === 'damage');
    assert.equal(dmg.length, 1);
    assert.equal(dmg[0].weaponId, 'ml_knife');
    assert.equal(dmg[0].kind, 'stab');
    assert.ok(t.peers[0].events().some((e) => e.type === 'kill' && e.victim === t.ids[1]), '찌르기 100 = 한 번에');
  });

  test('수류탄: 서버가 굴려 신관 뒤에 터지고 반경 안의 적이 다친다', () => {
    const t = roomWith({ rules: { loadoutMs: 0, roundTimeMs: 60000 } }, TWO);
    goLive(t);
    t.actor(0).spawn({ x: 0, z: 0, rotY: -Math.PI / 2 });
    t.actor(1).spawn({ x: 2.5, z: 0, rotY: Math.PI / 2 });
    t.steps(25);
    t.input(0, { slot: 4 });      // 수류탄 칸
    t.steps(20);
    t.input(0, { yaw: -Math.PI / 2, pitch: -1.2, press: PRESS.FIRE });   // 눌렀다 떼기 = 발밑으로 던지기
    t.steps(110);              // 신관 2.5초 = 75틱
    const evs = t.peers[0].events();
    assert.ok(evs.some((e) => e.type === 'nade' && e.id === t.ids[0]), '던진 수류탄을 알린다');
    assert.ok(evs.some((e) => e.type === 'boom'), '터진다');
    const hit = evs.find((e) => e.type === 'damage' && e.victim === t.ids[1]);
    assert.ok(hit, '적이 다친다');
    assert.equal(hit.weaponId, 'gr_frag');
  });
});

describe('보내는 메시지', () => {
  test('스냅샷은 모두의 줄 + 받는 사람만의 me, 이벤트는 틱 끝에, 점수판은 이벤트가 있을 때와 0.5초마다', () => {
    const t = roomWith({}, TWO);
    t.peers[0].clear();
    t.room.tick();
    const kinds = t.peers[0].texts.map((x) => JSON.parse(x).t);
    assert.deepEqual(kinds, ['snap', 'events', 'match'], '입장 이벤트가 첫 틱 끝에 나간다');
    const snap = t.peers[0].snapshots()[0];
    assert.equal(snap.players.length, 2);
    assert.equal(snap.me.ack, -1);
    assert.ok(Array.isArray(snap.me.v) && Array.isArray(snap.me.mm) && Array.isArray(snap.me.rk));
    t.peers[0].clear();
    t.steps(13);   // 틱 2~14
    assert.ok(t.peers[0].texts.every((x) => JSON.parse(x).t === 'snap'), '조용하면 스냅샷만');
    t.room.tick();   // 틱 15
    const m = JSON.parse(t.peers[0].texts.at(-1));
    assert.equal(m.t, 'match', '15틱마다 점수판');
    assert.equal(m.leader, t.ids[0]);
    assert.equal(m.ping[t.ids[0]], 12);
  });
});
