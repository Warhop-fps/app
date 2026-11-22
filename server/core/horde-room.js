/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 게임 서버의 좀비 물량 막기 방. 화면 없는 좀비 방(js/game/horde/sim/room.js)을 서버가 고른 씨앗으로 만들어 틱마다 한 칸씩 돌리고,
 *          손님 메시지(zs·zhit·zswing·zboom·zcard·zloot·zrev·start)를 그 방의 input·send로 옮기고, 이벤트는 그 틱에·스냅샷은 10 Hz로 보낸다.
 *          꼭 닿아야 하는 이벤트(증강·스테이지·보스·쓰러짐·끝)는 번호(eid)를 붙여 3초 동안 스냅샷에 다시 싣는다. 거절은 보낸 사람에게만 간다.
 *          core/room.js(개인전·팀전)와 같은 모양(join·leave·input·tick·dispose·size·stats)이라 Node 어댑터가 모드만 보고 골라 만든다.
 */
/**
 *   const room = createHordeServerRoom({ send, id: 'abc', map: 'restarea', seed: () => 1234, onMatchEnd: (summary) => ... });
 *   room.join(pid, { name });   room.input(pid, msg);   room.tick();   room.leave(pid);
 *
 * 흐름: 대기실(lobby) → 방장(먼저 들어온 사람)의 start → 판(playing, 준비 12초 → 스테이지) → 끝(over) → 방장의 start로 새 씨앗의 새 판.
 * 판 도중에 들어온 사람은 다음 스테이지에 나온다(director.addPlayer). 나간 사람은 판에서 빠진다(다시 들어오면 새 사람이다: 신원은 접속마다 서버가 정한다).
 *
 * 판이 끝나면 onMatchEnd(summary)를 한 번 부른다(아래 matchSummary 모양). 결과 서명·저장은 이 파일이 하지 않는다(docs/HORDE_SERVER.md 8절).
 *
 * 손님이 정하는 값(위치·맞힘·폭발 피해)은 지금도 손님 몫이다(docs/HORDE_SERVER.md 2절). 서버는 위치가 초당 maxSpeed m보다 빨리 움직이면 거기까지만 받는다.
 */
import { isZombieMap } from '../../js/maps/collision.js';
import { MAP_IDS } from '../../js/maps/index.js';
import { createHordeRoom } from '../../js/game/horde/sim/room.js';
import { HORDE } from '../../js/game/horde/rules.js';
import { hordeSummary } from '../../js/game/horde/wire.js';
import { HORDE_EVENT_TTL_MS, HORDE_MODE, HORDE_SNAP_HZ, isReliableEvent } from '../../js/net/hordeproto.js';
import { mapData } from './maps.js';
import { PROTOCOL } from './protocol.js';

/** 좀비 방을 만들 수 있는 맵(modes가 ['zombie']이고 좀비 문이 있다) */
export const ZOMBIE_MAP_IDS = Object.freeze(MAP_IDS.filter((id) => isZombieMap(mapData(id))));

/** 고른 맵이 좀비 맵이면 그대로, 아니면 첫 좀비 맵 */
export function zombieMapId(requested) {
  return ZOMBIE_MAP_IDS.includes(requested) ? requested : ZOMBIE_MAP_IDS[0] || null;
}

const hyp2 = (x, z) => Math.sqrt(x * x + z * z);
const POS_SLACK_M = 1.5;   // 위치 속도 검사의 여유(지연·밀려남)

/**
 * @param {object} o
 * @param {(playerId:string, text:string) => void} o.send
 * @param {string} [o.id='room']
 * @param {string} [o.map]          좀비 맵 id(아니면 첫 좀비 맵)
 * @param {number} [o.hz=30]        서버 틱. 시뮬레이션은 30 Hz 고정이라 틱 길이를 모아 한 칸씩 돈다
 * @param {number} [o.roomSize=4]   정원(HORDE.maxPlayers보다 크게 줄 수 없다)
 * @param {object} [o.rules]        HORDE 덮어쓰기(시험·측정용. 손님은 고를 수 없다)
 * @param {number} [o.startStage]   시작 스테이지(시험·측정용)
 * @param {number|(() => number)} [o.seed]  판마다 씨앗(0이 아닌 정수). 함수면 판마다 부른다. 없으면 crypto 없이 시각에서
 * @param {number} [o.snapHz=10]    스냅샷 주기
 * @param {number} [o.ttlMs=3000]   꼭 닿아야 하는 이벤트를 다시 싣는 시간
 * @param {number} [o.maxSpeed=12]  위치 속도 상한(m/s)
 * @param {number} [o.inboxMax=512]
 * @param {(summary:object) => void} [o.onMatchEnd]   판 끝(결과 서명·저장 자리)
 * @param {object} [o.log]
 * @param {() => void} [o.onEmpty]
 */
export function createHordeServerRoom(o) {
  const {
    send, id = 'room', hz = 30, rules = undefined, startStage = undefined, snapHz = HORDE_SNAP_HZ, ttlMs = HORDE_EVENT_TTL_MS,
    maxSpeed = 12, inboxMax = 512, onMatchEnd = null, log = null, onEmpty = null
  } = o;
  if (typeof send !== 'function') throw new TypeError('createHordeServerRoom: send(playerId, text)가 필요하다');
  const mapId = zombieMapId(o.map);
  const data = mapId ? mapData(mapId) : null;
  if (!data) throw new Error('zombie map not found');
  const maxPlayers = { ...HORDE, ...(rules || {}) }.maxPlayers;
  const roomSize = Math.max(1, Math.min(maxPlayers, o.roomSize || maxPlayers));
  const tickMs = 1000 / hz;
  const snapEvery = Math.max(1, Math.round(hz / snapHz));
  const ttlTicks = Math.round((ttlMs / 1000) * hz);
  let seedState = (Date.now() ^ 0x9e3779b9) >>> 0;
  const nextSeed = () => {
    const v = typeof o.seed === 'function' ? o.seed() : o.seed;
    if (Number.isFinite(v) && (v >>> 0)) return v >>> 0;
    seedState = (Math.imul(seedState, 1664525) + 1013904223) >>> 0;
    return seedState || 1;
  };

  const members = new Map();   // pid → { name, last: { x, z, tick } | null } 들어온 순서
  const inbox = [];
  const counters = { matches: 0, steps: 0, events: 0, resent: 0, snapshots: 0, snapBytes: 0, rejects: 0, clamped: 0, inboxDropped: 0, ignored: 0 };
  let leader = null;
  let phase = 'lobby';          // lobby | playing | over
  let hr = null;                // 화면 없는 좀비 방(판 하나)
  let seed = 0;
  let tickNo = 0;
  let acc = 0;
  let eid = 0;
  let out = [];                 // 이번 틱에 모두에게 보낼 이벤트
  let recent = [];              // [{ tick, e }] 다시 실을 이벤트
  const directOut = new Map();
  let lobbyDirty = true;
  let ended = false;
  let disposed = false;

  // ── 보내기 ────────────────────────────────────────────
  function broadcast(text) { for (const pid of members.keys()) send(pid, text); }
  function direct(pid, ev) {
    if (!members.has(pid)) return;
    const list = directOut.get(pid) || [];
    list.push(ev);
    directOut.set(pid, list);
  }
  function welcome(pid) {
    return JSON.stringify({
      t: 'welcome', v: PROTOCOL, playerId: pid, team: 'owner', room: id, hz, tick: tickNo, map: mapId, mode: HORDE_MODE, leader,
      zombie: { snapHz: hz / snapEvery, maxPlayers: roomSize, ttlMs, phase }
    });
  }
  function sendLobby() {
    lobbyDirty = false;
    if (!members.size) return;
    broadcast(JSON.stringify({ t: 'zlobby', tick: tickNo, phase, leader, players: [...members].map(([pid, m]) => ({ id: pid, name: m.name })) }));
  }
  function sendSnapshot() {
    if (!hr || !members.size) return;
    const keep = tickNo - ttlTicks;
    if (recent.length && recent[0].tick < keep) recent = recent.filter((r) => r.tick >= keep);
    const ev = recent.map((r) => r.e);
    counters.resent += ev.length;
    const text = `{"t":"zsnap","tick":${tickNo},"s":${JSON.stringify(hr.snapshot())},"ev":${JSON.stringify(ev)}}`;
    counters.snapshots++;
    counters.snapBytes += text.length;
    broadcast(text);
  }
  function flush() {
    if (out.length) {
      broadcast(JSON.stringify({ t: 'zev', tick: tickNo, events: out }));
      out = [];
    }
    for (const [pid, list] of directOut) if (members.has(pid)) send(pid, JSON.stringify({ t: 'zev', tick: tickNo, events: list }));
    directOut.clear();
  }

  // ── 이벤트 ────────────────────────────────────────────
  /** 시뮬레이션 이벤트 → 번호를 붙여 보낼 목록에. 거절은 보낸 사람(by)에게만 */
  function emit(events) {
    for (const e of events || []) {
      if (!e) continue;
      if (e.type === 'reject') {
        counters.rejects++;
        const by = e.by != null ? String(e.by) : null;
        if (by) direct(by, e);
        else if (log) log.debug({ room: id, reason: e.reason }, 'horde rejected');
        continue;
      }
      const ev = { ...e, eid: ++eid };
      counters.events++;
      out.push(ev);
      if (isReliableEvent(ev)) recent.push({ tick: tickNo, e: ev });
      // 부활·살아남: 서버가 정한 자리로 옮겨지는 것은 정상이라 위치 속도 검사를 처음부터
      if (ev.type === 'spawn' && ev.spawn) { const m = members.get(String(ev.id)); if (m) m.last = null; }
      if (ev.type === 'over') finish();
    }
  }

  /** 판 끝 요약(onMatchEnd에 넘긴다). 사람마다 hordeSummary(결과 화면·계정 기록과 같은 모양) */
  function matchSummary() {
    const view = hr.view();
    const over = view.over || {};
    return {
      mode: HORDE_MODE, roomId: id, map: mapId, seed, match: counters.matches, firstStage: view.firstStage,
      stage: over.stage ?? view.stage, cleared: over.cleared ?? 0, ms: over.ms ?? view.elapsedMs, reason: over.reason || null,
      players: view.players.map((p) => ({ id: p.id, name: p.name, connected: p.connected, ...hordeSummary(view, p.id) }))
    };
  }
  function finish() {
    if (ended) return;
    ended = true;
    phase = 'over';
    lobbyDirty = true;
    let summary = null;
    try { summary = matchSummary(); } catch (err) { if (log) log.error({ err, room: id }, 'horde summary failed'); }
    if (log) log.info({ room: id, seed, stage: summary && summary.stage, reason: summary && summary.reason }, 'horde match ended');
    if (summary && typeof onMatchEnd === 'function') {
      try { onMatchEnd(summary); } catch (err) { if (log) log.error({ err, room: id }, 'onMatchEnd failed'); }
    }
  }

  function begin() {
    if (hr) { try { hr.dispose(); } catch { /* 이미 닫힘 */ } }
    seed = nextSeed();
    const players = [...members].slice(0, roomSize).map(([pid, m]) => ({ id: pid, name: m.name }));
    hr = createHordeRoom({ map: data, players, seed, rules, startStage });
    counters.matches++;
    ended = false;
    acc = 0;
    recent = [];
    for (const m of members.values()) m.last = null;
    phase = 'playing';
    lobbyDirty = true;
    if (log) log.info({ room: id, map: mapId, seed, players: players.length }, 'horde match started');
    emit(hr.start());
  }

  // ── 손님 메시지 ───────────────────────────────────────
  /** 위치: 지난번 받은 자리에서 maxSpeed보다 빨리 움직였으면 그 방향으로 거기까지만 */
  function guardPos(m, s) {
    const last = m.last;
    let x = s.x, z = s.z;
    if (last) {
      const dt = Math.max(tickMs, (tickNo - last.tick) * tickMs) / 1000;
      const lim = maxSpeed * dt + POS_SLACK_M;
      const dx = x - last.x, dz = z - last.z, d = hyp2(dx, dz);
      if (d > lim) { x = last.x + (dx / d) * lim; z = last.z + (dz / d) * lim; counters.clamped++; }
    }
    m.last = { x, z, tick: tickNo };
    return { ...s, x, z };
  }

  function handle(pid, msg) {
    const m = members.get(pid);
    if (!m) return;
    if (msg.t === 'start') {
      if (pid !== leader) { direct(pid, { type: 'reject', action: 'start', reason: 'not_leader', by: pid }); return; }
      if (phase === 'playing') { direct(pid, { type: 'reject', action: 'start', reason: 'playing', by: pid }); return; }
      begin();
      return;
    }
    if (!hr || phase !== 'playing') { counters.ignored++; return; }
    switch (msg.t) {
      case 'zs':
        if (msg.alive === false) hr.input(pid, { alive: false });
        else hr.input(pid, guardPos(m, msg));
        break;
      case 'zhit': hr.send(pid, { t: 'hit', victimId: msg.victimId, weaponId: msg.weaponId, part: msg.part, dist: msg.dist, kind: msg.kind, count: msg.count, shotId: msg.shotId }); break;
      case 'zswing': hr.send(pid, { t: 'swing', weaponId: msg.weaponId, kind: msg.kind, shotId: msg.shotId }); break;
      case 'zboom': hr.send(pid, { t: 'explode', center: msg.center, victims: msg.victims, kind: msg.kind }); break;
      case 'zcard': hr.send(pid, msg.act === 'reroll' ? { t: 'reroll' } : { t: 'pick', cardId: msg.card }); break;
      case 'zloot': hr.send(pid, { t: 'loot', lootId: msg.id }); break;
      case 'zrev': hr.send(pid, { t: 'revive', targetId: msg.id, on: msg.on }); break;
      default: counters.ignored++; break;   // 개인전·팀전 형식(input·pick·team·respawn)은 이 방에서 쓰지 않는다
    }
  }

  // ── 공개 API ──────────────────────────────────────────
  function join(pid, { name } = {}) {
    if (disposed) return { ok: false, code: 'room_closed' };
    if (typeof pid !== 'string' || !pid) return { ok: false, code: 'bad_id' };
    if (members.has(pid)) return { ok: false, code: 'duplicate_id' };
    if (members.size >= roomSize) return { ok: false, code: 'room_full' };
    const nm = (typeof name === 'string' && name) || `손님${members.size + 1}`;   // i18n-ok: 이름이 빈 손님의 기본 이름(브라우저 방과 같은 꼴)
    members.set(pid, { name: nm, last: null });
    if (!leader) leader = pid;
    send(pid, welcome(pid));
    if (hr && phase !== 'lobby') emit(hr.addPlayer({ id: pid, name: nm }));
    lobbyDirty = true;
    if (log) log.info({ room: id, player: pid, players: members.size, phase }, 'player joined');
    return { ok: true, team: 'owner' };
  }

  function leave(pid, reason = 'left') {
    if (!members.has(pid)) return false;
    members.delete(pid);
    directOut.delete(pid);
    if (hr) emit(hr.removePlayer(pid));
    if (leader === pid) {
      leader = members.size ? members.keys().next().value : null;
      if (leader) out.push({ type: 'leader', id: leader, eid: ++eid });
    }
    lobbyDirty = true;
    if (log) log.info({ room: id, player: pid, reason, players: members.size }, 'player left');
    if (!members.size && onEmpty) onEmpty();
    return true;
  }

  function input(pid, msg) {
    if (disposed || !msg || !members.has(pid)) return;
    inbox.push([pid, msg]);
    while (inbox.length > inboxMax) { inbox.shift(); counters.inboxDropped++; }
  }

  function tick() {
    if (disposed) return;
    tickNo += 1;
    if (inbox.length) for (const [pid, msg] of inbox.splice(0)) handle(pid, msg);
    if (hr && phase === 'playing') {
      acc += tickMs;
      let n = 0;
      while (acc >= hr.stepMs - 1e-9 && n < 4) { acc -= hr.stepMs; n++; counters.steps++; emit(hr.step()); }
      if (acc > hr.stepMs) acc = 0;   // 밀린 만큼 따라잡지 않는다(한 틱에 4칸까지)
    }
    // 이벤트를 먼저 보내고 스냅샷을 보낸다(끊기지 않으면 다시 실은 이벤트는 손님이 이미 받은 것이다)
    flush();
    // 판 중에는 10 Hz, 끝난 뒤에는 1 Hz(결과 화면이 읽는 over를 늦게 들어온 사람도 받게)
    if (hr && (phase === 'playing' ? tickNo % snapEvery === 0 : tickNo % hz === 0)) sendSnapshot();
    if (lobbyDirty) sendLobby();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    members.clear();
    inbox.length = 0;
    if (hr) { try { hr.dispose(); } catch { /* 이미 닫힘 */ } hr = null; }
  }

  return {
    id, map: mapId, mode: HORDE_MODE, ruleset: 'classic',
    join, leave, input, tick, dispose,
    get size() { return members.size; },
    get currentTick() { return tickNo; },
    get phase() { return phase; },
    get leader() { return leader; },
    get seed() { return seed; },
    get stage() { return hr ? hr.stage : 0; },
    get horde() { return hr; },
    playerIds: () => [...members.keys()],
    stats() {
      return {
        id, map: mapId, mode: HORDE_MODE, tick: tickNo, phase, players: members.size, stage: hr ? hr.stage : 0, seed, ...counters,
        snapBytesAvg: counters.snapshots ? Math.round(counters.snapBytes / counters.snapshots) : 0
      };
    }
  };
}
