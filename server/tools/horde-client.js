/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 게임 서버 좀비 방의 가짜 손님. 실제 WebSocket(/room/<id>)으로 붙어 받은 스냅샷을 브라우저와 같은 applyHordeSnapshot으로 풀고,
 *          화면 없는 방의 대본 봇(js/game/horde/sim/bots.js)이 그 뷰를 보고 낸 위치·행동을 손님 형식(zs·zhit·…)으로 보낸다.
 *          이벤트는 번호(eid)로 한 번씩만 받는다. 받은 바이트·이벤트 수·스냅샷 크기를 센다(시험·부하 측정·대역폭 측정).
 */
/**
 *   const c = createHordeFakeClient({ url: 'ws://127.0.0.1:8787', room: 'z1', name: '봇1', map: 'restarea', seed: 7 });
 *   await c.ready;         // welcome
 *   c.start();             // 방장만
 *   await c.waitFor((s) => s.stage >= 4, 60000, '4스테이지');
 *   c.stats();             // { bytesIn, bytesPerSec, events, resentNew, stage, phase, ... }
 *   await c.close();
 */
import WebSocket from 'ws';
import { buildCollision } from '../../js/maps/collision.js';
import { createHordeBot } from '../../js/game/horde/sim/bots.js';
import { applyHordeSnapshot } from '../../js/game/horde/wire.js';
import { HORDE_MODE, createEventFilter, encodeHordeAction, encodeHordeState } from '../../js/net/hordeproto.js';
import { mapData } from '../core/maps.js';
import { PROTOCOL } from '../core/protocol.js';

const worlds = new Map();
/** 봇이 발 높이를 맞추는 충돌 월드(맵마다 한 번). 움직이는 지형은 서버와 다르게 서 있을 수 있다(높이만 쓴다) */
function worldOf(mapId) {
  if (!worlds.has(mapId)) {
    const d = mapData(mapId);
    worlds.set(mapId, d ? buildCollision(d).world : null);
  }
  return worlds.get(mapId);
}

/**
 * @param {object} o
 * @param {string} o.url
 * @param {string} o.room
 * @param {string} [o.name]
 * @param {string} [o.map='restarea']   방을 처음 만들 때의 맵
 * @param {number} [o.seed=1]           봇 씨앗
 * @param {object} [o.bot]              createHordeBot 옵션(weaponId·fireMs·reroll …)
 * @param {number} [o.latencyMs=0]      보내고 받을 때 각각 더하는 지연
 * @param {number} [o.version]          join 판(버전 거절 시험용)
 * @param {(view, events, msg) => void} [o.onView]   스냅샷을 풀 때마다(화면 쪽 진행을 붙여 보는 시험용)
 * @param {boolean} [o.think=true]      false면 봇이 움직이지 않는다
 */
export function createHordeFakeClient(o) {
  const { url, room, name = 'bot', map = 'restarea', seed = 1, latencyMs = 0, version = PROTOCOL, onView = null, think = true } = o;
  const ws = new WebSocket(`${url}/room/${room}`);
  const accept = createEventFilter();
  const waiters = new Set();
  const s = {
    id: null, leader: null, map: null, hz: 30, phase: null, lobby: null, stage: 0, view: null, tick: 0, error: null, closeInfo: null,
    bytesIn: 0, msgsIn: 0, firstAt: 0, lastAt: 0, snaps: 0, snapBytes: 0, snapMax: 0, events: 0, resentNew: 0, dup: 0,
    counts: {}, rejects: [], sent: 0, over: null
  };
  let bot = null;
  let resolveReady, rejectReady, resolveClosed;
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
  const closed = new Promise((res) => { resolveClosed = res; });
  ready.catch(() => {});

  const later = (fn) => (latencyMs > 0 ? setTimeout(fn, latencyMs) : fn());
  function sendNow(obj) {
    if (ws.readyState !== WebSocket.OPEN || !obj) return;
    ws.send(JSON.stringify(obj));
    s.sent++;
  }
  const out = (obj) => later(() => sendNow(obj));
  function check() { for (const w of [...waiters]) if (w.pred(s)) { waiters.delete(w); clearTimeout(w.timer); w.resolve(s); } }

  function takeEvents(list, resent) {
    const fresh = [];
    for (const e of Array.isArray(list) ? list : []) {
      if (!accept(e)) { s.dup++; continue; }
      fresh.push(e);
      if (e.type === 'reject') { s.rejects.push(e); continue; }
      s.events++;
      if (resent) s.resentNew++;
      s.counts[e.type] = (s.counts[e.type] || 0) + 1;
      if (e.type === 'over') s.over = e;
      if (e.type === 'leader') s.leader = e.id;
    }
    if (bot && fresh.length) bot.onEvents(fresh);
    return fresh;
  }

  function onMessage(m, bytes) {
    s.bytesIn += bytes;
    s.msgsIn++;
    const now = performance.now();
    if (!s.firstAt) s.firstAt = now;
    s.lastAt = now;
    switch (m.t) {
      case 'welcome':
        s.id = m.playerId; s.leader = m.leader; s.map = m.map; s.hz = m.hz; s.tick = m.tick;
        bot = createHordeBot({ id: s.id, seed, world: worldOf(m.map), ...(o.bot || {}) });
        resolveReady(s);
        break;
      case 'zlobby': s.lobby = m; s.leader = m.leader; s.phase = m.phase; break;
      case 'zev': s.tick = m.tick; takeEvents(m.events, false); break;
      case 'zsnap': {
        s.tick = m.tick;
        s.snaps++; s.snapBytes += bytes; if (bytes > s.snapMax) s.snapMax = bytes;
        const fresh = takeEvents(m.ev, true);
        const view = applyHordeSnapshot(m.s);
        if (!view) break;
        s.view = view;
        s.stage = view.stage;
        s.phase = view.phase === 'over' ? 'over' : 'playing';
        if (onView) onView(view, fresh, m);
        if (think && bot) {
          const { input, actions } = bot.think(view, (m.tick * 1000) / s.hz);
          out(encodeHordeState(input));
          for (const a of actions) out(encodeHordeAction(a));
        }
        break;
      }
      case 'error': s.error = m; break;
      default: break;
    }
    check();
  }

  ws.on('message', (d) => {
    const bytes = d.length;
    let m;
    try { m = JSON.parse(d.toString()); } catch { return; }
    later(() => onMessage(m, bytes));
  });
  ws.on('open', () => out({ t: 'join', v: version, name, opts: { mode: HORDE_MODE, map } }));
  ws.on('close', (code, reason) => {
    s.closeInfo = { code, reason: reason.toString() };
    rejectReady(Object.assign(new Error(`closed ${code} ${s.error ? s.error.code : ''}`), { code, server: s.error }));
    for (const w of [...waiters]) { waiters.delete(w); clearTimeout(w.timer); w.reject(new Error(`${w.label}: 접속이 닫혔다(${code})`)); }
    resolveClosed(s.closeInfo);
  });
  ws.on('error', (err) => rejectReady(err));

  return {
    ready, closed,
    get id() { return s.id; },
    get state() { return s; },
    start: () => out({ t: 'start' }),
    send: (obj) => out(obj),
    waitFor(pred, timeoutMs = 10000, label = 'condition') {
      if (pred(s)) return Promise.resolve(s);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve, reject, label, timer: setTimeout(() => { waiters.delete(w); reject(new Error(`${label} 시간 초과(${timeoutMs} ms, 스테이지 ${s.stage}, ${s.phase})`)); }, timeoutMs) };
        waiters.add(w);
      });
    },
    stats() {
      const sec = s.lastAt > s.firstAt ? (s.lastAt - s.firstAt) / 1000 : 0;
      return {
        id: s.id, stage: s.stage, phase: s.phase, bytesIn: s.bytesIn, msgsIn: s.msgsIn, bytesPerSec: sec ? Math.round(s.bytesIn / sec) : 0,
        snaps: s.snaps, snapAvg: s.snaps ? Math.round(s.snapBytes / s.snaps) : 0, snapMax: s.snapMax, events: s.events, resentNew: s.resentNew, dup: s.dup,
        rejects: s.rejects.length, sent: s.sent, counts: { ...s.counts }
      };
    },
    async close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, 'bye');
      await Promise.race([closed, new Promise((r) => setTimeout(r, 1000))]);
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    }
  };
}
