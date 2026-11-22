/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 서버가 판정하는 개인전에서 세션(session.js)과 게임 서버 메시지 사이의 번역기. 서버의 사람 id를 화면 id로 바꾸고,
 *          서버 점수판(match)·이벤트를 방장 판정 때와 같은 모양({ snapshot, events })으로 만들고, 스냅샷 줄로 원격 보간(interp.js)·내 위치 보정 값을 낸다.
 *          입력 표본(키 비트·새로 누름·무기 칸)도 만든다. 화면·소켓을 모르는 순수 모듈이라 node 시험에서 돈다.
 */
/**
 *   const link = createServerLink({ me, mid, map, ruleset, hz });
 *   link.welcome(w)                       // 내 서버 id·틱·paid(서버가 포인트를 넣는가)
 *   session.onMatchData(link.matchData(m))   // 'match' 메시지 → { from:'server', snapshot, events:[] }
 *   const { data, fx } = link.eventsData(m)  // 'events' → data는 세션 이벤트, fx는 사격·수류탄 연출(남의 것만)
 *   link.snap(m, arrivalMs)               // 'snap' → 원격 보간 버퍼 + 내 위치 오차
 *   link.remote(id, nowMs)                // 원격 렌더 상태(sync.getRemote 모양 + weaponId)
 *   link.viewTick(nowMs)                  // 다른 사람을 그리고 있는 서버 틱(사격 되감기 기준)
 *   link.predicted(seq, pos)              // 입력 seq를 보낼 때 내 발 위치(보정 기준)
 *   link.takeCorrection()                 // { dx, dy, dz, snap } | null  내 위치를 서버 쪽으로 당길 양
 *
 * 화면 id: 내 서버 id → me(중계 방의 내 id), 다른 사람 → 'gs-' + 서버 id(그 경기 동안 바뀌지 않는다). 중계 id는 avatar 찾기에만 쓴다(aliases).
 *
 * 내 위치 보정(간단판, docs/SERVER.md 16절): 내 움직임은 브라우저가 지금처럼 바로 그린다(예측). 서버 스냅샷의 내 줄(ack = 처리한 마지막 입력)을
 * 그 입력을 보낼 때의 내 위치와 비교해, 오차가 작으면(TOLERANCE) 두고, 크면 BLEND만큼 서버 쪽으로 당기고, 아주 크면(SNAP_DIST) 서버 자리로 옮긴다.
 * 입력을 다시 돌려(replay) 정확히 맞추지는 않는다.
 */
import { createInterp } from './interp.js';
import { FLAG } from './protocol.js';
import { KEY, PRESS, ROW } from '../net/gameproto.js';

export const GS_PREFIX = 'gs-';
export const TOLERANCE = 0.12;   // m. 이보다 작은 오차는 두고 본다(서브스텝 시점 차이)
export const BLEND = 0.35;       // 오차의 이 비율만큼 한 번에 당긴다
export const SNAP_DIST = 3;      // m. 이보다 크면 서버 자리로 바로 옮긴다
const PRED_KEEP = 128;

const ID_KEYS = ['id', 'attacker', 'victim', 'killer', 'by'];
const VISUAL = new Set(['fire', 'swing', 'nade', 'boom', 'leader', 'reward']);
const SLOT_KEYS = Object.freeze(['primary', 'secondary', 'melee', 'grenade']);

/**
 * @param {object} o
 * @param {string} o.me 화면에서 내 id(중계 방 id)
 * @param {string} o.mid 경기 id(세션)
 * @param {string} o.map
 * @param {string} o.ruleset
 * @param {number} [o.hz=30]
 * @param {object} [o.interp] createInterp 옵션 덮어쓰기
 */
export function createServerLink(o) {
  const me = String(o.me);
  let hz = o.hz || 30;
  let tickMs = 1000 / hz;
  let self = null;
  let paid = false;
  let reward = null;
  const buffers = new Map();     // 화면 id → interp
  const lastRow = new Map();     // 화면 id → { tick, pos }
  const aliases = new Map();     // 화면 id → 중계 id
  const pred = new Map();        // seq → [x, y, z]
  let lastAck = -1;
  let pending = null;            // 아직 적용하지 않은 보정
  let latestTick = 0;
  let mine = null;               // 내 최신 줄
  const counters = { corrections: 0, snaps: 0, maxErr: 0 };

  const mapId = (sid) => {
    if (sid === null || sid === undefined) return sid;
    const s = String(sid);
    return self !== null && s === self ? me : GS_PREFIX + s;
  };

  function translate(ev) {
    const out = { ...ev, mid: o.mid };
    for (const k of ID_KEYS) if (out[k] !== undefined && out[k] !== null) out[k] = mapId(out[k]);
    if (ev.type === 'matchEnd' && Array.isArray(ev.ranking)) {
      out.ranking = ev.ranking.map((r) => ({ ...r, id: mapId(r.id) }));
      if (ev.winner !== undefined && ev.winner !== null) out.winner = mapId(ev.winner);
    }
    for (const k of ['spawns', 'loadouts']) {
      if (ev[k] && typeof ev[k] === 'object') {
        const m = {};
        for (const [id, v] of Object.entries(ev[k])) m[mapId(id)] = v;
        out[k] = m;
      }
    }
    return out;
  }

  function translateSnapshot(s) {
    if (!s || typeof s !== 'object') return null;
    const out = { ...s };
    if (Array.isArray(s.p)) out.p = s.p.map((r) => (Array.isArray(r) ? [mapId(r[0]), ...r.slice(1)] : r));
    if (Array.isArray(s.res)) out.res = [s.res[0] !== null && s.res[0] !== undefined ? mapId(s.res[0]) : s.res[0], ...s.res.slice(1)];
    return { ...out, mid: o.mid, map: o.map, gm: 'ffa', rs: o.ruleset };
  }

  function bufferOf(id) {
    let b = buffers.get(id);
    if (!b) {
      b = createInterp({ intervalHint: () => tickMs, minDelay: 80, floorY: null, ...(o.interp || {}) });
      buffers.set(id, b);
    }
    return b;
  }

  return {
    get self() { return self; },
    get paid() { return paid; },
    get reward() { return reward; },
    get tickMs() { return tickMs; },
    get latestTick() { return latestTick; },
    /** 내 최신 서버 줄 { pos, hp, alive, ack, weapon } */
    get mine() { return mine; },
    stats: () => ({ ...counters, lastAck }),
    mapId,
    /** 중계 id를 알면 아바타·이름을 방 명단에서 찾는다 */
    alias(screenId, relayId) { if (screenId && relayId) aliases.set(String(screenId), String(relayId)); },
    relayOf: (id) => (id === me ? me : aliases.get(id) || null),

    welcome(w) {
      if (!w || typeof w !== 'object') return;
      self = w.playerId != null ? String(w.playerId) : null;
      if (Number.isFinite(w.hz) && w.hz > 0) { hz = w.hz; tickMs = 1000 / hz; }
      paid = w.paid === true;
    },

    matchData(m) {
      return { from: 'server', snapshot: translateSnapshot(m && m.match), events: [] };
    },

    /** 'events' → { data: 세션에 줄 { from, events }(없으면 null), fx: 남의 연출 이벤트(화면 id), reward: 내 보상이 왔으면, rejects: 내 요청의 거절 } */
    eventsData(m) {
      const list = m && Array.isArray(m.events) ? m.events : [];
      const evs = [];
      const fx = [];
      let got = null;
      const rejects = [];
      for (const e of list) {
        if (!e || typeof e !== 'object' || typeof e.type !== 'string') continue;
        if (e.type === 'reward') {
          if (self !== null && String(e.id) === self) { reward = e; got = e; }
          continue;
        }
        if (VISUAL.has(e.type)) {
          const t = translate(e);
          if (t.id !== me) fx.push(t);
          continue;
        }
        if (e.type === 'reject') { if (self !== null && String(e.by) === self) rejects.push(e); continue; }
        evs.push(translate(e));
      }
      return { data: evs.length ? { from: 'server', events: evs } : null, fx, reward: got, rejects };
    },

    snap(m, arrival) {
      if (!m || !Array.isArray(m.players) || !Number.isFinite(m.tick)) return;
      latestTick = Math.max(latestTick, m.tick);
      const t = m.tick * tickMs;
      for (const r of m.players) {
        if (!Array.isArray(r)) continue;
        const id = mapId(r[ROW.ID]);
        const pos = [r[ROW.X] / 100, r[ROW.Y] / 100, r[ROW.Z] / 100];
        const flags = r[ROW.FLAGS] | 0;
        const alive = !!(flags & FLAG.alive);
        if (id === me) {
          mine = { pos, hp: r[ROW.HP] | 0, alive, ack: r[ROW.ACK], weapon: r[ROW.WEAPON] || '' };
          const ack = r[ROW.ACK];
          if (alive && Number.isInteger(ack) && ack > lastAck) {
            const p = pred.get(ack);
            lastAck = ack;
            if (p) {
              const dx = pos[0] - p[0], dy = pos[1] - p[1], dz = pos[2] - p[2];
              const err = Math.hypot(dx, dy, dz);
              if (err > counters.maxErr) counters.maxErr = Math.round(err * 100) / 100;
              if (err > SNAP_DIST) {
                pending = { dx, dy, dz, snap: true, pos };
                pred.clear();
                counters.snaps++;
              } else if (err > TOLERANCE) {
                const k = BLEND;
                pending = { dx: dx * k, dy: dy * k, dz: dz * k, snap: false };
                // 이미 당긴 만큼 기록도 옮겨 두어 다음 비교에서 두 번 당기지 않는다
                for (const q of pred.values()) { q[0] += pending.dx; q[1] += pending.dy; q[2] += pending.dz; }
                counters.corrections++;
              }
            }
            for (const s of pred.keys()) if (s <= ack) pred.delete(s);
          }
          continue;
        }
        const prev = lastRow.get(id);
        let vel = [0, 0, 0];
        if (prev && m.tick > prev.tick && m.tick - prev.tick < 30) {
          const dt = ((m.tick - prev.tick) * tickMs) / 1000;
          vel = [(pos[0] - prev.pos[0]) / dt, (pos[1] - prev.pos[1]) / dt, (pos[2] - prev.pos[2]) / dt];
        }
        lastRow.set(id, { tick: m.tick, pos });
        bufferOf(id).push({
          seq: m.tick, t, pos, vel, yaw: r[ROW.YAW] / 1000, pitch: r[ROW.PITCH] / 1000,
          alive, onGround: !!(flags & FLAG.onGround), crouch: !!(flags & FLAG.crouch), zoom: !!(flags & FLAG.zoom),
          reloading: !!(flags & FLAG.reloading), hp: r[ROW.HP] | 0, weaponId: r[ROW.WEAPON] || ''
        }, arrival);
      }
    },

    remote(id, now) {
      const b = buffers.get(id);
      return b ? b.sample(now) : null;
    },

    /** 다른 사람을 그리고 있는 서버 틱(소수). 보간 버퍼가 없으면 최신 틱 */
    viewTick(now) {
      for (const b of buffers.values()) {
        const R = b.toSender(now);
        if (Number.isFinite(R)) return Math.max(0, R / tickMs);
      }
      return latestTick;
    },

    predicted(seq, pos) {
      if (!Number.isInteger(seq) || !pos) return;
      pred.set(seq, [pos[0], pos[1], pos[2]]);
      if (pred.size > PRED_KEEP) pred.delete(pred.keys().next().value);
    },

    /** 출격·사망 때: 예측 기록과 남은 보정을 지운다 */
    resetSelf() { pred.clear(); pending = null; },

    takeCorrection() { const c = pending; pending = null; return c; },

    forget(id) { buffers.delete(id); lastRow.delete(id); }
  };
}

/**
 * 입력 표본 만들기: 누르고 있는 키(input.state + 조준은 화면 쪽 값) → keys, 지난 표본 뒤 새로 누른 키 → press, 바뀐 무기 칸 → slot.
 *   const sampler = createInputSampler();
 *   sampler.note('reload')                         // 'input:reload' 같은 순간 이벤트(표본 사이의 짧은 누름도 놓치지 않게)
 *   const msg = sampler.sample(input.state, world.getLocalState())   // { keys, press, slot, yaw, pitch }
 */
export function createInputSampler() {
  let prev = { jump: false, fire: false, aim: false };
  let noted = 0;
  let lastSlot = 0;
  const NOTE = { jump: PRESS.JUMP, fire: PRESS.FIRE, aim: PRESS.AIM, reload: PRESS.RELOAD, next: PRESS.NEXT, prev: PRESS.PREV };
  return {
    note(kind) { if (NOTE[kind]) noted |= NOTE[kind]; },
    reset() { prev = { jump: false, fire: false, aim: false }; noted = 0; lastSlot = 0; },
    sample(s = {}, local = {}) {
      const aim = !!(local && (local.aiming || local.zoom));
      const cur = { jump: !!s.jump, fire: !!s.fire, aim };
      let keys = 0;
      if (s.forward) keys |= KEY.FORWARD;
      if (s.back) keys |= KEY.BACK;
      if (s.left) keys |= KEY.LEFT;
      if (s.right) keys |= KEY.RIGHT;
      if (cur.jump) keys |= KEY.JUMP;
      if (s.crouch) keys |= KEY.CROUCH;
      if (s.walk) keys |= KEY.WALK;
      if (cur.fire) keys |= KEY.FIRE;
      if (aim) keys |= KEY.AIM;
      let press = noted;
      if (cur.jump && !prev.jump) press |= PRESS.JUMP;
      if (cur.fire && !prev.fire) press |= PRESS.FIRE;
      if (cur.aim && !prev.aim) press |= PRESS.AIM;
      noted = 0;
      prev = cur;
      const slotNow = local && Number.isInteger(local.slot) && local.slot >= 1 && local.slot <= 4 ? local.slot : 0;
      const slot = slotNow && slotNow !== lastSlot ? slotNow : 0;
      if (slotNow) lastSlot = slotNow;
      return { keys, press, slot, yaw: Number(local && local.yaw) || 0, pitch: Number(local && local.pitch) || 0 };
    }
  };
}

/** 장비 슬롯 이름(primary…) → 칸 번호(1~4). 화면이 슬롯 이름을 줄 때 */
export function slotNumber(v) {
  if (Number.isInteger(v)) return v >= 1 && v <= 4 ? v : 0;
  const i = SLOT_KEYS.indexOf(v);
  return i >= 0 ? i + 1 : 0;
}
