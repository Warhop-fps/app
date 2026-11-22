/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 서버가 판정하는 개인전(server/core/room.js의 mode 'ffa') 시험. 목표 킬 자르기, 즉시 부활(respawn)과 거절, 경기 끝 보상(core/rewards.js),
 *          받은 줄(inbox) 순서, 브라우저와 함께 쓰는 보상 요약(js/game/rules/summary.js)을 소켓 없이 본다.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { matchReward, MATCH_POINTS, QUICK_RESPAWN_POINTS } from '../js/account/economy.js';
import { matchSummary, ffaTarget } from '../js/game/rules/summary.js';
import { matchSummary as sessionMatchSummary } from '../js/game/session.js';
import { QUICK_RESPAWN_COST, matchRewards } from '../server/core/rewards.js';
import { KEY, aimFromTo, roomWith } from './server-room-kit.mjs';

const FFA = { mode: 'ffa', rules: { killTarget: 5, respawnMs: 3000, spawnProtectMs: 0, loadoutMs: 0, timeLimitMs: 120000 } };

function aimInput(t, i, j, extra = {}) {
  const { yaw, pitch } = aimFromTo(t.actor(i), t.actor(j).state.pos);
  return { yaw, pitch, ...extra };
}

function goLive(t, ticks = 40) {
  t.room.input(t.ids[0], { t: 'start' });
  for (let i = 0; i < ticks && t.room.phase !== 'live'; i++) t.room.tick();
  assert.equal(t.room.phase, 'live');
}

/** 사람 0이 사람 1을 쓰러뜨릴 때까지 쏜다. 걸린 틱 수를 돌려준다 */
function killOne(t, limit = 600) {
  const victim = t.actor(1);
  for (let i = 0; i < limit; i++) {
    if (!victim.alive) return i;
    t.input(0, aimInput(t, 0, 1, { keys: KEY.FIRE | KEY.AIM }));
    t.room.tick();
  }
  throw new Error('쓰러뜨리지 못했다');
}

/** 두 사람을 마주 세운다(가림막 없는 시험장, 6 m) */
function faceOff(t) {
  t.actor(0).spawn({ x: -3, z: 0, rotY: -Math.PI / 2 });
  t.actor(1).spawn({ x: 3, z: 0, rotY: Math.PI / 2 });
}

const welcomeOf = (peer) => JSON.parse(peer.texts.find((s) => s.startsWith('{"t":"welcome"')));

describe('개인전 방: 목표 킬', () => {
  test('방을 만들 때 목표 킬은 5~20으로 자르고, 없으면 20. welcome에 싣는다', () => {
    assert.equal(roomWith({ mode: 'ffa', killTarget: 3 }, [{}]).room.killTarget, 5);
    assert.equal(roomWith({ mode: 'ffa', killTarget: 30 }, [{}]).room.killTarget, 20);
    assert.equal(roomWith({ mode: 'ffa', killTarget: 12 }, [{}]).room.killTarget, 12);
    const t = roomWith({ mode: 'ffa' }, [{}]);
    assert.equal(t.room.killTarget, 20);
    assert.equal(welcomeOf(t.peers[0]).killTarget, 20);
    assert.equal(welcomeOf(roomWith({}, [{ team: 'owner' }]).peers[0]).killTarget, null, '팀전에는 목표 킬이 없다');
  });

  test('개인전에서는 팀이 없고 팀 바꾸기는 그 사람에게만 거절이 간다', () => {
    const t = roomWith({ mode: 'ffa' }, [{ team: 'owner' }, {}]);
    assert.equal(t.actor(0).team, null);
    t.room.input(t.ids[0], { t: 'team', team: 'charterer' });
    t.room.tick();
    assert.ok(t.peers[0].events().some((e) => e.type === 'reject' && e.action === 'setTeam' && e.reason === 'ffa_mode'));
    assert.ok(!t.peers[1].events().some((e) => e.type === 'reject'));
  });
});

describe('개인전 방: 즉시 부활', () => {
  test('죽어서 기다리는 동안 respawn을 보내면 다음 틱에 instant 출격, 횟수를 센다', () => {
    const t = roomWith(FFA, [{}, {}]);
    goLive(t);
    faceOff(t);
    t.steps(30);
    killOne(t);
    assert.equal(t.actor(1).alive, false);
    t.peers[1].clear();
    t.room.input(t.ids[1], { t: 'respawn' });
    assert.equal(t.actor(1).alive, false, '받은 줄에 쌓였다가 틱에서 처리한다');
    t.room.tick();
    const sp = t.peers[1].events().find((e) => e.type === 'spawn' && e.id === t.ids[1]);
    assert.ok(sp && sp.instant, 'instant spawn');
    assert.equal(t.actor(1).alive, true);
    assert.equal(t.room.stats().quickRespawns, 1);
  });

  test('살아 있을 때·부활이 곧일 때의 respawn은 그 사람에게만 거절이 간다', () => {
    const t = roomWith({ ...FFA, rules: { ...FFA.rules, respawnMs: 600 } }, [{}, {}]);
    goLive(t);
    t.room.input(t.ids[1], { t: 'respawn' });
    t.room.tick();
    assert.ok(t.peers[1].events().some((e) => e.type === 'reject' && e.action === 'respawnNow' && e.reason === 'not_waiting'));
    assert.ok(!t.peers[0].events().some((e) => e.type === 'reject'));
    faceOff(t);
    t.steps(30);
    killOne(t);
    t.steps(10);   // 0.6초 부활 중 0.33초가 지났다 → 0.5초보다 적게 남았다
    t.peers[1].clear();
    t.room.input(t.ids[1], { t: 'respawn' });
    t.room.tick();
    assert.ok(t.peers[1].events().some((e) => e.type === 'reject' && e.reason === 'too_late'));
    assert.equal(t.room.stats().quickRespawns, 0);
  });

  test('팀전에서는 respawn을 받지 않는다(not_ffa)', () => {
    const t = roomWith({ rules: { loadoutMs: 0 } }, [{ team: 'owner' }, { team: 'charterer' }]);
    t.room.input(t.ids[0], { t: 'respawn' });
    t.room.tick();
    assert.ok(t.peers[0].events().some((e) => e.type === 'reject' && e.reason === 'not_ffa'));
  });
});

describe('개인전 방: 경기 끝 보상', () => {
  test('목표 킬에 닿으면 끝나고, 사람마다 자기 보상만 받는다(짧은 판 승리 보상 비례, 즉시 부활 값은 뺀다)', () => {
    const t = roomWith(FFA, [{ name: '하늘' }, { name: '바다' }]);
    goLive(t);
    let end = null;
    for (let k = 0; k < 5 && !end; k++) {
      faceOff(t);
      t.steps(30);
      killOne(t);
      t.steps(1);
      end = t.peers[0].events().find((e) => e.type === 'matchEnd');
      if (!end) {
        t.room.input(t.ids[1], { t: 'respawn' });
        t.room.tick();
      }
    }
    assert.ok(end, '5킬에서 끝난다');
    assert.equal(end.winner, t.ids[0]);
    assert.equal(end.reason, 'kills');
    const r0 = t.peers[0].events().filter((e) => e.type === 'reward');
    const r1 = t.peers[1].events().filter((e) => e.type === 'reward');
    assert.equal(r0.length, 1);
    assert.equal(r1.length, 1);
    assert.equal(r0[0].id, t.ids[0]);
    assert.equal(r1[0].id, t.ids[1]);
    const w = r0[0];
    assert.equal(w.summary.win, true);
    assert.equal(w.summary.killTarget, 5);
    assert.equal(w.summary.kills, 5);
    const m = MATCH_POINTS.multi;
    assert.equal(w.reward.gained, 5 * m.kill + w.summary.headshots * m.headshot + Math.round((m.win * 5) / 20) + m.finish);
    const l = r1[0];
    assert.equal(l.summary.win, false);
    assert.equal(l.summary.deaths, 5);
    assert.equal(l.quick, 4);
    assert.equal(l.cost, 4 * QUICK_RESPAWN_POINTS.multi);
    assert.equal(l.reward.gained, m.finish - 4 * QUICK_RESPAWN_COST);
    assert.equal(l.reward.breakdown.reduce((s, x) => s + x.points, 0), l.reward.gained, '줄의 합 = 합계');
  });

  test('matchRewards: 팀전은 이긴 팀 사람에게 승리 보상', () => {
    const ev = { type: 'matchEnd', winner: 'owner', reason: 'rounds', stats: [['a', 3, 1, 1, 300, 0], ['b', 1, 3, 0, 100, 0]] };
    const out = matchRewards(ev, { players: [{ id: 'a', team: 'owner' }, { id: 'b', team: 'charterer' }], mode: 'team', ruleset: 'classic', mapId: 'arena', seconds: 90 });
    assert.equal(out.length, 2);
    assert.equal(out[0].summary.win, true);
    assert.equal(out[1].summary.win, false);
    assert.deepEqual(out[0].reward, matchReward(out[0].summary));
    assert.equal(out[0].summary.seconds, 90);
    assert.deepEqual(matchRewards({ type: 'phase' }, { players: [] }), []);
  });
});

describe('받은 줄(inbox): 방 하나 = 한 줄로 도는 actor', () => {
  test('pick·start는 받는 즉시가 아니라 다음 틱 처음에 도착 순서대로 처리한다', () => {
    const slow = { ...FFA, rules: { ...FFA.rules, loadoutMs: 1000 } };
    // 시작 → 고르기: 무기 선택 단계에서 고른 것이라 받아들인다
    const a = roomWith(slow, [{}, {}]);
    a.room.input(a.ids[0], { t: 'start' });
    a.room.input(a.ids[0], { t: 'pick', weapon: 'sr_bolt' });
    assert.equal(a.room.phase, 'warmup');
    assert.equal(a.room.inboxSize, 2);
    a.room.tick();
    assert.equal(a.room.inboxSize, 0);
    assert.equal(a.room.phase, 'loadout');
    assert.ok(a.peers[0].events().some((e) => e.type === 'loadout' && e.weaponId === 'sr_bolt'));
    // 고르기 → 시작: 대기실에서 고른 것이라 거절된다(순서가 바뀌지 않았다)
    const b = roomWith(slow, [{}, {}]);
    b.room.input(b.ids[0], { t: 'pick', weapon: 'sr_bolt' });
    b.room.input(b.ids[0], { t: 'start' });
    b.room.tick();
    assert.equal(b.room.phase, 'loadout');
    assert.ok(b.peers[0].events().some((e) => e.type === 'reject' && e.action === 'setLoadout' && e.reason === 'not_loadout'));
  });

  test('나간 사람이 남긴 메시지는 버린다. 상한을 넘으면 오래된 것부터 버린다', () => {
    const t = roomWith({ ...FFA, inboxMax: 3 }, [{}, {}, {}]);
    t.room.input(t.ids[2], { t: 'start' });
    t.room.leave(t.ids[2]);
    for (let i = 0; i < 5; i++) t.room.input(t.ids[1], { t: 'pick', weapon: 'ar_std' });
    assert.equal(t.room.inboxSize, 3);
    assert.equal(t.room.stats().inboxDropped, 3);
    t.room.tick();
    assert.equal(t.room.phase, 'warmup');
  });
});

describe('보상 요약(js/game/rules/summary.js)', () => {
  test('세션의 matchSummary는 같은 함수를 다시 내보낸다(동작이 같다)', () => {
    assert.equal(sessionMatchSummary, matchSummary);
  });

  test('개인전: 결과표(ranking)의 내 줄, 목표 킬, 무승부', () => {
    const ev = { type: 'matchEnd', mode: 'ffa', winner: 'p1', reason: 'kills', ranking: [{ rank: 1, id: 'p1', kills: 10, deaths: 2, headshots: 3 }, { rank: 2, id: 'p2', kills: 4, deaths: 9, headshots: 0 }] };
    const s1 = matchSummary({ view: { rules: { killTarget: 10 } }, event: ev, me: 'p1', mode: 'ffa', ruleset: 'knife', mapId: 'arena', knifeKills: 99, seconds: 61.4 });
    assert.deepEqual(s1, {
      online: true, ruleset: 'knife', mode: 'ffa', mapId: 'arena', kills: 10, deaths: 2, headshots: 3, halfShots: 0, knifeKills: 10,
      win: true, draw: false, seconds: 61, killTarget: 10
    });
    const s2 = matchSummary({ view: null, event: { ...ev, winner: null, reason: 'draw' }, me: 'p2', mode: 'ffa' });
    assert.equal(s2.win, false);
    assert.equal(s2.draw, true);
    assert.equal(s2.killTarget, 20, '목표 킬을 모르면 20');
    assert.equal(matchSummary({ view: null, event: ev, me: 'p9', mode: 'ffa' }), null, '결과표에 없으면 null');
    assert.equal(ffaTarget({ killTarget: 7 }), 7);
  });
});
