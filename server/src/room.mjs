/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 권위 서버의 방 하나. 경기 규칙(createMatch)·물리 월드·사람(actor)·수류탄을 들고 고정 틱(기본 30 Hz)으로 돈다.
 *          틱마다 입력을 하나씩 처리하고, 사격은 쏜 사람이 본 틱으로 되감아 판정한 뒤 스냅샷·이벤트를 보낸다. 소켓을 모르는 객체라 node 테스트에서 직접 돌린다.
 */
/**
 *   const room = createRoom({ id: 'abc', map: 'arena', mode: 'team', ruleset: 'classic' });
 *   const r = room.join({ name, team, peer });   // peer = { send(text), rtt?() } → { ok, id } | { ok:false, code }
 *   room.handle(r.id, msg);                      // protocol.decodeClient로 검사한 in·pick·team·start
 *   room.step();                                 // 틱 하나(서버 루프가 1/hz초마다 부른다)
 *   room.leave(r.id);
 *
 * 틱 순서
 *   1. 사람마다 입력 하나 → 이동·무기(사격은 그 자리에서 되감아 판정해 match.claimHit). 처리 순서는 틱마다 한 칸씩 돈다
 *   2. 수류탄 → 폭발은 지금 자리로 피해 계산해 match.claimExplosion
 *   3. match.tick(경기 시계) → 라운드 시작·끝 이벤트를 사람에게 적용(스폰·얼림·로드아웃)
 *   4. 이 틱의 자리를 지연 보정 기록에 남긴다(기록 k = 스냅샷 k)
 *   5. 스냅샷(틱마다) · 이벤트(있으면) · 점수판(이벤트가 있었거나 0.5초마다)
 * 틱 밖에서 생긴 일(입장·퇴장·무기 선택)의 이벤트도 다음 틱 끝에 함께 나간다.
 */
import { PLAYER } from '../../js/core/consts.js';
import { createMatch } from '../../js/game/match.js';
import { normalizeRuleset, shotTargets } from '../../js/game/modes.js';
import { getDef } from '../../js/weapons/defs.js';
import { createGrenadeSystem } from '../../js/weapons/grenade.js';
import { createActor } from './actor.mjs';
import { meleeTrace, resolveShot } from './combat.mjs';
import { createHistory, rewindTarget } from './lagcomp.mjs';
import { loadMap } from './maps.mjs';
import { PROTOCOL, ROW } from './protocol.mjs';

const round2 = (v) => Math.round(v * 100) / 100;
const r2 = (v) => [round2(v[0]), round2(v[1]), round2(v[2])];

/**
 * @param {object} o
 * @param {string} o.id 방 id
 * @param {string} [o.map='arena'] maps.MAP_CHOICES 중 하나
 * @param {'team'|'ffa'} [o.mode='team']
 * @param {string} [o.ruleset='classic']
 * @param {number} [o.hz=30] 서버 틱
 * @param {number} [o.substeps=2] 입력 하나를 나눠 돌리는 이동 횟수(1/60초 이동)
 * @param {number} [o.roomSize=6] 정원
 * @param {number} [o.maxRewindMs=300] 되감기 상한
 * @param {number} [o.historyTicks=64] 지연 보정 기록 길이
 * @param {number} [o.snapshotEvery=1] 스냅샷 간격(틱)
 * @param {number} [o.matchEvery=15] 점수판 간격(틱)
 * @param {object} [o.rules] createMatch 규칙 덮어쓰기(시험·데모의 짧은 라운드 등)
 * @param {() => number} [o.rng] 탄퍼짐·스폰 섞기 난수
 * @param {object} [o.log] log.mjs 로거
 * @param {() => void} [o.onEmpty] 마지막 사람이 나갔을 때
 */
export function createRoom(o) {
  const {
    id, map = 'arena', mode = 'team', ruleset = 'classic', hz = 30, substeps = 2, roomSize = 6,
    maxRewindMs = 300, historyTicks = 64, snapshotEvery = 1, matchEvery = 15, rules = {},
    rng = Math.random, log = null, onEmpty = null
  } = o;
  const built = loadMap(map);
  if (!built) throw new Error(`unknown map: ${map}`);
  const rs = normalizeRuleset(ruleset);
  const ffa = mode === 'ffa';
  const tickMs = 1000 / hz;
  const tickDt = 1 / hz;
  const maxRewindTicks = (Math.max(0, maxRewindMs) / 1000) * hz;
  const matchRules = { ...rules, mode, ruleset: rs, maxPlayers: roomSize, maxPerTeam: Math.ceil(roomSize / 2) };
  const ffaSpots = [...built.spawns.owner, ...built.spawns.charterer, ...(built.spawns.ffa || [])];

  const actors = new Map();   // 입장 순서
  const peers = new Map();
  const history = createHistory({ size: historyTicks });
  const nades = createGrenadeSystem({ world: built.world });
  const counters = { shots: 0, hits: 0, rewinds: 0, rewindTicks: 0, clamped: 0, explosions: 0 };
  let match = newMatch();
  let phase = 'warmup';
  let tick = 0;
  let seq = 0;
  let nadeSeq = 0;
  let leader = null;
  let outEvents = [];
  const directOut = new Map();
  let matchDirty = true;
  let disposed = false;

  function newMatch() {
    return createMatch({ rules: matchRules, spawns: built.spawns, rng, getPositions: ffa ? positions : undefined });
  }
  function positions() {
    const out = {};
    for (const a of actors.values()) if (a.alive) out[a.id] = a.state.pos.slice();
    return out;
  }

  // ── 보내기 ────────────────────────────────────────────
  function broadcast(text) {
    for (const peer of peers.values()) peer.send(text);
  }
  function direct(pid, ev) {
    if (!peers.has(pid)) return;
    const list = directOut.get(pid) || [];
    list.push(ev);
    directOut.set(pid, list);
  }
  function welcome(pid, team) {
    return JSON.stringify({ t: 'welcome', v: PROTOCOL, id: pid, team, room: id, hz, tick, map: built.id, mode, ruleset: rs, leader, maxRewindMs, row: ROW });
  }
  function sendSnapshots() {
    if (!peers.size) return;
    const rows = [];
    for (const a of actors.values()) rows.push(a.row());
    // 모두에게 같은 앞부분은 한 번만 직렬화하고, 받는 사람만의 me만 덧붙인다
    const head = `{"t":"s","k":${tick},"p":${JSON.stringify(rows)},"me":`;
    for (const [pid, peer] of peers) {
      const a = actors.get(pid);
      if (a) peer.send(head + JSON.stringify(a.me()) + '}');
    }
  }
  function flush() {
    if (outEvents.length) {
      broadcast(JSON.stringify({ t: 'e', k: tick, e: outEvents }));
      outEvents = [];
    }
    for (const [pid, list] of directOut) {
      const peer = peers.get(pid);
      if (peer) peer.send(JSON.stringify({ t: 'e', k: tick, e: list }));
    }
    directOut.clear();
  }
  function sendMatch() {
    matchDirty = false;
    if (!peers.size) return;
    const ping = {};
    for (const [pid, peer] of peers) {
      const v = typeof peer.rtt === 'function' ? peer.rtt() : null;
      ping[pid] = Number.isFinite(v) ? Math.round(v) : null;
    }
    broadcast(JSON.stringify({ t: 'm', k: tick, m: match.snapshot(), leader, ping }));
  }

  // ── 경기 이벤트 적용 ──────────────────────────────────
  /**
   * match가 돌려준 이벤트를 사람에게 적용하고 보낼 목록에 넣는다.
   * reject는 요청한 사람(requester)에게만 보낸다. 서버가 스스로 낸 히트 주장의 reject(대기실 사격 등)는 보내지 않는다.
   */
  function absorb(events, requester) {
    if (!events || !events.length) return;
    for (const ev of events) {
      if (ev.type === 'reject') {
        if (requester && ev.by === requester) direct(requester, ev);
        else if (log) log.debug({ room: id, action: ev.action, reason: ev.reason, by: ev.by }, 'match rejected');
        continue;
      }
      apply(ev);
      outEvents.push(ev);
      matchDirty = true;
    }
  }

  function spawnWarmup(a) {
    const pool = ffa || !a.team ? ffaSpots : built.spawns[a.team];
    let i = 0;
    for (const b of actors.values()) { if (b === a) break; if (ffa || b.team === a.team) i++; }
    if (pool && pool.length) a.spawn(pool[i % pool.length]);
  }

  function apply(ev) {
    switch (ev.type) {
      case 'join': {
        const a = actors.get(ev.id);
        if (a && ev.playing && phase === 'warmup') spawnWarmup(a);
        break;
      }
      case 'team': {
        const a = actors.get(ev.id);
        if (a) { a.setTeam(ev.team); if (phase === 'warmup') spawnWarmup(a); }
        break;
      }
      case 'roundStart':
        nades.clear();
        for (const a of actors.values()) {
          const sp = ev.spawns && ev.spawns[a.id];
          if (sp) a.spawn(sp); else a.despawn();
        }
        break;
      case 'phase':
        phase = ev.phase;
        if (ev.phase === 'live' && ev.loadouts) {
          for (const [pid, w] of Object.entries(ev.loadouts)) { const a = actors.get(pid); if (a) a.setPick(w, true); }
        }
        break;
      case 'loadout': {
        const a = actors.get(ev.id);
        if (a) a.setPick(ev.weaponId, phase === 'loadout');   // 개인전 경기 중 선택은 다음 부활부터
        break;
      }
      case 'damage': { const a = actors.get(ev.victim); if (a) a.setHp(ev.hp); break; }
      case 'kill': { const a = actors.get(ev.victim); if (a) a.kill(); break; }
      case 'spawn': { const a = actors.get(ev.id); if (a) a.spawn(ev.spawn, ev.loadout); break; }
      default: break;
    }
  }

  // ── 판정 ──────────────────────────────────────────────
  /**
   * 쏜 사람 a가 vt 틱에 본 다른 사람들의 자리. 지금도 살아 있어야 대상이 된다(그 사이에 죽었으면 맞힐 수 없다).
   * 팀전에서는 아군을 뺀다(총알이 아군 몸을 통과한다, modes.shotTargets).
   */
  function rewound(a, vt) {
    const range = history.range();
    if (!range) return { list: [], rewind: 0 };
    const rt = rewindTarget(vt, { now: tick, maxTicks: maxRewindTicks, oldest: range.oldest, newest: range.newest });
    counters.rewinds++;
    counters.rewindTicks += rt.rewind;
    if (rt.clamped) counters.clamped++;
    const list = [];
    for (const row of history.sample(rt.tick) || []) {
      if (row.id === a.id || !row.alive) continue;
      const t = actors.get(row.id);
      if (!t || !t.alive) continue;
      list.push({ id: row.id, team: row.team, pos: [row.x, row.y, row.z], yaw: row.yaw, crouch: row.crouch, alive: true });
    }
    return { list: shotTargets(list, ffa ? 'ffa' : 'team', a.team), rewind: rt.rewind };
  }

  function fire(a, ev, inp) {
    const { list, rewind } = rewound(a, inp.vt);
    const def = getDef(ev.weaponId);
    const range = Number.isFinite(ev.maxRange) ? ev.maxRange : def ? def.maxRange : 300;
    const eye = a.eye();
    const { victims, shown } = resolveShot(built.world, eye, a.state.yaw, a.state.pitch, ev, list, range);
    const shotId = a.nextShotId();
    counters.shots++;
    outEvents.push({ type: 'fire', id: a.id, w: ev.weaponId, o: r2(eye), h: r2(shown.point), hk: shown.kind, rw: round2(rewind) });
    for (const v of victims) {
      const evs = match.claimHit({
        attackerId: a.id, victimId: v.id, weaponId: ev.weaponId, part: v.part, dist: v.dist, kind: 'shot', t: ev.t, count: v.count, shotId
      });
      if (evs.some((e) => e.type === 'damage')) counters.hits++;
      absorb(evs);
    }
  }

  function melee(a, ev, inp) {
    const { list } = rewound(a, inp.vt);
    const hit = meleeTrace(built.world, a.eye(), a.aimDir(), ev.range, ev.arc, list, a.id);
    if (!hit) return;
    absorb(match.claimHit({
      attackerId: a.id, victimId: hit.id, part: hit.part, weaponId: ev.weaponId, dist: hit.dist,
      kind: ev.kind === 'stab' ? 'stab' : 'slash', t: ev.t, count: 1, shotId: a.nextShotId()
    }));
  }

  function throwNade(a, ev) {
    const gid = `${a.id}#${++nadeSeq}`;
    const g = nades.throwFrom({
      eye: a.eye(), forward: a.aimDir(), speed: ev.speed, pitchUp: ev.pitchUp, fuse: ev.fuse,
      owner: a.id, inherit: a.state.vel, inheritScale: 0.5, id: gid
    });
    outEvents.push({ type: 'nade', id: a.id, gid, pos: r2(g.pos), vel: r2(g.vel), fuse: g.fuse });
  }

  /** 수류탄은 서버가 직접 굴리는 물체라 되감지 않고 지금 자리로 피해를 계산한다 */
  function explode(ge) {
    const targets = [];
    for (const a of actors.values()) {
      if (a.alive) targets.push({ id: a.id, pos: a.state.pos, height: a.state.crouch ? PLAYER.CROUCH_HEIGHT : PLAYER.HEIGHT });
    }
    const victims = [];
    for (const r of nades.explosionDamage(ge.pos, targets)) if (r.damage > 0) victims.push({ id: r.id, dmg: r.damage, dist: round2(r.dist) });
    counters.explosions++;
    outEvents.push({ type: 'boom', gid: ge.id, id: ge.owner, pos: r2(ge.pos) });
    absorb(match.claimExplosion({ attackerId: ge.owner, weaponId: 'gr_frag', center: r2(ge.pos), victims }));
  }

  function onWeapon(a, ev, inp) {
    switch (ev.type) {
      case 'fire': fire(a, ev, inp); break;
      case 'melee': melee(a, ev, inp); break;
      case 'throw': throwNade(a, ev); break;
      case 'swing': outEvents.push({ type: 'swing', id: a.id, w: ev.weaponId, kind: ev.kind }); break;
      default: break;
    }
  }

  // ── 공개 API ──────────────────────────────────────────
  function join({ name, team = null, peer = null } = {}) {
    if (disposed) return { ok: false, code: 'room_closed' };
    if (actors.size >= roomSize) return { ok: false, code: 'room_full' };
    const pid = `p${++seq}`;
    const evs = match.addPlayer({ id: pid, name, team });
    const first = evs[0];
    if (!first || first.type === 'reject') return { ok: false, code: (first && first.reason) || 'join_failed' };
    const actor = createActor({ id: pid, name: first.name, team: first.team, world: built.world, ruleset: rs, rng, substeps, tickDt, hp: match.rules.hp });
    actors.set(pid, actor);
    if (peer) peers.set(pid, peer);
    if (!leader) leader = pid;
    if (peer) peer.send(welcome(pid, first.team));
    absorb(evs);
    if (log) log.info({ room: id, player: pid, name: first.name, team: first.team, players: actors.size }, 'player joined');
    return { ok: true, id: pid, team: first.team };
  }

  function leave(pid, reason = 'left') {
    const a = actors.get(pid);
    if (!a) return false;
    actors.delete(pid);
    peers.delete(pid);
    directOut.delete(pid);
    a.dispose();
    absorb(match.removePlayer(pid));
    if (leader === pid) {
      leader = actors.size ? actors.keys().next().value : null;
      if (leader) outEvents.push({ type: 'leader', id: leader });
    }
    matchDirty = true;
    if (log) log.info({ room: id, player: pid, reason, players: actors.size, inputs: a.stats }, 'player left');
    if (!actors.size && onEmpty) onEmpty();
    return true;
  }

  function restart() {
    match.dispose();
    nades.clear();
    phase = 'warmup';
    match = newMatch();
    for (const a of actors.values()) absorb(match.addPlayer({ id: a.id, name: a.name, team: a.team }));
  }

  function handle(pid, msg) {
    const a = actors.get(pid);
    if (!a || !msg) return;
    switch (msg.t) {
      case 'in': a.enqueue(msg); break;
      case 'pick': absorb(match.setLoadout(pid, msg.w), pid); break;
      case 'team': absorb(match.setTeam(pid, msg.team), pid); break;
      case 'start':
        if (pid !== leader) { direct(pid, { type: 'reject', action: 'start', reason: 'not_leader', by: pid }); break; }
        if (phase === 'matchEnd') restart();
        absorb(match.start(), pid);
        break;
      default: break;
    }
  }

  function step() {
    if (disposed) return;
    tick += 1;
    const list = [...actors.values()];
    const n = list.length;
    // 처리 순서를 틱마다 한 칸씩 돌린다: 같은 틱에 서로 쏜 두 사람 중 늘 같은 사람이 먼저 맞히지 않게
    const canMove = phase !== 'loadout' && phase !== 'matchEnd';
    for (let i = 0; i < n; i++) {
      const a = list[(i + tick) % n];
      a.step({ canMove, onWeaponEvent: (ev, inp) => onWeapon(a, ev, inp) });
    }
    for (const ge of nades.update(tickDt)) if (ge.type === 'explode') explode(ge);
    absorb(match.tick(tickMs));
    history.record(tick, list.map((a) => a.target()));
    if (tick % snapshotEvery === 0) sendSnapshots();
    flush();
    if (matchDirty || tick % matchEvery === 0) sendMatch();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const a of actors.values()) a.dispose();
    actors.clear();
    peers.clear();
    match.dispose();
    nades.dispose();
  }

  return {
    id,
    map: built.id,
    mode,
    ruleset: rs,
    join,
    leave,
    handle,
    step,
    dispose,
    get tick() { return tick; },
    get phase() { return phase; },
    get size() { return actors.size; },
    get leader() { return leader; },
    get match() { return match; },
    get world() { return built.world; },
    get maxRewindTicks() { return maxRewindTicks; },
    /** 시험·진단용 */
    actor: (pid) => actors.get(pid) || null,
    actorIds: () => [...actors.keys()],
    history,
    stats() {
      return {
        id, map: built.id, mode, ruleset: rs, tick, phase, players: actors.size, ...counters,
        avgRewindMs: counters.rewinds ? round2((counters.rewindTicks / counters.rewinds) * tickMs) : 0
      };
    }
  };
}
