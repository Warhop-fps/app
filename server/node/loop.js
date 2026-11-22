/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 고정 간격 서버 루프. 목표 시각을 1/hz초씩 늘려 가며 setTimeout으로 깨어나므로 늦게 깨어나도 평균 빈도가 밀리지 않고,
 *          크게 밀리면 몰아서 따라잡되 상한을 넘으면 그만큼 건너뛰고 알린다.
 */
/**
 * setInterval은 깨어나는 오차가 쌓여 30 Hz가 29.x Hz로 밀리고, Windows는 타이머 해상도가 약 15.6 ms라 한 번에 크게 늦기도 한다.
 * 그래서 "다음 틱 시각"을 기준으로 잠들고, 깨어났을 때 지난 틱을 모두(최대 maxCatchUp개) 돈다.
 */

/**
 * @param {{hz:number, step:() => void, now?:() => number, maxCatchUp?:number, onLag?:(behindMs:number, skipped:number) => void,
 *          setTimer?:typeof setTimeout, clearTimer?:typeof clearTimeout}} o
 */
export function createLoop({ hz, step, now = () => performance.now(), maxCatchUp = 5, onLag = null, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const period = 1000 / hz;
  let timer = null;
  let next = 0;
  let running = false;
  let ticks = 0;

  function run() {
    timer = null;
    if (!running) return;
    const t = now();
    let n = 0;
    while (t >= next && n < maxCatchUp) {
      step();
      ticks++;
      next += period;
      n++;
    }
    if (t - next > period) {
      // 따라잡지 못할 만큼 밀렸다(서버가 멈췄거나 과부하): 남은 틱을 버리고 지금부터 다시 센다
      const skipped = Math.floor((t - next) / period);
      if (onLag) onLag(t - next, skipped);
      next = t + period;
    }
    timer = setTimer(run, Math.max(0, next - now()));
  }

  return {
    start() {
      if (running) return;
      running = true;
      next = now();
      run();
    },
    stop() {
      running = false;
      if (timer) clearTimer(timer);
      timer = null;
    },
    get ticks() { return ticks; },
    get running() { return running; }
  };
}
