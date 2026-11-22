/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 경기 끝 보상 계산(서버). 브라우저와 같은 순수 모듈(game/rules/summary.js의 matchSummary, account/economy.js의 matchReward·withQuickRespawns)로
 *          사람마다 summary와 보상을 만들고, 개인전이면 같은 값으로 서명할 경기 결과(docs/MATCH_RESULT_CONTRACT.md 1절)를 만든다(buildResult).
 *          포인트는 어댑터(server/node/results.js)가 서명한 결과를 API로 보내야 들어간다.
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

/** 결과 한 사람 포인트 상한(약속 1절)과 kills·deaths 상한 */
export const RESULT_MAX_POINTS = 2000;
const RESULT_MAX_COUNT = 10000;
const RESULT_MAX_PLAYERS = 32;
const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));

/**
 * 개인전 matchEnd + matchRewards 결과 → 약속 모양의 result(signedAt 없음). 토큰 해시가 없는 사람(손님)은 넣지 않는다. 넣을 사람이 없으면 null.
 * points = 보상(즉시 부활 값을 뺀 값)을 0~2000으로 자른 정수. placement = 순위표(ranking)의 등수, 없으면 null.
 * @param {object} ev matchEnd 이벤트
 * @param {Array<{id:string, summary:object, reward:{gained:number}}>} rewards matchRewards의 값
 * @param {{roomId:string, matchSeq:number, serverId:string, map:string, startedAt:number|null, endedAt:number, hashes:Map<string,string>}} o
 */
export function buildResult(ev, rewards, o) {
  const rank = new Map();
  for (const r of Array.isArray(ev && ev.ranking) ? ev.ranking : []) {
    if (r && r.id != null && Number.isInteger(r.rank)) rank.set(String(r.id), r.rank);
  }
  const players = [];
  const seen = new Set();
  for (const r of rewards) {
    const tokenHash = o.hashes.get(r.id);
    if (!tokenHash || seen.has(tokenHash) || players.length >= RESULT_MAX_PLAYERS) continue;   // 같은 기기로 두 번 들어오면 한 번만
    seen.add(tokenHash);
    const place = rank.get(r.id);
    players.push({
      tokenHash,
      kills: clampInt(r.summary.kills, 0, RESULT_MAX_COUNT),
      deaths: clampInt(r.summary.deaths, 0, RESULT_MAX_COUNT),
      placement: Number.isInteger(place) && place >= 1 && place <= 32 ? place : null,
      points: clampInt(r.reward && r.reward.gained, 0, RESULT_MAX_POINTS)
    });
  }
  if (!players.length) return null;
  const endedAt = Math.round(o.endedAt);
  const startedAt = Number.isFinite(o.startedAt) ? Math.min(Math.round(o.startedAt), endedAt) : endedAt;
  return {
    protocol: 1, resultId: `${o.roomId}:${o.matchSeq}`, roomId: o.roomId, matchSeq: o.matchSeq, serverId: o.serverId,
    mode: 'ffa', map: o.map, startedAt, endedAt, players
  };
}
