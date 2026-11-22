/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기를 화면 없이 돌리는 시험. 좀비 전용 맵(restarea)에 대본 봇 4명을 넣어 30 Hz로 여러 스테이지(보스 스테이지·증강 고르기 포함)를 돌리고,
 *          죽지 않고 끝까지 가는지, 같은 씨앗이면 이벤트 지문이 같고 다른 씨앗이면 다른지, 지문이 고정 값과 같은지(규칙이 몰래 바뀌지 않았는지) 본다.
 *          방(sim/room.js)·봇(sim/bots.js)·지문(sim/digest.js)과 이 시험이 쓰는 모듈은 three.js·DOM 없이 node에서 돈다.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHordeRoom, zombieGates } from '../js/game/horde/sim/room.js';
import { createHordeBot } from '../js/game/horde/sim/bots.js';
import { createDigest, digestOf, stableJson } from '../js/game/horde/sim/digest.js';
import { createHorde } from '../js/game/horde/director.js';
import { isZombieMap } from '../js/maps/collision.js';

const { default: RESTAREA } = await import('../js/maps/restarea.js');

/**
 * 규칙·좀비·보스·카드·봇을 일부러 바꿨다면 이 값이 바뀐다. 바뀐 이유가 맞으면 시험이 알려 주는 새 값으로 고친다
 * (HORDE_DIGEST_PRINT=1 npm test 로 지금 값을 볼 수 있다)
 */
const GOLDEN = Object.freeze({ seed: 20261123, digest: 'f89f5d3d5afc8012' });
const PLAYERS = Object.freeze([
  { id: 'p1', name: 'Alpha' }, { id: 'p2', name: 'Bravo' }, { id: 'p3', name: 'Charlie' }, { id: 'p4', name: 'Delta' }
]);

/**
 * 봇 4명으로 한 판. maxStage 스테이지가 시작되거나 끝나거나 maxMs가 지나면 멈춘다.
 * churn이면 4스테이지에 p4가 나갔다가 5스테이지에 다시 들어온다(서버 방에서 사람이 끊겼다 붙는 경우)
 */
function runMatch(seed, { maxStage = 7, maxMs = 240000, snapEvery = 30, churn = false } = {}) {
  const room = createHordeRoom({ map: RESTAREA, players: PLAYERS, seed });
  const bots = PLAYERS.map((p, i) => createHordeBot({ id: p.id, seed, world: room.world, reroll: i === 0, fireMs: i === 2 ? 440 : 110, weaponId: i === 3 ? 'sg_pump' : 'ar_std' }));
  let left = false, back = false;
  const dg = createDigest();
  const counts = {};
  const seen = (ev) => {
    for (const e of ev) counts[e.type] = (counts[e.type] || 0) + 1;
    for (const b of bots) b.onEvents(ev);
    dg.add(ev);
  };
  seen(room.start());
  let maxZombies = 0;
  while (room.clockMs < maxMs && room.phase !== 'over' && room.stage < maxStage) {
    if (churn && !left && room.stage >= 4) { left = true; seen(room.removePlayer('p4')); }
    if (churn && left && !back && room.stage >= 5) { back = true; seen(room.addPlayer({ id: 'p4', name: 'Delta' })); }
    if (room.ticks % 3 === 0) {
      const view = room.view();
      maxZombies = Math.max(maxZombies, view.zombies.filter((z) => !z.dead).length);
      for (const b of bots) {
        if (left && !back && b.id === 'p4') continue;
        const { input, actions } = b.think(view, room.clockMs);
        room.input(b.id, input);
        for (const a of actions) room.send(b.id, a);
      }
    }
    seen(room.step());
    if (room.ticks % snapEvery === 0) dg.add(room.snapshot());
  }
  const view = room.view();
  room.dispose();
  return { digest: dg.value, items: dg.count, counts, stage: view.stage, phase: view.phase, ms: room.clockMs, view, maxZombies };
}

describe('좀비 물량 막기: 화면 없이 돌리기', () => {
  const a = runMatch(GOLDEN.seed);

  test('restarea는 좀비 전용 맵이라 좀비 문을 쓴다', () => {
    assert.ok(isZombieMap(RESTAREA));
    const col = createHordeRoom({ map: RESTAREA, players: PLAYERS, seed: 1 });
    assert.ok(Array.isArray(zombieGates(RESTAREA, col.spawns)) && zombieGates(RESTAREA, col.spawns).length > 0);
    col.dispose();
  });

  test('봇 4명이 보스 스테이지와 증강 고르기를 지나 여러 스테이지를 간다', () => {
    if (process.env.HORDE_DIGEST_PRINT) console.log('[horde-headless]', JSON.stringify({ digest: a.digest, items: a.items, stage: a.stage, phase: a.phase, ms: a.ms, counts: a.counts, maxZombies: a.maxZombies }));
    assert.ok(a.stage >= 7, `7스테이지까지 가야 한다(도달 ${a.stage}, ${a.phase})`);
    assert.ok((a.counts.boss || 0) >= 2, '보스 스테이지(3·6)가 있었다');
    assert.ok((a.counts.bossSpawn || 0) >= 1, '보스가 나왔다');
    assert.ok((a.counts.levelUp || 0) >= 1, '팀 레벨이 올랐다');
    assert.ok((a.counts.card || 0) >= 4, '증강을 골랐다');
    assert.ok((a.counts.reroll || 0) >= 1, '다시 뽑기를 썼다');
    assert.ok((a.counts.down || 0) >= 1 && (a.counts.revive || 0) >= 1, '쓰러진 동료를 살렸다');
    assert.ok(a.maxZombies > 5, '좀비가 나왔다');
    for (const p of a.view.players) assert.ok(p.kills > 0, `${p.id}가 좀비를 잡았다`);
  });

  test('같은 씨앗·같은 입력이면 같은 이벤트 지문', () => {
    const b = runMatch(GOLDEN.seed);
    assert.equal(b.digest, a.digest);
    assert.equal(b.items, a.items);
  });

  test('다른 씨앗이면 다른 판', () => {
    const c = runMatch(GOLDEN.seed + 1, { maxStage: 2 });
    const a2 = runMatch(GOLDEN.seed, { maxStage: 2 });
    assert.notEqual(c.digest, a2.digest);
  });

  test('지문이 고정 값과 같다(규칙·좀비·보스·카드가 몰래 바뀌지 않았다)', () => {
    assert.equal(a.digest, GOLDEN.digest, `지문이 바뀌었다: ${a.digest}. 일부러 바꾼 것이면 GOLDEN.digest를 이 값으로 고친다`);
  });

  test('사람이 나갔다 다시 들어와도 판이 이어진다', () => {
    const r = runMatch(GOLDEN.seed, { churn: true, maxStage: 7 });
    assert.ok((r.counts.leave || 0) >= 1 && (r.counts.join || 0) >= 1, '나감·들어옴 이벤트');
    assert.ok(r.stage >= 6, `6스테이지까지 간다(도달 ${r.stage}, ${r.phase})`);
    const p4 = r.view.players.find((p) => p.id === 'p4');
    assert.ok(p4 && p4.connected && p4.alive, '다시 들어온 사람은 다음 스테이지에 나온다');
  });

  test('마지막 사람이 투사체·장판에 쓰러져 판이 끝나도 같은 틱의 나머지가 빈 목록을 읽지 않는다', () => {
    // 예전에는 gameOver가 투사체·장판 목록을 비운 뒤 같은 반복이 다음 칸(undefined)을 읽어 TypeError로 틱이 끊겼다(전멸 이벤트도 사라졌다)
    for (const kind of ['projectile', 'hazard']) {
      const pos = { p1: [0, 0, 0] };
      const d = createHorde({
        players: [{ id: 'p1', name: 'Alpha' }], world: null, nav: null, seed: 5, getPositions: () => pos,
        spawns: { owner: [{ x: 0, z: 0 }], charterer: [{ x: 400, z: 0 }] }, rules: { prepMs: 100, stageMs: 600000, cardMs: 600000 }
      });
      d.start();
      for (let i = 0; i < 10 && d.phase !== 'wave'; i++) d.tick(100);
      assert.equal(d.phase, 'wave');
      const { S, players, projectiles, hazards } = d.internals;
      const P = players.get('p1');
      P.hp = 1; P.shield = 0; P.hitUntil = 0; P.invulnUntil = 0;
      for (let n = 0; n < 3; n++) {
        if (kind === 'projectile') projectiles.push({ id: 900 + n, kind: 1, pos: [0, 1, 0], vel: [0, 0, 0], arc: false, dmg: 50, blast: null, pool: null, slow: null, pull: 0, boss: false, noHeal: 0, chain: null, born: S.clock, life: 4000 });
        else hazards.push({ id: 900 + n, kind: 1, kindName: 'acid', x: 0, y: 0, z: 0, r: 3, until: S.clock + 5000, ms: 5000, dps: 100, slow: 0, boss: false, afflicted: null, tick: 1 });
      }
      let ev = [];
      assert.doesNotThrow(() => { ev = d.tick(1000 / 30); }, kind);
      assert.equal(d.phase, 'over', kind);
      assert.ok(ev.some((e) => e.type === 'over' && e.reason === 'wiped'), `${kind}: 전멸 이벤트가 나간다`);
      d.dispose();
    }
  });

  test('씨앗 없이는 방을 만들지 않는다', () => {
    assert.throws(() => createHordeRoom({ map: RESTAREA, players: PLAYERS }));
  });
});

describe('지문 도구', () => {
  test('키 순서와 상관없이 같은 값', () => {
    assert.equal(stableJson({ b: 1, a: [1, { d: 2, c: 3 }] }), stableJson({ a: [1, { c: 3, d: 2 }], b: 1 }));
    assert.equal(digestOf([{ a: 1 }, { b: 2 }]), digestOf([{ a: 1 }, { b: 2 }]));
    assert.notEqual(digestOf([{ a: 1 }, { b: 2 }]), digestOf([{ b: 2 }, { a: 1 }]));
    assert.match(digestOf([]), /^[0-9a-f]{16}$/);
  });
});
