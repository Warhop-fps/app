/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 실제 소켓으로 붙는 좀비 방 시험. 대본 봇 손님 4명이 127.0.0.1의 서버에서 보스 스테이지를 끝내는지, 이벤트가 번호로 한 번씩만 닿는지,
 *          스냅샷을 화면 쪽 진행(createHordeClient)이 그대로 받는지, 5번째 사람과 판이 다른 손님을 거절하는지, 거절이 보낸 사람에게만 가는지,
 *          좀비 맵이 아니면 좀비 맵으로 바꾸는지, 판 끝 요약(onHordeMatchEnd)이 오는지 본다.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

import { CLOSE, PROTOCOL } from '../core/protocol.js';
import { createHordeFakeClient } from '../tools/horde-client.js';
import { createHordeClient } from '../../js/game/horde/client.js';
import { HORDE_RELIABLE } from '../../js/net/hordeproto.js';
import { startTestServer, until } from './helpers.mjs';

/** 열고 모든 메시지를 모으는 날 소켓 */
function rawClient(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const msgs = [];
    const closed = new Promise((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
    ws.on('message', (d) => { try { msgs.push(JSON.parse(d.toString())); } catch { /* 무시 */ } });
    ws.on('open', () => resolve({ ws, msgs, closed, find: (p) => msgs.find(p) }));
    ws.on('error', reject);
  });
}
/** 화면 쪽 진행이 부르는 UI(보인 화면과 넘긴 값만 기억한다) */
function fakeUi() {
  const visible = new Set();
  const shown = [];
  const hud = { center() {}, callout() {}, banner() {} };
  return {
    hud, shown,
    show(name, props) { visible.add(name); shown.push({ name, props }); },
    update() {}, hide(name) { visible.delete(name); }, isVisible: (name) => visible.has(name), on: () => () => {}
  };
}
const zjoin = (ws, extra = {}) => ws.send(JSON.stringify({ t: 'join', v: PROTOCOL, name: 'raw', opts: { mode: 'zombie', map: 'restarea' }, ...extra }));

describe('좀비 방: 봇 4명이 보스 스테이지를 끝낸다', () => {
  let server;
  const ends = [];
  const clients = [];
  let hc = null, applied = 0, applyError = null;
  const ui = fakeUi();
  before(async () => {
    // 3스테이지(보스)부터, 준비 2초. 손님은 이 값을 고를 수 없다(서버 설정)
    server = await startTestServer({ hordeStartStage: 3, hordeRules: { prepMs: 2000 }, onHordeMatchEnd: (s) => ends.push(s) });
    for (let i = 0; i < 4; i++) {
      const c = createHordeFakeClient({
        url: server.url, room: 'zboss', name: `봇${i + 1}`, map: 'restarea', seed: 11 + i, bot: { reroll: i === 0, weaponId: i === 3 ? 'sg_pump' : 'ar_std' },
        onView: i === 1 ? (view, events) => { try { hc.apply(view, events); applied++; } catch (err) { applyError = applyError || err; } } : null
      });
      clients.push(c);
      await c.ready;
      // 화면 쪽 진행(브라우저 손님이 쓰는 것)에 서버 스냅샷을 그대로 넣어 본다. World·UI는 빈 객체
      if (i === 1) hc = createHordeClient({ world: {}, ui, meId: c.id, actions: { pick() {}, reroll() {}, loot() {}, revive() {} } });
    }
  });
  after(async () => {
    for (const c of clients) await c.close();
    if (hc) hc.dispose();
    await server.close();
  });

  test('방장 start → 보스가 나오고, 보스 스테이지(3)가 끝나 4스테이지가 시작된다', async () => {
    await clients[0].waitFor((s) => s.lobby && s.lobby.players.length === 4, 5000, '전원 입장');
    assert.equal(clients[0].state.leader, clients[0].id, '먼저 들어온 사람이 방장');
    clients[0].start();
    await clients[0].waitFor((s) => s.stage >= 4, 90000, '4스테이지');
    const st = clients[0].stats();
    assert.ok((st.counts.bossSpawn || 0) >= 1, '보스가 나왔다');
    assert.ok((st.counts.clear || 0) + (st.counts.timeup || 0) >= 1, '보스 스테이지가 끝났다');
    assert.ok(st.snaps > 50 && st.snapMax < 16384, `스냅샷 ${st.snaps}개, 가장 큰 것 ${st.snapMax} B`);
  });

  test('모두 같은 이벤트를 한 번씩 받는다(다시 실은 것은 번호로 거른다)', async () => {
    // 같은 틱까지 받게 잠깐 기다린다
    await new Promise((r) => setTimeout(r, 300));
    const ref = clients[0].stats().counts;
    for (const c of clients) {
      const st = c.stats();
      assert.ok(st.dup > 0, '스냅샷에 다시 실린 이벤트가 있었다');
      assert.equal(st.resentNew, 0, '끊기지 않은 접속에서는 다시 실린 이벤트가 새것일 일이 없다');
      for (const type of ['phase', 'boss', 'bossSpawn', 'offer', 'card']) assert.equal(st.counts[type] || 0, ref[type] || 0, `${c.id}의 ${type} 수`);
    }
    for (const type of ['phase', 'boss', 'offer', 'card', 'spawn']) assert.ok(HORDE_RELIABLE.includes(type));
  });

  test('화면 쪽 진행(createHordeClient.apply)이 서버 스냅샷·이벤트를 오류 없이 받는다', () => {
    assert.equal(applyError, null, applyError && applyError.stack);
    assert.ok(applied > 50, `apply ${applied}번`);
    assert.ok(ui.shown.some((x) => x.name === 'horde'), '좀비 HUD를 띄웠다');
    const cards = ui.shown.filter((x) => x.name === 'cards');
    assert.ok(cards.length >= 1 && cards[0].props.cards.length >= 1, '서버가 낸 증강 제안을 카드 화면에 띄웠다');
  });

  test('5번째 사람은 room_full(4001)로 거절한다', async () => {
    const c = await rawClient(server.roomUrl('zboss'));
    zjoin(c.ws);
    const closed = await c.closed;
    assert.equal(closed.code, CLOSE.ROOM_FULL);
    assert.ok(c.find((m) => m.t === 'error' && m.code === 'room_full'));
  });

  test('거절은 보낸 사람에게만 간다(없는 좀비 맞힘 · 방장이 아닌 사람의 start)', async () => {
    const before = clients.map((c) => c.state.rejects.length);
    clients[2].send({ t: 'zhit', victimId: 'z999999', weaponId: 'ar_std', part: 'body', dist: 5, kind: 'shot', count: 1, shotId: 999999 });
    clients[3].start();
    await clients[2].waitFor((s) => s.rejects.some((e) => e.reason === 'unknown_zombie' || e.reason === 'not_wave'), 3000, 'c2 거절');
    await clients[3].waitFor((s) => s.rejects.some((e) => e.action === 'start' && e.reason === 'not_leader'), 3000, 'c3 거절');
    await new Promise((r) => setTimeout(r, 200));
    const r2 = clients[2].state.rejects.slice(before[2]);
    assert.ok(r2.every((e) => e.eid === undefined && e.by === clients[2].id), '거절에는 번호가 없고 보낸 사람 표시가 있다');
    assert.ok(!clients[0].state.rejects.slice(before[0]).some((e) => e.reason === 'not_leader' || e.reason === 'unknown_zombie'), '다른 사람은 거절을 받지 않는다');
  });

  test('모두 나가면 판이 끝나고 onHordeMatchEnd(요약)를 한 번 부른다', async () => {
    for (const c of clients) await c.close();
    await until(() => ends.length >= 1, 3000, '판 끝 요약');
    const s = ends[0];
    assert.equal(s.mode, 'zombie');
    assert.equal(s.roomId, 'zboss');
    assert.equal(s.map, 'restarea');
    assert.ok(Number.isInteger(s.seed) && s.seed > 0, '서버가 정한 씨앗');
    assert.equal(s.firstStage, 3);
    assert.ok(s.stage >= 4);
    assert.equal(s.players.length, 4);
    for (const p of s.players) for (const k of ['id', 'name', 'kills', 'stage', 'cleared', 'ms', 'cards']) assert.ok(k in p, `요약의 ${k}`);
    assert.equal(ends.length, 1);
  });
});

describe('좀비 방: 입장', () => {
  let server;
  before(async () => { server = await startTestServer(); });
  after(async () => { await server.close(); });

  test('판이 다른 손님은 bad_version(4002)으로 거절하고 방은 만들지 않는다', async () => {
    const c = await rawClient(server.roomUrl('zver'));
    zjoin(c.ws, { v: PROTOCOL - 1 });
    const closed = await c.closed;
    assert.equal(closed.code, CLOSE.BAD_VERSION);
    const e = c.find((m) => m.t === 'error');
    assert.equal(e.code, 'bad_version');
    assert.equal(e.reload, true);
    assert.equal(server.rooms.has('zver'), false);
  });

  test('좀비 맵이 아닌 맵을 고르면 좀비 맵(restarea)으로, subway는 그대로', async () => {
    const a = await rawClient(server.roomUrl('zmap1'));
    zjoin(a.ws, { opts: { mode: 'zombie', map: 'arena' } });
    await until(() => a.find((m) => m.t === 'welcome'), 3000, 'welcome');
    const w = a.find((m) => m.t === 'welcome');
    assert.equal(w.mode, 'zombie');
    assert.equal(w.map, 'restarea');
    assert.equal(w.zombie.maxPlayers, 4);
    assert.equal(w.zombie.snapHz, 10);
    const b = await rawClient(server.roomUrl('zmap2'));
    zjoin(b.ws, { opts: { mode: 'zombie', map: 'subway' } });
    await until(() => b.find((m) => m.t === 'welcome'), 3000, 'welcome');
    assert.equal(b.find((m) => m.t === 'welcome').map, 'subway');
    a.ws.close(); b.ws.close();
    await Promise.all([a.closed, b.closed]);
  });

  test('개인전 방에 좀비 형식을 보내도 끊지 않고 버린다', async () => {
    const c = await rawClient(server.roomUrl('zffa'));
    c.ws.send(JSON.stringify({ t: 'join', v: PROTOCOL, name: 'raw', opts: { mode: 'ffa' } }));
    await until(() => c.find((m) => m.t === 'welcome'), 3000, 'welcome');
    for (let i = 0; i < 5; i++) c.ws.send(JSON.stringify({ t: 'zs', x: 1, y: 0, z: 1, yaw: 0, slot: 1, air: false, alive: true }));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(c.ws.readyState, WebSocket.OPEN);
    assert.equal(server.rooms.get('zffa').mode, 'ffa');
    c.ws.close();
    await c.closed;
  });
});
