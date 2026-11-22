/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 경기 끝 보상 계산(서버). 브라우저와 같은 순수 모듈(game/rules/summary.js의 matchSummary, account/economy.js의 matchReward·withQuickRespawns)로
 *          사람마다 summary와 보상을 만든다. 서버는 아직 포인트를 저장하지 않는다. 결과를 그 사람에게 알려 줄 뿐이다(docs/SERVER.md 11절).
 */
import { matchReward, quickRespawnCost, withQuickRespawns } from '../../js/account/economy.js';
import { matchSummary } from '../../js/game/rules/summary.js';

/** 멀티 즉시 부활 한 번의 값(킬 보상 한 번, 10 P) */
export const QUICK_RESPAWN_COST = quickRespawnCost(true);

/**
 * matchEnd 이벤트 하나 → 사람마다 { id, summary, reward, quick }.
 * @param {object} ev matchEnd 이벤트(match.js). 개인전은 ranking, 팀전은 stats·winner(팀)
 * @param {object} o
 * @param {Array<{id:string, team:string|null}>} o.players 지금 방에 있는 사람
 * @param {'team'|'ffa'} o.mode
 * @param {string} o.ruleset
 * @param {string} o.mapId
 * @param {number} [o.killTarget] 개인전 목표 킬
 * @param {number} [o.seconds] 경기 길이(초)
 * @param {Map<string,number>} [o.quick] 사람별 즉시 부활 횟수
 */
export function matchRewards(ev, o) {
  const out = [];
  if (!ev || ev.type !== 'matchEnd') return out;
  const view = o.mode === 'ffa' ? { rules: { killTarget: o.killTarget } } : null;
  for (const p of o.players) {
    const summary = matchSummary({
      view, event: ev, me: p.id, mode: o.mode, ruleset: o.ruleset, mapId: o.mapId, team: p.team, knifeKills: 0, seconds: o.seconds
    });
    if (!summary) continue;
    const n = (o.quick && o.quick.get(p.id)) || 0;
    const reward = withQuickRespawns(matchReward(summary), n, n * QUICK_RESPAWN_COST);
    out.push({ id: p.id, summary, reward, quick: n });
  }
  return out;
}
