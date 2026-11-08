/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 서버 구조화 로그. 한 줄에 JSON 하나(pino와 같은 level·time·pid·hostname·msg 필드)를 쓰고, 수준과 고정 필드(child)를 고른다.
 *          의존성 없이 pino와 같은 모양으로 남겨 수집기(Grafana Alloy 등)가 pino 로그처럼 그대로 읽게 한다.
 */
/**
 *   const log = createLogger({ level: 'info' });
 *   log.info({ room: 'abc', players: 3 }, 'room created');   // 필드 + 문구 (pino와 같은 순서)
 *   log.warn('slow tick');                                   // 문구만
 *   const rlog = log.child({ room: 'abc' });                 // 고정 필드를 붙인 로거
 *
 * 수준 숫자는 pino와 같다: trace 10, debug 20, info 30, warn 40, error 50, fatal 60. 'silent'는 아무것도 쓰지 않는다.
 * 필드 이름 err에 Error를 넣으면 { type, message, stack, code }로 펼친다.
 */
import { hostname } from 'node:os';

export const LEVELS = Object.freeze({ trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: Infinity });
const NAMES = Object.freeze(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

/** Error → 직렬화할 수 있는 평범한 객체 */
export function serializeError(err) {
  if (!(err instanceof Error)) return err;
  const out = { type: err.name, message: err.message, stack: err.stack };
  if (err.code !== undefined) out.code = err.code;
  return out;
}

/** 순환 참조나 BigInt가 있어도 던지지 않는 JSON.stringify */
function safeStringify(rec) {
  try {
    return JSON.stringify(rec, (_, v) => (typeof v === 'bigint' ? String(v) : v));
  } catch {
    return JSON.stringify({ level: rec.level, time: rec.time, msg: rec.msg, logError: 'unserializable fields' });
  }
}

/**
 * @param {{level?:string, stream?:{write(s:string):any}, base?:object, now?:() => number}} [opts]
 *   stream: 한 줄씩 받는 곳(기본 process.stdout). base: 모든 줄에 붙일 필드
 */
export function createLogger({ level = 'info', stream = process.stdout, base = {}, now = Date.now } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const head = { pid: process.pid, hostname: hostname(), ...base };

  function make(bindings) {
    const fixed = { ...head, ...bindings };
    function write(name, a, b) {
      if (LEVELS[name] < min) return;
      const rec = { level: LEVELS[name], time: now(), ...fixed };
      let msg = '';
      if (typeof a === 'string') msg = a;
      else if (a instanceof Error) { rec.err = serializeError(a); msg = typeof b === 'string' ? b : a.message; }
      else if (a && typeof a === 'object') {
        for (const k of Object.keys(a)) rec[k] = k === 'err' ? serializeError(a[k]) : a[k];
        msg = typeof b === 'string' ? b : '';
      }
      rec.msg = msg;
      stream.write(safeStringify(rec) + '\n');
    }
    const log = { level, isLevelEnabled: (name) => LEVELS[name] >= min };
    for (const name of NAMES) log[name] = (a, b) => write(name, a, b);
    log.child = (more) => make({ ...bindings, ...more });
    return log;
  }
  return make({});
}

/** 테스트용: 쓴 줄을 객체로 모아 두는 stream. lines()로 꺼낸다 */
export function memoryStream() {
  const lines = [];
  return {
    write(s) { for (const line of String(s).split('\n')) if (line) lines.push(JSON.parse(line)); },
    lines: () => lines.slice(),
    clear: () => { lines.length = 0; }
  };
}
