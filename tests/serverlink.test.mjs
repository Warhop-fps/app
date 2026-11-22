/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 서버 판정 개인전 번역기(js/game/serverlink.js) 시험. 사람 id 바꾸기, 점수판·이벤트 모양, 보상 이벤트(나만), 원격 보간,
 *          내 위치 보정(작은 오차는 두기·중간은 당기기·큰 오차는 옮기기), 입력 표본(키·새로 누름·무기 칸)을 본다.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createServerLink, createInputSampler, GS_PREFIX, TOLERANCE, BLEND } from '../js/game/serverlink.js';
import { applySnapshot, createMatch } from '../js/game/match.js';
import { KEY, PRESS } from '../js/net/gameproto.js';
import { FLAG } from '../js/game/protocol.js';

const ALIVE = FLAG.alive | FLAG.onGround;
const row = (id, x, y, z, ack = null, flags = ALIVE, hp = 100, weapon = 'ar_std') => [id, Math.round(x * 100), Math.round(y * 100), Math.round(z * 100), 0, 0, flags, hp, weapon, ack];

function link() {
  const l = createServerLink({ me: 'relayMe', mid: 'm1', map: 'arena', ruleset: 'classic' });
  l.welcome({ playerId: 'p2', hz: 30, paid: true });
  return l;
}

describe('서버 판정 번역기: id·모양', () => {
  test('내 서버 id는 화면의 내 id, 다른 사람은 gs- 접두. 점수판은 방장 판정과 같은 스냅샷 모양(applySnapshot이 읽는다)', () => {
    const l = link();
    assert.equal(l.paid, true);
    assert.equal(l.mapId('p2'), 'relayMe');
    assert.equal(l.mapId('p1'), GS_PREFIX + 'p1');
    const m = createMatch({ rules: { mode: 'ffa', killTarget: 5 }, players: [{ id: 'p1', name: '가' }, { id: 'p2', name: '나' }] });
    const d = l.matchData({ t: 'match', match: m.snapshot() });
    assert.equal(d.from, 'server');
    assert.deepEqual([d.snapshot.mid, d.snapshot.gm, d.snapshot.map, d.snapshot.rs], ['m1', 'ffa', 'arena', 'classic']);
    const v = applySnapshot(d.snapshot);
    assert.deepEqual(v.players.map((p) => p.id).sort(), ['gs-p1', 'relayMe']);
    m.dispose();
  });

  test('이벤트의 id·순위표·스폰 표를 바꾸고 mid를 붙인다. 연출은 남의 것만, 보상은 내 것만', () => {
    const l = link();
    const out = l.eventsData({
      t: 'events', events: [
        { type: 'kill', killer: 'p1', victim: 'p2', weaponId: 'ar_std' },
        { type: 'phase', phase: 'live', loadouts: { p1: 'ar_std', p2: 'sm_vx3' } },
        { type: 'matchEnd', mode: 'ffa', winner: 'p1', ranking: [{ rank: 1, id: 'p1' }, { rank: 2, id: 'p2' }] },
        { type: 'fire', id: 'p1', w: 'ar_std', o: [0, 1, 0], h: [1, 1, 1], hk: 'world' },
        { type: 'fire', id: 'p2', w: 'ar_std', o: [0, 1, 0], h: [1, 1, 1], hk: 'world' },
        { type: 'reward', id: 'p2', reward: { gained: 60 }, server: true },
        { type: 'reject', action: 'start', by: 'p2' }
      ]
    });
    const [kill, phase, end] = out.data.events;
    assert.deepEqual([kill.killer, kill.victim, kill.mid], ['gs-p1', 'relayMe', 'm1']);
    assert.deepEqual(Object.keys(phase.loadouts).sort(), ['gs-p1', 'relayMe']);
    assert.equal(end.winner, 'gs-p1');
    assert.deepEqual(end.ranking.map((r) => r.id), ['gs-p1', 'relayMe']);
    assert.deepEqual(out.fx.map((f) => f.id), ['gs-p1'], '내 사격 연출은 이미 내 화면이 그렸다');
    assert.equal(out.reward.reward.gained, 60);
    assert.equal(l.reward.server, true);
    assert.equal(out.data.events.length, 3, 'reject·연출·보상은 세션 이벤트가 아니다');
  });
});

describe('서버 판정 번역기: 위치', () => {
  test('원격 사람은 서버 틱 시간으로 보간하고, 속도를 줄 사이에서 잰다', () => {
    const l = link();
    for (let k = 0; k < 10; k++) l.snap({ t: 'snap', tick: 100 + k, players: [row('p1', k * 0.2, 0, 0)] }, 1000 + k * 33.3);
    const s = l.remote('gs-p1', 1000 + 9 * 33.3);
    assert.ok(s && s.pos[0] >= 0 && s.pos[0] <= 1.8, JSON.stringify(s && s.pos));
    assert.ok(Math.abs(s.vel[0] - 6) < 0.5, `속도 약 6 m/s (${s.vel[0]})`);
    assert.equal(s.weaponId, 'ar_std');
    assert.equal(s.alive, true);
    const vt = l.viewTick(1000 + 9 * 33.3);
    assert.ok(vt > 100 && vt <= 109.5, `그리는 틱 ${vt}`);
  });

  test('내 위치: 작은 오차는 두고, 중간 오차는 BLEND만큼 당기고(두 번 당기지 않게), 큰 오차는 옮긴다', () => {
    const l = link();
    l.predicted(1, [0, 0, 0]);
    l.snap({ t: 'snap', tick: 1, players: [row('p2', TOLERANCE / 2, 0, 0, 1)] }, 0);
    assert.equal(l.takeCorrection(), null, '작은 오차');
    l.predicted(2, [0, 0, 0]);
    l.predicted(3, [0, 0, 0]);
    l.snap({ t: 'snap', tick: 2, players: [row('p2', 1, 0, 0, 2)] }, 0);
    const c = l.takeCorrection();
    assert.ok(c && !c.snap);
    assert.ok(Math.abs(c.dx - BLEND) < 1e-6);
    assert.equal(l.takeCorrection(), null, '한 번만 준다');
    // 3번 입력의 기록은 이미 BLEND만큼 옮겨졌다 → 같은 서버 자리면 남은 오차만
    l.snap({ t: 'snap', tick: 3, players: [row('p2', 1, 0, 0, 3)] }, 0);
    const c2 = l.takeCorrection();
    assert.ok(c2 && Math.abs(c2.dx - (1 - BLEND) * BLEND) < 1e-6);
    l.predicted(4, [0, 0, 0]);
    l.snap({ t: 'snap', tick: 4, players: [row('p2', 10, 0, 0, 4)] }, 0);
    const big = l.takeCorrection();
    assert.equal(big.snap, true);
    assert.deepEqual(big.pos, [10, 0, 0]);
    assert.equal(l.stats().snaps, 1);
  });

  test('죽어 있는 내 줄이나 같은 ack는 보정하지 않는다', () => {
    const l = link();
    l.predicted(5, [0, 0, 0]);
    l.snap({ t: 'snap', tick: 5, players: [row('p2', 2, 0, 0, 5, 0, 0)] }, 0);
    assert.equal(l.takeCorrection(), null);
    assert.equal(l.mine.alive, false);
  });
});

describe('입력 표본', () => {
  test('누르고 있는 키, 새로 누름(표본 사이의 짧은 누름 포함), 바뀐 무기 칸만', () => {
    const s = createInputSampler();
    let m = s.sample({ forward: true, fire: true }, { yaw: 1, pitch: 0.2, slot: 1, aiming: true });
    assert.equal(m.keys, KEY.FORWARD | KEY.FIRE | KEY.AIM);
    assert.equal(m.press, PRESS.FIRE | PRESS.AIM);
    assert.equal(m.slot, 1);
    assert.deepEqual([m.yaw, m.pitch], [1, 0.2]);
    m = s.sample({ forward: true, fire: true }, { slot: 1, aiming: true });
    assert.equal(m.press, 0, '누르고 있으면 새로 누름이 아니다');
    assert.equal(m.slot, 0, '같은 칸은 다시 보내지 않는다');
    s.note('reload');
    s.note('fire');
    m = s.sample({}, { slot: 2 });
    assert.equal(m.press, PRESS.RELOAD | PRESS.FIRE, '표본 사이에 눌렀다 뗀 클릭');
    assert.equal(m.slot, 2);
    assert.equal(m.keys, 0);
  });
});
