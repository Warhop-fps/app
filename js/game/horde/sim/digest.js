/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 좀비 물량 막기 시뮬레이션의 이벤트 줄을 짧은 지문(16자리 16진수)으로 줄인다. 같은 씨앗·같은 입력이면 같은 지문이 나와야 한다.
 *          node:crypto 없이 FNV-1a 두 벌로 계산해 브라우저·node·게임 서버가 같은 값을 낸다(보안용이 아니다).
 */
/**
 * const dg = createDigest();
 * dg.add(events);          // 이벤트 배열이나 아무 값(JSON으로 바꿀 수 있는 것)
 * dg.value                 // '0123456789abcdef'
 * dg.count                 // 넣은 항목 수
 */

/** 키 순서를 정렬한 JSON. 숫자는 그대로(같은 엔진이면 같은 글자), NaN·Infinity는 이름으로 남긴다 */
export function stableJson(v) {
  if (v === null || v === undefined) return 'null';
  const t = typeof v;
  if (t === 'number') return String(v);
  if (t === 'string') return JSON.stringify(v);
  if (t === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return '[' + v.map(stableJson).join(',') + ']';
  if (v instanceof Set) return stableJson([...v]);
  if (v instanceof Map) return stableJson([...v.entries()]);
  if (t === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson(v[k])).join(',') + '}';
  }
  return 'null';
}

const PRIME = 16777619;

/** 지문 계산기 */
export function createDigest() {
  let a = 2166136261 >>> 0;
  let b = 0x9747b28c >>> 0;
  let count = 0;
  function feed(str) {
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      a = Math.imul(a ^ (c & 0xff), PRIME) >>> 0;
      a = Math.imul(a ^ (c >>> 8), PRIME) >>> 0;
      b = Math.imul(b ^ c, PRIME) >>> 0;
      b = (b ^ (b >>> 13)) >>> 0;
    }
    a = Math.imul(a ^ 10, PRIME) >>> 0;   // 항목 사이 구분
    b = Math.imul(b ^ 10, PRIME) >>> 0;
  }
  return {
    add(v) {
      if (Array.isArray(v)) { for (const x of v) { feed(stableJson(x)); count++; } return; }
      feed(stableJson(v));
      count++;
    },
    get value() { return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0'); },
    get count() { return count; }
  };
}

/** 이벤트 배열 하나의 지문 */
export function digestOf(list) {
  const d = createDigest();
  d.add(list);
  return d.value;
}
