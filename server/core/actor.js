/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 방 안의 사람 한 명. 클라이언트 입력을 줄에 쌓았다가 서버 틱마다 하나씩 꺼내, 브라우저와 같은 플레이어 코드(createLocalPlayer: 이동·앉기·점프·발판)와
 *          무기 상태 머신(createArsenal)에 넣는다. 한 틱에 입력 하나만 처리해 속도 조작을 막고, 마지막으로 처리한 입력 번호(ack)를 남긴다.
 */
/**
 * 입력 하나 = 서버 틱 하나(1/30초). 이동은 브라우저 고정 틱(1/60초)과 같은 간격으로 substeps(2)번 나눠 돌린다.
 * 그래서 점프 높이·버니합·마찰이 브라우저에서 튜닝한 값과 똑같이 나온다(movement.js 수치는 60 Hz 기준).
 *
 * 입력 줄 규칙
 *   - 틱마다 정확히 한 걸음. 줄이 비면 마지막 입력의 누르고 있는 키를 한 틱 더 쓴다(새로 누름 press·무기 칸 slot은 되풀이하지 않는다).
 *   - 줄이 INPUT_QUEUE_MAX보다 길어지면 가장 오래된 입력의 이동은 버리고 새로 누름(press)과 무기 칸(slot)만 다음 입력에 합친다.
 *     밀린 입력을 한 틱에 여러 개 처리하지 않으므로 시간을 앞당겨 빨리 달리는 조작이 통하지 않는다.
 *   - 번호(seq)가 이미 받은 것보다 크지 않으면 버린다(중복·순서 조작).
 */
import { createBus } from '../../js/core/bus.js';
import { PLAYER } from '../../js/core/consts.js';
import { findFloor } from '../../js/engine/physics.js';
import { createLocalPlayer } from '../../js/engine/player.js';
import { createArsenal } from '../../js/weapons/logic.js';
import { DEFAULT_LOADOUT } from '../../js/weapons/defs.js';
import { rulesetOf } from '../../js/game/modes.js';
import { FLAG, KEY, PRESS, encodeRow } from './protocol.js';

/** 쌓아 두는 입력 상한(약 133 ms). 지연이 튀어 한꺼번에 온 입력을 이만큼은 그대로 처리한다 */
export const INPUT_QUEUE_MAX = 4;

/** 무기 슬롯 → arsenal 로드아웃 키(world.js와 같다) */
const SLOT_KEYS = Object.freeze({ 1: 'primary', 2: 'secondary', 3: 'melee' });
const NO_WEAPON_INPUT = Object.freeze({
  fireDown: false, firePressed: false, zoomDown: false, zoomToggle: false, reloadPressed: false, slot: null, wheel: 0
});

const cm = (v) => Math.round(v * 100);
const mrad = (v) => Math.round(v * 1000);
const secs = (v) => (Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 99);

/**
 * @param {object} o
 * @param {string} o.id
 * @param {string} o.name
 * @param {string|null} o.team
 * @param {object} o.world physics world
 * @param {string} o.ruleset
 * @param {() => number} [o.rng] 탄퍼짐 난수
 * @param {number} [o.substeps=2] 입력 하나를 나눠 돌리는 이동 횟수
 * @param {number} [o.tickDt] 서버 틱(초)
 * @param {number} [o.hp] 스폰 체력(경기 규칙)
 */
export function createActor({ id, name, team, world, ruleset, rng = Math.random, substeps = 2, tickDt = 1 / 30, hp = PLAYER.HP }) {
  const bus = createBus();
  const keys = { forward: false, back: false, left: false, right: false, jump: false, crouch: false, walk: false, aim: false };
  // createLocalPlayer가 읽는 입력 모양. 시점(yaw·pitch)은 입력마다 상태에 직접 넣으므로 마우스 이동은 늘 0이다
  const input = { state: keys, enabled: true, consumeLook: () => ({ dx: 0, dy: 0 }) };
  const player = createLocalPlayer({ bus, input, camera: null, getWorld: () => world, state: { id, name, team, alive: false } });
  const state = player.state;
  const rs = rulesetOf(ruleset);
  const arsenal = createArsenal({ ...DEFAULT_LOADOUT, allowedSlots: rs.slots, rng, zoomMode: 'hold' });
  const subDt = tickDt / substeps;

  const queue = [];
  let lastSeq = -1;     // 받은 입력 중 가장 큰 번호
  let ack = -1;         // 처리한 마지막 입력 번호
  let last = { t: 'input', seq: -1, keys: 0, press: 0, yaw: 0, pitch: 0, slot: 0, viewTick: null };
  let prevKeys = 0;
  let spawned = false;
  let dead = false;     // 경기가 죽였다. 다음 스폰까지는 무엇도 살리지 못한다
  let pick = rs.defaultPick;
  let shotSeq = 0;
  const stats = { inputs: 0, stale: 0, repeated: 0, folded: 0 };

  const gear = () => ({ ...DEFAULT_LOADOUT, [SLOT_KEYS[rs.pickSlot]]: pick });

  /** 입력 하나를 줄에 넣는다. 번호가 늘지 않았으면 false */
  function enqueue(msg) {
    if (msg.seq <= lastSeq) { stats.stale++; return false; }
    lastSeq = msg.seq;
    queue.push(msg);
    while (queue.length > INPUT_QUEUE_MAX) {
      const old = queue.shift();
      const next = queue[0];
      next.press |= old.press;               // 새로 누른 키(점프·사격·재장전)는 잃지 않는다
      if (!next.slot && old.slot) next.slot = old.slot;
      stats.folded++;
    }
    return true;
  }

  /** 이번 걸음의 무기 입력(world.js tick과 같은 모양). 새로 누름은 첫 걸음에만 넣는다 */
  function weaponInput(inp, first) {
    const fireDown = !!(inp.keys & KEY.FIRE);
    return {
      fireDown,
      firePressed: first && (!!(inp.press & PRESS.FIRE) || (fireDown && !(prevKeys & KEY.FIRE))),
      zoomDown: !!(inp.keys & KEY.AIM),
      zoomToggle: first && !!(inp.press & PRESS.AIM),
      reloadPressed: first && !!(inp.press & PRESS.RELOAD),
      slot: first && inp.slot ? inp.slot : null,
      wheel: first ? (inp.press & PRESS.NEXT ? 1 : inp.press & PRESS.PREV ? -1 : 0) : 0
    };
  }

  /**
   * 서버 틱 하나. 입력 하나를 꺼내 이동과 무기를 substeps번 돌린다.
   * @param {{canMove:boolean, onWeaponEvent:(ev:object, inp:object) => void}} ctx
   *   canMove = 경기 단계가 움직임을 허락한다(로드아웃·경기 끝이면 false). onWeaponEvent = fire·melee·throw 등 arsenal 이벤트
   */
  function step(ctx) {
    let inp;
    if (queue.length) {
      inp = queue.shift();
      ack = inp.seq;
      stats.inputs++;
      state.yaw = inp.yaw;
      state.pitch = inp.pitch;
    } else {
      // 입력이 늦었다: 누르고 있던 키를 한 틱 더 누른 것으로 본다. 시점은 지금 그대로 둔다(스폰 방향을 옛 입력이 덮지 않게)
      inp = { ...last, yaw: state.yaw, pitch: state.pitch, press: 0, slot: 0 };
      stats.repeated++;
    }
    last = inp;
    const k = inp.keys;
    keys.forward = !!(k & KEY.FORWARD);
    keys.back = !!(k & KEY.BACK);
    keys.left = !!(k & KEY.LEFT);
    keys.right = !!(k & KEY.RIGHT);
    keys.jump = !!(k & KEY.JUMP);
    keys.crouch = !!(k & KEY.CROUCH);
    keys.walk = !!(k & KEY.WALK);
    keys.aim = !!(k & KEY.AIM);
    if (inp.press & PRESS.JUMP) bus.emit('input:jump');   // 브라우저의 keydown과 같다(0.12초 점프 버퍼)
    const canMove = !!ctx.canMove && spawned;
    for (let i = 0; i < substeps; i++) {
      player.setFrozen(!canMove);
      player.tick(subDt);
      // player.js는 맵 밖으로 떨어진 몸을 마지막 스폰 자리에 다시 세우며 살려 둔다. 죽은 몸·관전자는 경기만 살릴 수 있다
      if ((dead || !spawned) && state.alive) state.alive = false;
      if (!spawned || !state.alive) continue;
      // 브라우저도 얼어 있는 동안 무기 시계(꺼내기·재장전)는 돌리고 입력만 막는다
      const wi = canMove ? weaponInput(inp, i === 0) : NO_WEAPON_INPUT;
      const evs = arsenal.update(subDt, wi, { speed: Math.hypot(state.vel[0], state.vel[2]), onGround: state.onGround, walking: state.walking, crouch: !!state.crouch });
      for (const ev of evs) {
        if (ev.type === 'switch') { state.slot = ev.slot; state.weapon = ev.to; }
        ctx.onWeaponEvent(ev, inp);
      }
      player.setSpeedScale(arsenal.getMoveMul());
    }
    prevKeys = k;
  }

  /** 스폰(라운드 시작·개인전 부활·대기실). sp = { x, z, rotY, y? }, nextPick = 고른 무기 */
  function spawn(sp, nextPick) {
    if (typeof nextPick === 'string' && nextPick) pick = nextPick;
    const x = +sp.x || 0, z = +sp.z || 0;
    const y = Number.isFinite(sp.y) ? sp.y : findFloor(world, x, z);
    player.spawn({ x, y, z, rotY: +sp.rotY || 0 });
    state.hp = hp;
    arsenal.setAllowedSlots(rs.slots);
    arsenal.resetRound({ ...gear(), draw: true });
    const w = arsenal.getWeapon();
    state.slot = w.slot;
    state.weapon = w.id;
    player.setSpeedScale(arsenal.getMoveMul());
    spawned = true;
    dead = false;
  }

  /** 고른 무기를 바꾼다. apply면(로드아웃 단계) 지금 무기도 바꿔 꺼낸다 */
  function setPick(w, apply = false) {
    if (typeof w !== 'string' || !w || w === pick) return;
    pick = w;
    if (apply && spawned && state.alive) {
      arsenal.resetRound({ ...gear(), draw: true });
      player.setSpeedScale(arsenal.getMoveMul());
    }
  }

  /** 스냅샷 줄(protocol.ROW) */
  function row() {
    const w = arsenal.getWeapon();
    let flags = 0;
    if (state.onGround) flags |= FLAG.onGround;
    if (spawned && arsenal.getZoom().zoomed) flags |= FLAG.zoom;
    if (state.walking) flags |= FLAG.walking;
    if (spawned && state.alive) flags |= FLAG.alive;
    if (w.state === 'reload') flags |= FLAG.reloading;
    if (state.crouch) flags |= FLAG.crouch;
    return encodeRow({ id, pos: state.pos, yaw: state.yaw, pitch: state.pitch, flags, hp: state.hp, weapon: spawned ? w.id : '', ack });
  }

  /** 받는 사람 자신에게만 보내는 상태. 다음 단계의 클라이언트 예측·보정이 쓴다(docs/SERVER.md 8절) */
  function me() {
    const a = arsenal.getAmmo();
    const mm = state.moveMem || {};
    const rk = arsenal.getRecoilKick();
    return {
      ack,
      v: [cm(state.vel[0]), cm(state.vel[1]), cm(state.vel[2])],
      g: state.onGround ? 1 : 0,
      mm: [secs(mm.sinceLand), secs(mm.sinceSwap), mm.lastSign | 0],
      ws: arsenal.getWeapon().state,
      am: a && a.kind === 'mag' ? [a.mag, a.reserve === Infinity ? -1 : a.reserve] : a && a.kind === 'count' ? [a.mag, 0] : null,
      rk: [mrad(rk.yaw), mrad(rk.pitch)],
      sp: Math.round(state.speedScale * 1000) / 1000
    };
  }

  return {
    id,
    get name() { return state.name; },
    get team() { return state.team; },
    setTeam(t) { state.team = t; },
    state,
    arsenal,
    enqueue,
    step,
    spawn,
    setPick,
    /** 관전으로(이번 라운드에 끼지 못했다) */
    despawn() { spawned = false; state.alive = false; },
    kill() { dead = true; if (state.alive) player.kill(); },
    setHp(v) { state.hp = Math.max(0, v | 0); },
    row,
    me,
    /** 지연 보정 기록 한 줄(lagcomp.record) */
    target() {
      return { id, team: state.team, x: state.pos[0], y: state.pos[1], z: state.pos[2], yaw: state.yaw, crouch: state.crouch ? 1 : 0, alive: spawned && state.alive };
    },
    /** 사격 원점(카메라가 없으면 발 + 눈높이, 앉으면 앉은 눈높이) */
    eye: () => player.getEye(),
    aimDir: () => player.getAimDir(),
    nextShotId: () => String(++shotSeq),
    get spawned() { return spawned; },
    get alive() { return spawned && state.alive; },
    get ack() { return ack; },
    get queued() { return queue.length; },
    get pick() { return pick; },
    stats,
    dispose() { player.dispose(); arsenal.dispose(); queue.length = 0; }
  };
}
