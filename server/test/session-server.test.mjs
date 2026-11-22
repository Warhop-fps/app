/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 끝에서 끝까지 시험. 진짜 게임 서버(로컬 포트, 결과 보내기 켬, 가짜 API)와 진짜 세션(js/game/session.js) 둘이 작은 가짜 중계 방·world·ui·계정으로
 *          서버 판정 개인전 한 판(목표 킬 5)을 끝까지 한다. 서버가 판정해 결과를 서명해 보내고, 브라우저는 포인트를 더하지 않는지(serverJudged),
 *          게임 서버에 닿지 않으면 방장 판정으로 대신하는지, 주소가 없으면 지금처럼 방장 판정인지 본다. 화면(브라우저)은 띄우지 않는다.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createSession } from '../../js/game/session.js';
import { aimAt } from '../core/combat.js';
import { verifyEnvelope } from '../api/src/result-sign.js';
import { startTestServer, until } from './helpers.mjs';

const SECRET = 'test-secret-0123456789abcdef-0123456789';
const copy = (v) => JSON.parse(JSON.stringify(v));

/* ---------------------------------------------------------------- 가짜 중계 방(메시지를 바로 건넨다) */
function createHub() {
  const hub = {
    roomId: 'relay1', meta: null, hostId: null, term: 0, members: new Map(), rooms: new Map(), sent: [],
    post(from, event, payload, to) {
      const msg = { from, event, payload: copy(payload), to };
      hub.sent.push(msg);
      setTimeout(() => {
        for (const room of [...hub.rooms.values()]) {
          if (room.myId !== from && (!to || to === room.myId)) room.emit('message', { ...msg, payload: copy(msg.payload), t: Date.now(), fromHost: from === hub.hostId });
        }
      }, 2);
    },
    announce(evt) { for (const room of [...hub.rooms.values()]) room.emit(evt, evt === 'players' ? room.players() : room.meta); },
    create(me, opts) {
      const { name, mapId, max, ...extra } = copy(opts);
      hub.meta = { roomId: hub.roomId, name, mapId, max, status: 'waiting', ...extra };
      hub.hostId = me.id;
      hub.term = 1;
      return hub.join(me);
    },
    join(me) {
      hub.members.set(me.id, { id: me.id, name: me.name, team: null, ready: false });
      const room = new FakeRoom(hub, me.id);
      hub.rooms.set(me.id, room);
      hub.announce('players');
      return room;
    },
    remove(id) { hub.members.delete(id); hub.rooms.delete(id); hub.announce('players'); }
  };
  return hub;
}
class FakeRoom {
  constructor(hub, id) { this.hub = hub; this.myId = id; this.subs = new Map(); this.rate = 10; }
  get id() { return this.hub.roomId; }
  get me() { return { ...this.hub.members.get(this.myId) }; }
  get meta() { return { ...this.hub.meta, hostId: this.hub.hostId, term: this.hub.term }; }
  isHost() { return this.hub.hostId === this.myId; }
  hostId() { return this.hub.hostId; }
  now() { return Date.now(); }
  players() { return [...this.hub.members.values()].map((p) => ({ ...p, isHost: p.id === this.hub.hostId, ping: 20 })); }
  on(evt, fn) {
    if (!this.subs.has(evt)) this.subs.set(evt, new Set());
    this.subs.get(evt).add(fn);
    return () => this.subs.get(evt).delete(fn);
  }
  emit(evt, data) { for (const fn of [...(this.subs.get(evt) || [])]) fn(data); }
  handle(event, fn) { return this.on('message', (m) => { if (m.event === event) fn(m.payload, m); }); }
  send(event, payload) { this.hub.post(this.myId, event, payload, null); return true; }
  sendTo(to, event, payload) { this.hub.post(this.myId, event, payload, String(to)); return true; }
  updateMe(fields) { Object.assign(this.hub.members.get(this.myId), fields); this.hub.announce('players'); return true; }
  updateMeta(fields) {
    if (!this.isHost()) return false;
    Object.assign(this.hub.meta, fields);
    this.hub.announce('meta');
    return true;
  }
  async leave() { this.hub.remove(this.myId); }
}
function fakeNet(hub, id, name) {
  return {
    me: Object.freeze({ id, name }), transport: 'relay', on: () => () => {},
    lobby: { synced: true, subscribe(fn) { fn([], { synced: true }); return () => {}; } },
    async createRoom(opts) { return hub.create({ id, name }, opts); },
    async joinRoom() { return hub.join({ id, name }); }
  };
}

/* ---------------------------------------------------------------- 가짜 world: 자리만 들고, 서버 보정(correctLocal)을 받는다 */
function fakeWorld() {
  const log = [];
  const w = {
    pos: [0, 0, 0], yaw: 0, pitch: 0, alive: false, corrections: 0,
    calls: (name) => log.filter((c) => c.name === name).map((c) => c.args),
    on() { return () => {}; },
    async loadMap(id) { log.push({ name: 'loadMap', args: [id] }); return { spawns: null, mapName: id }; },
    getLocalState: () => ({ pos: w.pos.slice(), vel: [0, 0, 0], yaw: w.yaw, pitch: w.pitch, slot: 1, hp: 100, onGround: true, alive: w.alive }),
    spawnLocal(o) { log.push({ name: 'spawnLocal', args: [o] }); w.pos = [o.spawn.x, Number.isFinite(o.spawn.y) ? o.spawn.y : 0, o.spawn.z]; w.alive = true; return true; },
    killLocal() { log.push({ name: 'killLocal', args: [] }); w.alive = false; return true; },
    correctLocal(c) {
      w.corrections++;
      if (c.snap) w.pos = c.pos.slice(); else { w.pos[0] += c.dx; w.pos[1] += c.dy; w.pos[2] += c.dz; }
      return true;
    }
  };
  for (const name of ['unloadMap', 'setRuleset', 'reset', 'setLocalLoadout', 'setLocalHp', 'addActor', 'removeActor', 'setActorState', 'actorFire', 'actorGrenade',
    'actorDeath', 'feedbackDamage', 'setRound', 'setControlsEnabled', 'setScoreboard', 'setHint', 'setPauseOptions', 'setMode', 'setRespawn', 'setProtect',
    'setActorProtect', 'sound', 'setMoverClock', 'setQuickRespawn', 'noteKill']) {
    w[name] = (...args) => { log.push({ name, args }); return true; };
  }
  return w;
}
function fakeUi() {
  const log = [];
  const handlers = new Map();
  return {
    chat: { push() {}, open() {}, clear() {} },
    hud: { center() {}, callout() {}, banner() {} },
    killfeed: { push() {}, clear() {} },
    show(name, props) { log.push({ name, kind: 'show', props }); },
    update(name, props) { log.push({ name, kind: 'update', props }); },
    hide() {}, isVisible: () => true, getPlayerName: () => '',
    on(action, fn) { handlers.set(action, fn); return () => handlers.delete(action); },
    fire(action, payload) { const fn = handlers.get(action); if (fn) fn(payload); },
    lastShown(name) { const list = log.filter((c) => c.name === name && c.kind === 'show'); return list.length ? list[list.length - 1].props : null; },
    props: (name) => log.filter((c) => c.name === name).reduce((acc, c) => (c.kind === 'show' ? { ...c.props } : { ...acc, ...c.props }), {})
  };
}
function fakeAccount(nickname, token) {
  const a = {
    profile: { nickname, owned: ['ar_std', 'pt_std', 'ml_knife'], points: 500 },
    loadout: { primary: 'ar_std', secondary: 'pt_std', melee: 'ml_knife' },
    remoteEnabled: true, recorded: [], spent: 0,
    retryNickname() { return new Promise(() => {}); },
    async tokenHash() { return createHash('sha256').update(token).digest('hex'); },
    recordMatch(summary, opts) { a.recorded.push({ summary, opts: opts || null }); return { gained: (opts && opts.serverReward && opts.serverReward.gained) || 0, breakdown: [], points: a.profile.points }; },
    spendPoints(n) { a.spent += n; return { ok: true, spent: n, points: a.profile.points }; }
  };
  return a;
}

/* ---------------------------------------------------------------- 두 사람 무대 */
function stage({ url, chooseEngine, connectGameServer } = {}) {
  const hub = createHub();
  const clients = [];
  const timers = [];
  const env = {
    hub, clients,
    client(id, name) {
      const token = (id === 'a' ? 'a' : 'b').repeat(64);
      const c = { id, world: fakeWorld(), ui: fakeUi(), account: fakeAccount(name, token), input: {}, logs: [], token };
      c.session = createSession({
        world: c.world, ui: c.ui,
        ctx: { account: c.account, maps: null, session: { name }, flags: {}, onFrame: () => () => {} },
        net: fakeNet(hub, id, name), log: (...a) => c.logs.push(a), setScreens: false,
        config: { transport: 'relay', gameServer: { url: url || '' } },
        inputState: c.input,
        ...(chooseEngine ? { chooseEngine } : {}),
        ...(connectGameServer ? { connectGameServer } : {}),
        ffaRules: { spawnProtectMs: 0, respawnMs: 300, timeLimitMs: 60000 }
      });
      clients.push(c);
      return c;
    },
    /** 화면 프레임 대신: 60 Hz로 session.frame(), 그 전에 내 시점을 가장 가까운 적에게 돌리고 그쪽으로 걷게 한다 */
    play() {
      timers.push(setInterval(() => {
        for (const c of clients) {
          const st = c.session.state;
          const s = c.session.debugServer && c.session.debugServer();
          if (st.phase === 'match' && s && c.world.alive) {
            const enemy = s.enemies.find((e) => e.alive) || null;
            if (enemy) {
              const eye = [c.world.pos[0], c.world.pos[1] + 1.6, c.world.pos[2]];
              const aim = aimAt(eye, [enemy.pos[0], enemy.pos[1] + 1.3, enemy.pos[2]]);
              c.world.yaw = aim.yaw;
              c.world.pitch = aim.pitch;
              c.input.forward = aim.dist > 6;
              c.input.fire = aim.dist < 25;
            } else { c.input.forward = false; c.input.fire = false; }
          } else { c.input.forward = false; c.input.fire = false; }
          c.session.frame();
        }
      }, 16));
    },
    dispose() { for (const t of timers) clearInterval(t); for (const c of clients) c.session.dispose(); }
  };
  return env;
}

async function openRoom(env, a, b, { killTarget = 5 } = {}) {
  await a.session.open();
  a.ui.fire('lobby:create', { name: '', max: 4, mapId: 'arena', mode: 'ffa', killTarget });
  await until(() => a.session.phase === 'room', 3000, '방 만들기');
  await b.session.open();
  b.ui.fire('lobby:join', { roomId: env.hub.roomId });
  await until(() => b.session.phase === 'room', 3000, '참가');
  b.ui.fire('room:ready', { ready: true });
}

describe('서버 판정 개인전(세션 + 진짜 게임 서버)', () => {
  test('둘이 5킬 한 판을 끝까지: 서버가 판정하고 결과를 서명해 보내고, 브라우저는 포인트를 더하지 않는다', { timeout: 150000 }, async (t) => {
    const posted = [];
    const fakeApi = async (url, init) => {
      const env = JSON.parse(init.body);
      const v = await verifyEnvelope(env, [SECRET], Date.now());
      posted.push({ v, env });
      return { status: 200, json: async () => ({ ok: true, duplicate: false, applied: env.result.players.length, skipped: 0 }) };
    };
    const server = await startTestServer({
      matchRules: { loadoutMs: 300, spawnProtectMs: 0, timeLimitMs: 120000 },
      resultUrl: 'https://api.test/v1/match-result', resultSecret: SECRET, serverId: 'test:1', fetch: fakeApi, map: 'arena'
    });
    const env = stage({ url: server.url, chooseEngine: async () => 'server' });
    const a = env.client('a', '하늘');
    const b = env.client('b', '구름');
    try {
      await openRoom(env, a, b);
      await new Promise((r) => setImmediate(r));
      env.play();
      a.ui.fire('room:start', {});
      await until(() => a.session.state.phase === 'match' && b.session.state.phase === 'match', 8000, '둘 다 경기 화면');
      assert.ok(env.hub.sent.some((m) => m.event === 'mx' && m.payload.eng === 's' && /^[a-z0-9]{12}$/.test(m.payload.gr)), 'prep에 서버 방');
      assert.equal(env.hub.sent.filter((m) => m.event === 'hitClaim' || m.event === 'match').length, 0, '중계로 판정 메시지가 나가지 않는다');
      await until(() => a.session.state.matchPhase === 'live', 15000, '라이브');
      await until(() => a.session.phase === 'results' && b.session.phase === 'results', 120000, '경기 끝');
      const ra = a.ui.lastShown('results');
      t.diagnostic(`우승 ${ra.winnerName}, 보정 a=${a.world.corrections} b=${b.world.corrections}, 결과 ${posted.length}`);
      assert.equal(ra.mode, 'ffa');
      assert.equal(ra.target, 5);
      assert.ok(ra.ranking[0].kills >= 5);
      assert.equal(b.ui.lastShown('results').winnerName, ra.winnerName, '둘이 같은 우승자를 본다');
      for (const c of [a, b]) {
        assert.equal(c.account.recorded.length, 1, `${c.id}: 한 번 기록`);
        const rec = c.account.recorded[0];
        assert.equal(rec.opts && rec.opts.serverJudged, true, `${c.id}: 서버 판정 → 포인트를 더하지 않는 기록`);
        assert.ok(rec.opts.serverReward && Number.isFinite(rec.opts.serverReward.gained), `${c.id}: 서버 보상을 보여 준다`);
        assert.equal(c.account.spent, 0, '즉시 부활 값도 브라우저가 내지 않는다');
      }
      await until(() => posted.length === 1, 5000, '결과 전송');
      const { v, env: envl } = posted[0];
      assert.equal(v.ok, true);
      const hashes = envl.result.players.map((p) => p.tokenHash).sort();
      assert.deepEqual(hashes, [await a.account.tokenHash(), await b.account.tokenHash()].sort(), '두 사람 모두 기기 토큰 해시로');
      for (const c of [a, b]) {
        const h = await c.account.tokenHash();
        const row = envl.result.players.find((p) => p.tokenHash === h);
        assert.equal(row.points, Math.max(0, c.account.recorded[0].opts.serverReward.gained), `${c.id}: 결과 포인트 = 화면에 보인 서버 보상`);
        assert.equal(row.kills, c.account.recorded[0].summary.kills);
      }
    } finally {
      env.dispose();
      await server.close();
    }
  });

  test('게임 서버에 닿지 않으면 방장 판정으로 대신하고 안내한다', { timeout: 30000 }, async () => {
    const env = stage({ url: 'ws://127.0.0.1:9', chooseEngine: async () => 'server', connectGameServer: async () => { const e = new Error('x'); e.code = 'GAME_SERVER'; throw e; } });
    const a = env.client('a', '하늘');
    const b = env.client('b', '구름');
    try {
      await openRoom(env, a, b);
      await new Promise((r) => setImmediate(r));
      a.ui.fire('room:start', {});
      await until(() => a.session.state.hosting, 5000, '방장 판정 시작');
      assert.ok(a.session.state.chat.some((l) => l.system && l.text.includes('방장이 판정')), '안내');
      assert.ok(!env.hub.sent.some((m) => m.event === 'mx' && m.payload.eng === 's'));
    } finally { env.dispose(); }
  });

  test('버전이 다르면 "새로고침 필요"를 띄우고 방장 판정으로', { timeout: 30000 }, async () => {
    const server = await startTestServer();
    const { connectGameServer } = await import('../../js/net/gameserver.js');
    const env = stage({ url: server.url, chooseEngine: async () => 'server', connectGameServer: (o) => connectGameServer({ ...o, version: 1 }) });
    const a = env.client('a', '하늘');
    const b = env.client('b', '구름');
    try {
      await openRoom(env, a, b);
      await new Promise((r) => setImmediate(r));
      a.ui.fire('room:start', {});
      await until(() => a.session.state.hosting, 5000, '방장 판정 시작');
      assert.ok(a.session.state.chat.some((l) => l.system && l.text.startsWith('새로고침 필요')), JSON.stringify(a.session.state.chat.map((l) => l.text)));
    } finally {
      env.dispose();
      await server.close();
    }
  });

  test('게임 서버 주소가 없으면 묻지도 않고 지금처럼 방장 판정', { timeout: 30000 }, async () => {
    let asked = 0;
    const env = stage({ url: '', chooseEngine: async () => { asked++; return 'server'; } });
    const a = env.client('a', '하늘');
    const b = env.client('b', '구름');
    try {
      await openRoom(env, a, b);
      a.ui.fire('room:start', {});
      await until(() => a.session.state.hosting, 5000, '방장 판정 시작');
      assert.equal(asked, 0);
    } finally { env.dispose(); }
  });
});
