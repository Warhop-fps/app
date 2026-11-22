/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 최근 값으로 재는 지표 도우미. 최근 틱 시간의 p50·p95·최대(고리 버퍼), 최근 몇 초의 초당 바이트·메시지(1초마다 찍는 누적값의 차),
 *          프로세스 CPU·메모리를 계산한다. /healthz와 /metrics가 같은 값을 보여 준다. 시계를 주입받아 시험한다.
 */

/**
 * 최근 size개 값의 분위수. 넣기는 O(1), 읽기는 정렬 한 번(읽기는 /metrics를 부를 때뿐이다).
 * @param {number} size
 */
export function createSampler(size = 900) {
  const buf = new Float64Array(size);
  let n = 0, at = 0;
  return {
    add(v) {
      buf[at] = v;
      at = (at + 1) % size;
      if (n < size) n++;
    },
    get count() { return n; },
    /** { p50, p95, max, n }. 값이 없으면 모두 0 */
    summary() {
      if (!n) return { p50: 0, p95: 0, max: 0, n: 0 };
      const s = Array.from(buf.subarray(0, n)).sort((a, b) => a - b);
      const q = (p) => s[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))];
      return { p50: q(0.5), p95: q(0.95), max: s[n - 1], n };
    },
    clear() { n = 0; at = 0; }
  };
}

/**
 * 누적값(예: 보낸 바이트 합)을 mark()로 찍어 두고 최근 windowSec초의 초당 증가량을 낸다.
 * @param {{windowSec?:number, now?:() => number}} [o]
 */
export function createRate({ windowSec = 10, now = () => performance.now() } = {}) {
  const marks = [];
  return {
    /** 지금의 누적값들 { bytes, msgs, ... } */
    mark(values) {
      marks.push({ t: now(), v: { ...values } });
      while (marks.length > windowSec + 1) marks.shift();
    },
    /** 키별 초당 증가량. 찍은 것이 둘보다 적으면 0 */
    perSec(key) {
      if (marks.length < 2) return 0;
      const a = marks[0], b = marks[marks.length - 1];
      const sec = (b.t - a.t) / 1000;
      return sec > 0 ? ((b.v[key] || 0) - (a.v[key] || 0)) / sec : 0;
    }
  };
}

/**
 * 프로세스 CPU(한 코어 = 100%)와 메모리. sample()을 1초마다 부르면 cpuPercent가 지난 간격의 사용률이다.
 * @param {{now?:() => number, cpuUsage?:typeof process.cpuUsage, memoryUsage?:typeof process.memoryUsage}} [o]
 */
export function createProcessStats({ now = () => performance.now(), cpuUsage = process.cpuUsage, memoryUsage = process.memoryUsage } = {}) {
  let lastCpu = cpuUsage();
  let lastAt = now();
  let cpuPercent = 0;
  return {
    sample() {
      const c = cpuUsage();
      const t = now();
      const usedMs = ((c.user - lastCpu.user) + (c.system - lastCpu.system)) / 1000;
      const ms = t - lastAt;
      if (ms > 0) cpuPercent = (usedMs / ms) * 100;
      lastCpu = c;
      lastAt = t;
    },
    read() {
      const m = memoryUsage();
      return { cpuPercent, rssBytes: m.rss, heapUsedBytes: m.heapUsed };
    }
  };
}
