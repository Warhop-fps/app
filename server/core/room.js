/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 방 하나의 규칙(권위 서버의 공통 방 로직). 접속·입력·틱만 받고 보낼 메시지는 send로 넘긴다. 네트워크와 타이머는 어댑터(VM의 Node 서버, Durable Objects)가 맡는다.
 *          경기 규칙(createMatch)·물리 월드·사람(actor)·수류탄을 들고 틱마다 입력을 하나씩 처리하며, 사격은 쏜 사람이 본 틱으로 되감아 판정한다.
 */
/**
 *   const room = createRoom({ send: (playerId, text) => socketOf(playerId).send(text), id: 'abc', map: 'arena' });
 *   room.join(playerId, { name, team, tokenHash });   // 신원(playerId)은 어댑터가 정한다 → { ok, team } | { ok:false, code }. tokenHash는 방 밖으로 내보내지 않는다
 *   room.input(playerId, msg);             // protocol.decodeClient로 검사한 input·pick·team·start·respawn. 쌓아 두었다가 다음 틱에 순서대로 처리한다
 *   room.tick();                           // 틱 하나(어댑터가 1/hz초마다 부른다). 틱 길이는 만들 때 hz로 정해진다
 *   room.leave(playerId);
 *   room.size                              // 사람 수
 *
 * send(playerId, text)의 text는 이미 JSON 글자다. 모두에게 같은 스냅샷 앞부분을 틱마다 한 번만 직렬화하려고 방이 직접 만든다.
 *
 * 방 하나 = 한 줄로 도는 actor. 받은 메시지는 방의 받은 줄(inbox)에 도착 순서대로 쌓이고, 틱이 시작할 때 그 순서 그대로 꺼낸다.
 * 방끼리는 아무것도 나눠 쓰지 않는다(맵 충돌체만 읽기 전용으로 함께 본다, core/maps.js). 그래서 방을 프로세스마다 나눠도 규칙이 같다.
 *
 * 틱 순서
 *   0. 받은 줄을 비운다: pick·team·start·respawn을 도착 순서대로 경기 규칙(match)에 넣는다. input은 받을 때 그 사람의 입력 줄에 들어가 있다
 *   1. 사람마다 입력 하나 → 이동·무기(사격은 그 자리에서 되감아 판정해 match.claimHit). 처리 순서는 틱마다 한 칸씩 돈다
 *   2. 수류탄 → 폭발은 지금 자리로 피해 계산해 match.claimExplosion
 *   3. match.tick(경기 시계) → 라운드 시작·끝 이벤트를 사람에게 적용(스폰·얼림·로드아웃)
 *   4. 이 틱의 자리를 지연 보정 기록에 남긴다(기록 k = 스냅샷 k)
 *   5. 스냅샷(틱마다) · 이벤트(있으면) · 점수판(이벤트가 있었거나 0.5초마다)
 *   경기가 끝나면(matchEnd) 사람마다 보상(core/rewards.js)을 계산해 그 사람에게만 { type:'reward' } 이벤트로 보낸다.
 *   개인전이면 같은 계산으로 경기 결과(docs/MATCH_RESULT_CONTRACT.md 1절, signedAt 빼고)를 만들어 onResult로 넘긴다(서명·전송은 어댑터, node/results.js).
 * 틱 밖에서 생긴 일(입장·퇴장·무기 선택)의 이벤트도 다음 틱 끝에 함께 나간다.
 */
import { PLAYER } from '../../js/core/consts.js';
import { createMatch } from '../../js/game/match.js';
import { normalizeKillTarget, normalizeRuleset, shotTargets } from '../../js/game/modes.js';
import { getDef } from '../../js/weapons/defs.js';
import { createGrenadeSystem } from '../../js/weapons/grenade.js';
import { createActor } from './actor.js';
import { meleeTrace, resolveShot } from './combat.js';
import { createHistory, rewindTarget } from './lagcomp.js';
import { loadMap } from './maps.js';
import { PROTOCOL, ROW, TOKEN_HASH_RE } from './protocol.js';
import { QUICK_RESPAWN_COST, buildResult, matchRewards } from './rewards.js';

const round2 = (v) => Math.round(v * 100) / 100;
const r2 = (v) => [round2(v[0]), round2(v[1]), round2(v[2])];

/**
 * @param {object} o
 * @param {(playerId:string, text:string) => void} o.send 보낼 메시지(JSON 글자)
 * @param {(playerId:string) => number|null} [o.rttOf] 그 사람의 왕복 지연(ms). 점수판의 핑
 * @param {string} [o.id='room'] 방 id
 * @param {string} [o.map='arena'] maps.MAP_CHOICES 중 하나
 * @param {'team'|'ffa'} [o.mode='team']
 * @param {string} [o.ruleset='classic']
 * @param {number} [o.killTarget] 개인전 목표 킬(5~20, modes.FFA_KILLS). 없으면 20. rules.killTarget이 있으면 그것(시험·연습장 값)
 * @param {number} [o.inboxMax=512] 방의 받은 줄 상한(틱 하나 사이에 이보다 많이 오면 오래된 것부터 버린다)
 * @param {number} [o.hz=30] 서버 틱
 * @param {number} [o.substeps=2] 입력 하나를 나눠 돌리는 이동 횟수(1/60초 이동)
 * @param {number} [o.roomSize=6] 정원
 * @param {number} [o.maxRewindMs=300] 되감기 상한
 * @param {number} [o.historyTicks=64] 지연 보정 기록 길이
 * @param {number} [o.snapshotEvery=1] 스냅샷 간격(틱)
 * @param {number} [o.matchEvery=15] 점수판 간격(틱)
 * @param {object} [o.rules] createMatch 규칙 덮어쓰기(시험·데모의 짧은 라운드 등)
 * @param {() => number} [o.rng] 탄퍼짐·스폰 섞기 난수
 * @param {object} [o.log] 로거(log.info·debug)
 * @param {() => void} [o.onEmpty] 마지막 사람이 나갔을 때
 * @param {(result:object) => void} [o.onResult] 개인전 경기 끝의 결과(약속 모양, signedAt 없음). 토큰 해시를 낸 사람만 들어간다
 * @param {string} [o.resultRoomId] 결과의 roomId. 같은 방 id를 다시 써도 결과 번호가 겹치지 않게 어댑터가 붙인다(기본 id)
 * @param {string} [o.serverId='local'] 결과의 serverId
 * @param {() => number} [o.wallNow=Date.now] 결과의 시각(ms)
 */
export function createRoom(o) {
  const {
    send, rttOf = null, id = 'room', map = 'arena', mode = 'team', ruleset = 'classic', killTarget = null, inboxMax = 512, hz = 30, substeps = 2, roomSize = 6,
    maxRewindMs = 300, historyTicks = 64, snapshotEvery = 1, matchEvery = 15, rules = {},
    rng = Math.random, log = null, onEmpty = null, onResult = null, resultRoomId = id, serverId = 'local', wallNow = Date.now
  } = o;
  if (typeof send !== 'function') throw new TypeError('createRoom: send(playerId, text)가 필요하다');
  const built = loadMap(map);
  if (!built) throw new Error(`unknown map: ${map}`);
  const rs = normalizeRuleset(ruleset);
  const ffa = mode === 'ffa';
  // 결과를 실제로 보내는가(어댑터의 우체부가 켜져 있으면 onResult가 있다). welcome.paid로 그 사람에게 알린다
  const resultsOn = ffa && typeof onResult === 'function';
  const tickMs = 1000 / hz;
  const tickDt = 1 / hz;
  const maxRewindTicks = (Math.max(0, maxRewindMs) / 1000) * hz;
  const kt = ffa ? (rules.killTarget != null ? rules.killTarget : normalizeKillTarget(killTarget)) : undefined;
  const matchRules = { ...rules, mode, ruleset: rs, maxPlayers: roomSize, maxPerTeam: Math.ceil(roomSize / 2), ...(ffa ? { killTarget: kt } : {}) };
  const ffaSpots = [...built.spawns.owner, ...built.spawns.charterer, ...(built.spawns.ffa || [])];

  const actors = new Map();   // 입장 순서
  const history = createHistory({ size: historyTicks });
  const nades = createGrenadeSystem({ world: built.world });
  const counters = { shots: 0, hits: 0, rewinds: 0, rewindTicks: 0, clamped: 0, explosions: 0, quickRespawns: 0, inboxDropped: 0 };
  const inbox = [];          // [playerId, msg] 도착 순서
  const quick = new Map();   // 사람별 이번 경기 즉시 부활 횟수(보상에서 뺀다)
  let liveTick = null;       // 경기가 live가 된 틱(보상의 경기 길이)
  let liveAt = null;         // 경기가 live가 된 벽시계(ms, 결과의 startedAt)
  let matchSeq = 0;          // 이 방에서 끝난 경기 수(결과 번호)
  const hashes = new Map();  // 사람 → 기기 토큰 해시. 스냅샷·이벤트에 싣지 않는다
  let match = newMatch();
  let phase = 'warmup';
  let tickNo = 0;
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
    for (const pid of actors.keys()) send(pid, text);
  }
  function direct(pid, ev) {
    if (!actors.has(pid)) return;
    const list = directOut.get(pid) || [];
    list.push(ev);
    directOut.set(pid, list);
  }
  function welcome(pid, team) {
    return JSON.stringify({
      t: 'welcome', v: PROTOCOL, playerId: pid, team, room: id, hz, tick: tickNo, map: built.id, mode, ruleset: rs,
      killTarget: ffa ? match.rules.killTarget : null, leader, maxRewindMs, row: ROW,
      // paid: 이 사람의 경기 포인트를 서버가 넣는다(결과를 보내고 토큰 해시가 있다). 브라우저는 그때 포인트를 더하지 않는다(약속 8절)
      paid: resultsOn && hashes.has(pid)
    });
  }
  function sendSnapshots() {
    if (!actors.size) return;
    const rows = [];
    for (const a of actors.values()) rows.push(a.row());
    // 모두에게 같은 앞부분은 한 번만 직렬화하고, 받는 사람만의 me만 덧붙인다
    const head = `{"t":"snap","tick":${tickNo},"players":${JSON.stringify(rows)},"me":`;
    for (const [pid, a] of actors) send(pid, head + JSON.stringify(a.me()) + '}');
  }
  function flush() {
    if (outEvents.length) {
      broadcast(JSON.stringify({ t: 'events', tick: tickNo, events: outEvents }));
      outEvents = [];
    }
    for (const [pid, list] of directOut) if (actors.has(pid)) send(pid, JSON.stringify({ t: 'events', tick: tickNo, events: list }));
    directOut.clear();
  }
  function sendMatch() {
    matchDirty = false;
    if (!actors.size) return;
    const ping = {};
    for (const pid of actors.keys()) {
      const v = rttOf ? rttOf(pid) : null;
      ping[pid] = Number.isFinite(v) ? Math.round(v) : null;
    }
    broadcast(JSON.stringify({ t: 'match', tick: tickNo, match: match.snapshot(), leader, ping }));
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
        if (ev.phase === 'live' && liveTick == null) { liveTick = tickNo; liveAt = wallNow(); }
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
      case 'matchEnd': sendRewards(ev); break;
      default: break;
    }
  }

  /**
   * 경기 끝: 사람마다 보상을 계산해 그 사람에게만 보낸다(reward.server = true면 포인트는 서버가 넣는다).
   * 개인전이면 같은 값으로 경기 결과를 만들어 onResult로 넘긴다. 팀전은 아직 결과를 내지 않는다(서버 판정은 개인전만)
   */
  function sendRewards(ev) {
    const players = [...actors.values()].map((a) => ({ id: a.id, team: a.team }));
    const seconds = liveTick == null ? 0 : Math.round(((tickNo - liveTick) * tickMs) / 1000);
    const rewards = matchRewards(ev, { players, mode: ffa ? 'ffa' : 'team', ruleset: rs, mapId: built.id, killTarget: match.rules.killTarget, seconds, quick });
    const posting = resultsOn;
    for (const r of rewards) {
      direct(r.id, {
        type: 'reward', id: r.id, summary: r.summary, reward: r.reward, quick: r.quick, cost: r.quick * QUICK_RESPAWN_COST,
        server: posting && hashes.has(r.id)
      });
    }
    if (!posting) return;
    matchSeq += 1;
    const result = buildResult(ev, rewards, {
      roomId: resultRoomId, matchSeq, serverId, map: built.id, startedAt: liveAt, endedAt: wallNow(), hashes
    });
    if (result) {
      try { onResult(result); } catch (err) { if (log) log.error({ err, room: id }, 'onResult failed'); }
    }
  }

  /** 개인전 즉시 부활: 경기가 허락하면(instant spawn) 횟수를 센다. 거절(not_waiting·too_late 등)은 그 사람에게만 간다 */
  function respawn(pid) {
    const evs = match.respawnNow(pid);
    if (evs.some((e) => e.type === 'spawn' && e.id === pid && e.instant)) {
      quick.set(pid, (quick.get(pid) || 0) + 1);
      counters.quickRespawns++;
    }
    absorb(evs, pid);
  }

  // ── 판정 ──────────────────────────────────────────────
  /**
   * 쏜 사람 a가 viewTick에 본 다른 사람들의 자리. 지금도 살아 있어야 대상이 된다(그 사이에 죽었으면 맞힐 수 없다).
   * 팀전에서는 아군을 뺀다(총알이 아군 몸을 통과한다, modes.shotTargets).
   */
  function rewound(a, viewTick) {
    const range = history.range();
    if (!range) return { list: [], rewind: 0 };
    const rt = rewindTarget(viewTick, { now: tickNo, maxTicks: maxRewindTicks, oldest: range.oldest, newest: range.newest });
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
    const { list, rewind } = rewound(a, inp.viewTick);
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
    const { list } = rewound(a, inp.viewTick);
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
  /** 들어온다. playerId는 어댑터가 정한 신원이다(클라이언트가 고르지 않는다) */
  function join(pid, { name, team = null, tokenHash = null } = {}) {
    if (disposed) return { ok: false, code: 'room_closed' };
    if (typeof pid !== 'string' || !pid) return { ok: false, code: 'bad_id' };
    if (actors.has(pid)) return { ok: false, code: 'duplicate_id' };
    if (actors.size >= roomSize) return { ok: false, code: 'room_full' };
    const evs = match.addPlayer({ id: pid, name, team });
    const first = evs[0];
    if (!first || first.type === 'reject') return { ok: false, code: (first && first.reason) || 'join_failed' };
    const actor = createActor({ id: pid, name: first.name, team: first.team, world: built.world, ruleset: rs, rng, substeps, tickDt, hp: match.rules.hp });
    actors.set(pid, actor);
    if (typeof tokenHash === 'string' && TOKEN_HASH_RE.test(tokenHash)) hashes.set(pid, tokenHash);
    if (!leader) leader = pid;
    send(pid, welcome(pid, first.team));
    absorb(evs);
    if (log) log.info({ room: id, player: pid, name: first.name, team: first.team, players: actors.size }, 'player joined');
    return { ok: true, team: first.team };
  }

  function leave(pid, reason = 'left') {
    const a = actors.get(pid);
    if (!a) return false;
    actors.delete(pid);
    directOut.delete(pid);
    hashes.delete(pid);
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
    quick.clear();
    liveTick = null;
    liveAt = null;
    match = newMatch();
    for (const a of actors.values()) absorb(match.addPlayer({ id: a.id, name: a.name, team: a.team }));
  }

  /** 검사를 통과한 클라이언트 메시지(protocol.decodeClient의 input·pick·team·start·respawn). 받은 줄에 넣고 다음 틱 처음에 처리한다 */
  function input(pid, msg) {
    if (disposed || !msg) return;
    const a = actors.get(pid);
    if (!a) return;
    // 이동 입력은 그 사람의 입력 줄(상한 INPUT_QUEUE_MAX, actor.js)로 바로 간다. 틱마다 하나씩 꺼내므로 순서와 속도가 지켜진다
    if (msg.t === 'input') { a.enqueue(msg); return; }
    inbox.push([pid, msg]);
    // 틱이 멈춘 채 메시지만 쌓이지 않게 한다. 접속마다 속도 제한이 있어 평소에는 닿지 않는다
    while (inbox.length > inboxMax) { inbox.shift(); counters.inboxDropped++; }
  }

  function handle(pid, msg) {
    const a = actors.get(pid);
    if (!a) return;   // 메시지를 보낸 뒤 나갔다
    switch (msg.t) {
      case 'pick': absorb(match.setLoadout(pid, msg.weapon), pid); break;
      case 'team': absorb(match.setTeam(pid, msg.team), pid); break;
      case 'start':
        if (pid !== leader) { direct(pid, { type: 'reject', action: 'start', reason: 'not_leader', by: pid }); break; }
        if (phase === 'matchEnd') restart();
        absorb(match.start(), pid);
        break;
      case 'respawn': respawn(pid); break;
      default: break;
    }
  }

  /** 틱 하나. 길이는 만들 때 정한 1/hz초로 고정이다(입력 하나 = 틱 하나라서 틱 길이가 바뀌면 이동이 달라진다) */
  function tick() {
    if (disposed) return;
    tickNo += 1;
    if (inbox.length) {
      const batch = inbox.splice(0);
      for (const [pid, msg] of batch) handle(pid, msg);
    }
    const list = [...actors.values()];
    const n = list.length;
    // 처리 순서를 틱마다 한 칸씩 돌린다: 같은 틱에 서로 쏜 두 사람 중 늘 같은 사람이 먼저 맞히지 않게
    const canMove = phase !== 'loadout' && phase !== 'matchEnd';
    for (let i = 0; i < n; i++) {
      const a = list[(i + tickNo) % n];
      a.step({ canMove, onWeaponEvent: (ev, inp) => onWeapon(a, ev, inp) });
    }
    for (const ge of nades.update(tickDt)) if (ge.type === 'explode') explode(ge);
    absorb(match.tick(tickMs));
    history.record(tickNo, list.map((a) => a.target()));
    if (tickNo % snapshotEvery === 0) sendSnapshots();
    flush();
    if (matchDirty || tickNo % matchEvery === 0) sendMatch();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const a of actors.values()) a.dispose();
    actors.clear();
    inbox.length = 0;
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
    input,
    tick,
    dispose,
    get size() { return actors.size; },
    get currentTick() { return tickNo; },
    get phase() { return phase; },
    get leader() { return leader; },
    get matchSeq() { return matchSeq; },
    get killTarget() { return ffa ? match.rules.killTarget : null; },
    get inboxSize() { return inbox.length; },
    get match() { return match; },
    get world() { return built.world; },
    get maxRewindTicks() { return maxRewindTicks; },
    /** 시험·진단용 */
    actor: (pid) => actors.get(pid) || null,
    playerIds: () => [...actors.keys()],
    history,
    stats() {
      return {
        id, map: built.id, mode, ruleset: rs, tick: tickNo, phase, players: actors.size, ...counters,
        avgRewindMs: counters.rewinds ? round2((counters.rewindTicks / counters.rewinds) * tickMs) : 0
      };
    }
  };
}
