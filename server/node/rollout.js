/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 서버 판정 방 비율(rollout)과 끄는 스위치. 운영자가 VM의 작은 JSON 파일({ "ratio": 0.1, "accepting": true })을 고치면
 *          서버를 다시 띄우지 않고 5초 안에 /rollout 답이 바뀐다. 브라우저는 방을 만들 때 이 답을 읽어 그 방을 서버 판정으로 할지 정한다(js/net/rollout.js).
 */
/**
 *   const ro = createRollout({ ratio: 0.1, file: '/etc/skala-server/rollout.json', log });
 *   ro.current()   // { ratio, accepting, source }  source: 'file' | 'config'
 *   ro.close()
 *
 * 파일이 없거나 깨졌으면 설정값(--server-ratio, SERVER_ROOM_RATIO)을 쓴다. 깨진 파일은 경고 로그 한 줄(같은 내용이면 다시 쓰지 않는다).
 * ratio는 0~1로 자른다. accepting:false 또는 ratio 0 = 새 서버 판정 방을 만들지 않는다(끄는 스위치). 이미 하고 있는 경기는 끝까지 간다.
 */
import { readFileSync } from 'node:fs';

const clamp01 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

/** 파일 글자 → { ratio, accepting } 또는 이유가 담긴 오류 */
export function parseRollout(text) {
  let v;
  try { v = JSON.parse(text); } catch { return { ok: false, why: 'json' }; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, why: 'shape' };
  if (typeof v.ratio !== 'number' || !Number.isFinite(v.ratio)) return { ok: false, why: 'ratio' };
  if (v.accepting !== undefined && typeof v.accepting !== 'boolean') return { ok: false, why: 'accepting' };
  return { ok: true, ratio: clamp01(v.ratio), accepting: v.accepting !== false };
}

/**
 * @param {{ratio?:number, file?:string, log:object, everyMs?:number, read?:(path:string) => string}} o
 */
export function createRollout(o) {
  const base = { ratio: clamp01(Number(o.ratio) || 0), accepting: true, source: 'config' };
  const read = o.read || ((p) => readFileSync(p, 'utf8'));
  let state = base;
  let lastWarn = '';
  function load() {
    if (!o.file) return;
    let text;
    try { text = read(o.file); } catch (err) {
      if (err && err.code === 'ENOENT') { state = base; return; }
      warn(`read:${err && err.code}`);
      return;
    }
    const r = parseRollout(text);
    if (!r.ok) { warn(r.why); return; }   // 깨진 파일이면 마지막으로 읽은 값을 그대로 쓴다
    const next = { ratio: r.ratio, accepting: r.accepting, source: 'file' };
    if (next.ratio !== state.ratio || next.accepting !== state.accepting || state.source !== 'file') o.log.info(next, 'rollout changed');
    state = next;
    lastWarn = '';
  }
  function warn(why) {
    if (why === lastWarn) return;
    lastWarn = why;
    o.log.warn({ file: o.file, why }, 'rollout file ignored');
  }
  load();
  const timer = o.file ? setInterval(load, o.everyMs || 5000) : null;
  if (timer && timer.unref) timer.unref();
  return {
    current: () => ({ ...state }),
    reload: load,
    close() { if (timer) clearInterval(timer); }
  };
}
