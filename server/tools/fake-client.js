/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 권위 서버 시험용 가짜 클라이언트. 실제 WebSocket(/room/<id>)으로 붙어 입력만 보내고, 받은 스냅샷을 브라우저와 같은 보간 버퍼(SnapshotBuffer)로 그려
 *          그 화면을 기준으로 겨눈다. 보내고 받는 길에 지연을 넣어 지연 보정(되감기)을 시험한다. node 시험과 tools/bots.js가 함께 쓴다.
 */
/**
 *   const c = createFakeClient({ url: 'ws://127.0.0.1:8787', room: 'demo', name: '봇1', team: 'owner', behavior: 'fight', latencyMs: 40 });
 *   await c.ready;            // welcome
 *   c.start();                // 방장만
 *   const end = await c.matchEnded;
 *   c.stats();                // { shots, hits, kills, deaths, avgRewindTicks, ... }
 *   await c.close();
 *
 * 화면 시각: 마지막 스냅샷 틱 + 받은 뒤 흐른 시간으로 지금 서버 틱을 어림하고, interpMs만큼 뒤를 그린다(브라우저 원격 아바타와 같은 100 ms).
 * 입력에는 그 화면의 틱(viewTick)을 실어 서버가 같은 순간으로 되감게 한다.
 *
 * 행동(behavior)
 *   fight  : 경기 중이면 가장 가까운 적에게 다가가(engageDist까지) 조준한 채 짧게 끊어 쏜다. 반동은 me.rk만큼 되돌려 겨눈다
 *   strafe : 적 쪽을 본 채 strafeTicks마다 좌우로 방향을 바꿔 걷는다(쏘지 않는다)
 *   idle   : 가만히 있는다
 *   manual : 입력을 만들지 않는다. setInput()으로 직접 넣는다
 */
import WebSocket from 'ws';
import { SnapshotBuffer } from '../../js/engine/interp.js';
import { aimAt } from '../core/combat.js';
import { KEY, PRESS, PROTOCOL, decodeRow } from '../core/protocol.js';

export { aimAt };

const EYE = 1.6, CROUCH_EYE = 1.1;

/**
 * @param {object} o
 * @param {string} o.url 서버 주소 ws://호스트:포트 (방 주소는 url + '/room/' + room)
 * @param {string} o.room 방 id(소문자·숫자 1~16자)
 * @param {string} [o.name]
 * @param {'owner'|'charterer'|null} [o.team]
 * @param {object} [o.opts] 방을 만들 때의 { map, mode, ruleset, killTarget }
 * @param {boolean} [o.quickRespawn=false] 개인전에서 죽으면 바로 respawn(E)을 보낸다
 * @param {number} [o.version] join에 싣는 판(기본 PROTOCOL. 버전 거절 시험용)
 * @param {'fight'|'strafe'|'idle'|'manual'} [o.behavior='fight']
 * @param {number} [o.latencyMs=0] 한쪽 지연(보낼 때와 받을 때 각각 더한다)
 * @param {number} [o.jitterMs=0] 지연에 더하는 무작위 폭
 * @param {number} [o.interpMs=100] 원격 보간 지연
 * @param {number} [o.engageDist=9] fight: 이 거리까지 다가간 뒤 멈춰 쏜다
 * @param {number[]} [o.burst=[3, 6]] fight: 방아쇠를 [누르는 틱, 쉬는 틱]씩 번갈아 당긴다
 * @param {number} [o.strafeTicks=30] strafe: 방향을 바꾸는 간격
 * @param {object} [o.wsOptions] ws 클라이언트 옵션(origin, autoPong 등)
 */
export function createFakeClient(o) {
  const {
    url, room, name = 'bot', team = null, opts = undefined, behavior = 'fight', latencyMs = 0, jitterMs = 0,
    interpMs = 100, engageDist = 9, burst = [3, 6], strafeTicks = 30, wsOptions = undefined, quickRespawn = false, version = PROTOCOL
  } = o;
  const [burstOn, burstOff] = burst;
  const ws = new WebSocket(`${url}/room/${room}`, wsOptions);
  const buffers = new Map();     // 다른 사람 id → SnapshotBuffer(서버 시각 ms)
  const waiters = new Set();
  const events = [];
  const s = {
    id: null, team, hz: 30, tickMs: 1000 / 30, phase: null, round: 0, leader: null, me: null, meExtra: null,
    latestTick: -1, latestAt: 0, match: null, error: null, closeInfo: null,
    shots: 0, hits: 0, damage: 0, kills: 0, deaths: 0, rewindSum: 0, rewindN: 0, acked: -1,
    killTarget: null, reward: null, quick: 0, respawnAsked: false, rejects: []
  };
  let seq = 0;
  let manualInput = { keys: 0, press: 0, slot: 0, yaw: 0, pitch: 0, viewTick: undefined };
  let pumpTimer = null, t0 = 0, sentInputs = 0;
  let lastOutAt = 0, lastInAt = 0;
  let fireCycle = 0;
  let resolveReady, rejectReady, resolveEnd, resolveClosed;
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
  const matchEnded = new Promise((res) => { resolveEnd = res; });
  const closed = new Promise((res) => { resolveClosed = res; });
  ready.catch(() => {});

  const delay = () => latencyMs + (jitterMs > 0 ? Math.random() * jitterMs : 0);

  /** 지연을 넣어 보낸다. 앞선 메시지보다 먼저 나가지 않게 시각을 앞 메시지 뒤로 민다 */
  function send(obj) {
    const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
    const d = delay();
    if (d <= 0) { if (ws.readyState === WebSocket.OPEN) ws.send(text); return; }
    const now = performance.now();
    const at = Math.max(lastOutAt, now + d);
    lastOutAt = at;
    setTimeout(() => { if (ws.readyState === WebSocket.OPEN) ws.send(text); }, at - now);
  }

  ws.on('open', () => {
    send({ t: 'join', v: version, name, team, opts });
  });
  ws.on('message', (data) => {
    const text = data.toString('utf8');
    const d = delay();
    if (d <= 0) { onText(text); return; }
    const now = performance.now();
    const at = Math.max(lastInAt, now + d);
    lastInAt = at;
    setTimeout(() => onText(text), at - now);
  });
  ws.on('unexpected-response', (_, res) => {
    s.error = s.error || { code: `http_${res.statusCode}` };
    rejectReady(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
  });
  ws.on('close', (code, reason) => {
    s.closeInfo = { code, reason: reason.toString() };
    stopPump();
    rejectReady(new Error(`closed before welcome: ${code} ${reason}`));
    resolveClosed(s.closeInfo);
    check();
  });
  ws.on('error', (err) => { s.error = s.error || { code: 'socket', message: err.message }; rejectReady(err); });

  function onText(text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    switch (m.t) {
      case 'welcome':
        s.id = m.playerId;
        s.team = m.team;
        s.hz = m.hz;
        s.tickMs = 1000 / m.hz;
        s.leader = m.leader;
        s.killTarget = m.killTarget ?? null;
        startPump();
        resolveReady(m);
        break;
      case 'snap': onSnapshot(m); break;
      case 'events': for (const ev of m.events) onEvent(ev); break;
      case 'match':
        s.match = m.match;
        s.phase = m.match.ph;
        s.leader = m.leader;
        break;
      case 'error': s.error = m; break;
      default: break;
    }
    check();
  }

  function onSnapshot(m) {
    s.latestTick = m.tick;
    s.latestAt = performance.now();
    const seen = new Set();
    for (const raw of m.players) {
      const r = decodeRow(raw);
      seen.add(r.id);
      if (r.id === s.id) { s.me = r; s.acked = r.ack; continue; }
      let buf = buffers.get(r.id);
      if (!buf) { buf = new SnapshotBuffer({ maxSize: 60, maxExtrapolate: 0, keepMs: 3000 }); buffers.set(r.id, buf); }
      buf.push(m.tick * s.tickMs, r);
    }
    for (const id of buffers.keys()) if (!seen.has(id)) buffers.delete(id);
    s.meExtra = m.me;
  }

  function onEvent(ev) {
    events.push(ev);
    switch (ev.type) {
      case 'phase': s.phase = ev.phase; break;
      case 'roundStart': s.round = ev.round; break;
      case 'leader': s.leader = ev.id; break;
      case 'join': case 'team': if (ev.id === s.id) s.team = ev.team; break;
      case 'fire':
        if (ev.id === s.id) { s.shots++; if (Number.isFinite(ev.rw)) { s.rewindSum += ev.rw; s.rewindN++; } }
        break;
      case 'damage':
        if (ev.attacker === s.id && ev.victim !== s.id) { s.hits++; s.damage += ev.amount; }
        break;
      case 'kill':
        if (ev.killer === s.id && ev.victim !== s.id) s.kills++;
        if (ev.victim === s.id) s.deaths++;
        break;
      case 'spawn':
        if (ev.id === s.id) { s.respawnAsked = false; if (ev.instant) s.quick++; }
        break;
      case 'reward': if (ev.id === s.id) s.reward = ev; break;
      case 'reject': s.rejects.push(ev); if (ev.action === 'respawnNow') s.respawnAsked = false; break;
      case 'matchEnd': resolveEnd(ev); break;
      default: break;
    }
  }

  // ── 화면(보간) ────────────────────────────────────────
  /** 지금 그릴 서버 시각(ms). 마지막 스냅샷보다 앞서지 않는다 */
  function renderMs() {
    if (s.latestTick < 0) return null;
    const est = s.latestTick * s.tickMs + (performance.now() - s.latestAt);
    return Math.min(est - interpMs, s.latestTick * s.tickMs);
  }
  /** 지금 화면의 다른 사람들 [{ id, pos, alive, crouch, ... }] */
  function view(at = renderMs()) {
    const out = [];
    if (at == null) return out;
    for (const [id, buf] of buffers) {
      const v = buf.sample(at, {});
      if (v) out.push({ ...v, id, pos: v.pos.slice() });
    }
    return out;
  }
  /** 화면에서 이 사람의 팀(점수판 줄의 팀 칸으로 안다) */
  function teamOf(id) {
    const rows = s.match && Array.isArray(s.match.p) ? s.match.p : [];
    const row = rows.find((r) => r[0] === id);
    return row ? ['owner', 'charterer'][row[2]] || null : null;
  }
  function enemies(list) {
    if (!s.match || s.match.mo === 'ffa') return list;
    return list.filter((v) => { const t = teamOf(v.id); return t && t !== s.team; });
  }

  // ── 입력 ──────────────────────────────────────────────
  function decide() {
    const facing = s.team === 'charterer' ? Math.PI / 2 : -Math.PI / 2;   // 스폰이 보는 쪽(서버 시험장 기준)
    const me = s.me;
    const at = renderMs();
    const viewTick = at == null ? undefined : Math.round((at / s.tickMs) * 100) / 100;
    const base = { keys: 0, press: 0, slot: 0, yaw: me ? me.yaw : facing, pitch: 0, viewTick };
    if (behavior === 'manual') return { ...manualInput, viewTick: manualInput.viewTick === undefined ? viewTick : manualInput.viewTick };
    if (!me || !me.alive || s.phase !== 'live') return base;
    if (behavior === 'idle') return { ...base, yaw: facing };
    if (behavior === 'strafe') {
      const left = Math.floor(sentInputs / strafeTicks) % 2 === 0;
      return { ...base, yaw: facing, keys: left ? KEY.LEFT : KEY.RIGHT };
    }
    // fight
    const list = enemies(view(at)).filter((v) => v.alive);
    if (!list.length) return { ...base, keys: KEY.AIM };
    const eye = [me.pos[0], me.pos[1] + (me.crouch ? CROUCH_EYE : EYE), me.pos[2]];
    let best = null;
    for (const v of list) {
      const d = Math.hypot(v.pos[0] - eye[0], v.pos[2] - eye[2]);
      if (!best || d < best.d) best = { v, d };
    }
    const t = best.v;
    const chest = [t.pos[0], t.pos[1] + (t.crouch ? 0.85 : 1.25), t.pos[2]];
    const a = aimAt(eye, chest);
    const rk = s.meExtra && Array.isArray(s.meExtra.rk) ? s.meExtra.rk : [0, 0];
    let keys = KEY.AIM, press = 0;
    if (a.dist > engageDist) keys |= KEY.FORWARD;
    else {
      // 짧게 끊어 쏜다: 반동이 쌓이기 전에 손을 뗀다
      fireCycle = (fireCycle + 1) % (burstOn + burstOff);
      if (fireCycle < burstOn) { keys |= KEY.FIRE; if (fireCycle === 0) press |= PRESS.FIRE; }
    }
    return { ...base, keys, press, yaw: a.yaw - rk[0] / 1000, pitch: a.pitch - rk[1] / 1000 };
  }

  function sendInput() {
    // 개인전 즉시 부활: 죽어 있으면 한 번만 청한다(출격하거나 거절되면 다시 청할 수 있다)
    if (quickRespawn && s.phase === 'live' && s.me && !s.me.alive && !s.respawnAsked && s.match && s.match.mo === 'ffa') {
      s.respawnAsked = true;
      send({ t: 'respawn' });
    }
    const inp = decide();
    const msg = {
      t: 'input', seq: seq++, keys: inp.keys | 0, press: inp.press | 0, slot: inp.slot | 0,
      yaw: Math.round(inp.yaw * 10000) / 10000, pitch: Math.round(inp.pitch * 10000) / 10000
    };
    if (inp.viewTick !== undefined && inp.viewTick !== null) msg.viewTick = inp.viewTick;
    if (behavior === 'manual') manualInput = { ...manualInput, press: 0, slot: 0 };   // 새로 누름은 한 번만
    sentInputs++;
    send(msg);
  }

  /** 1/hz초마다 입력 하나. 타이머가 늦게 깨면 밀린 만큼(최대 4개) 몰아서 보낸다 */
  function startPump() {
    if (pumpTimer) return;
    t0 = performance.now();
    sentInputs = 0;
    pumpTimer = setInterval(() => {
      const due = Math.floor(((performance.now() - t0) * s.hz) / 1000) + 1;
      let n = 0;
      while (sentInputs < due && n < 4) { sendInput(); n++; }
      if (sentInputs < due) sentInputs = due;   // 너무 밀렸으면 버린다(서버가 마지막 입력을 되풀이한다)
    }, Math.max(4, Math.floor(1000 / s.hz / 2)));
  }
  function stopPump() {
    if (pumpTimer) clearInterval(pumpTimer);
    pumpTimer = null;
  }

  // ── 기다리기 ──────────────────────────────────────────
  function check() {
    for (const w of [...waiters]) {
      let ok = false;
      try { ok = w.pred(api); } catch (err) { waiters.delete(w); clearTimeout(w.timer); w.reject(err); continue; }
      if (ok) { waiters.delete(w); clearTimeout(w.timer); w.resolve(ok); }
    }
  }
  /** pred(client)가 참이 될 때까지(메시지를 받을 때마다 본다) */
  function waitFor(pred, timeoutMs = 10000, label = 'condition') {
    let ok = false;
    try { ok = pred(api); } catch (err) { return Promise.reject(err); }
    if (ok) return Promise.resolve(ok);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, reject, timer: null };
      w.timer = setTimeout(() => {
        waiters.delete(w);
        reject(new Error(`${name}: ${label} 시간 초과(${timeoutMs} ms, phase=${s.phase}, round=${s.round}, close=${JSON.stringify(s.closeInfo)})`));
      }, timeoutMs);
      waiters.add(w);
    });
  }

  const api = {
    ws,
    ready,
    matchEnded,
    closed,
    events,
    get id() { return s.id; },
    get team() { return s.team; },
    get phase() { return s.phase; },
    get round() { return s.round; },
    get leader() { return s.leader; },
    get me() { return s.me; },
    get meExtra() { return s.meExtra; },
    get match() { return s.match; },
    get latestTick() { return s.latestTick; },
    get error() { return s.error; },
    get closeInfo() { return s.closeInfo; },
    get acked() { return s.acked; },
    get killTarget() { return s.killTarget; },
    get reward() { return s.reward; },
    get quick() { return s.quick; },
    get rejects() { return s.rejects; },
    get sentInputs() { return seq; },
    get tickMs() { return s.tickMs; },
    view,
    renderTick: () => { const at = renderMs(); return at == null ? null : at / s.tickMs; },
    start: () => send({ t: 'start' }),
    pick: (weapon) => send({ t: 'pick', weapon }),
    respawn: () => send({ t: 'respawn' }),
    setTeam: (t) => send({ t: 'team', team: t }),
    /** 원시 메시지(시험용). 지연 길을 그대로 탄다 */
    sendRaw: (text) => send(text),
    /** manual 행동의 다음 입력. press·slot은 한 번 보내면 지운다 */
    setInput: (inp) => { manualInput = { ...manualInput, ...inp }; },
    stopInputs: stopPump,
    waitFor,
    stats: () => ({
      id: s.id, team: s.team, shots: s.shots, hits: s.hits, damage: s.damage, kills: s.kills, deaths: s.deaths,
      hitRatio: s.shots ? s.hits / s.shots : 0, avgRewindTicks: s.rewindN ? s.rewindSum / s.rewindN : 0, inputs: seq, acked: s.acked
    }),
    async close() {
      stopPump();
      for (const w of waiters) { clearTimeout(w.timer); }
      waiters.clear();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'bye');
        await Promise.race([closed, new Promise((r) => setTimeout(r, 1000))]);
        if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      }
    }
  };
  return api;
}
