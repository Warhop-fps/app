/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 접속별 남용 막이. 메시지 속도 제한(토큰 버킷)과 위반 점수(시간이 지나면 줄어드는 누적 점수)를 계산한다. 시계를 주입받아 테스트한다.
 */

/**
 * 토큰 버킷. 초당 rate개씩 burst개까지 차고, 메시지 하나가 토큰 하나를 쓴다.
 * 순간 몰림(TCP가 밀렸다가 한꺼번에 보내는 경우)은 burst가 받아 주고, 평균 속도는 rate를 넘지 못한다.
 */
export class TokenBucket {
  /**
   * @param {number} rate 초당 채우는 토큰
   * @param {number} burst 최대 토큰
   * @param {() => number} [now] ms 시계
   */
  constructor(rate, burst, now = () => performance.now()) {
    this.rate = rate;
    this.burst = burst;
    this.now = now;
    this.tokens = burst;
    this.at = now();
  }

  /** n개를 쓸 수 있으면 쓰고 true. 모자라면 쓰지 않고 false */
  take(n = 1) {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.at) / 1000) * this.rate);
    this.at = t;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}

/**
 * 위반 점수. 위반마다 점수를 더하고, 점수는 초당 decay씩 줄어든다. limit 이상이면 끊을 때다.
 * 가끔 나오는 실수(깨진 메시지 한두 개)는 저절로 사라지고, 계속 쏟아붓는 접속만 끊긴다.
 * @param {{limit?:number, decayPerSec?:number, now?:() => number}} [opts]
 */
export function createStrikes({ limit = 20, decayPerSec = 1, now = () => performance.now() } = {}) {
  let score = 0;
  let at = now();
  const reasons = Object.create(null);
  function settle() {
    const t = now();
    score = Math.max(0, score - ((t - at) / 1000) * decayPerSec);
    at = t;
  }
  return {
    /** 점수를 더한다. 한도에 닿았으면 true */
    add(points, reason = 'other') {
      settle();
      score += points;
      reasons[reason] = (reasons[reason] || 0) + 1;
      return score >= limit;
    },
    score() { settle(); return score; },
    /** 이유별 횟수(로그용) */
    reasons: () => ({ ...reasons })
  };
}
