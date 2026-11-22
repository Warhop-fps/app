/*
 * Date: 06NOV2026
 * Author: Minkyu Jung
 * Purpose: 경기 결과 → 보상 계산용 요약(summary) 만들기. 브라우저 세션(game/session.js)과 게임 서버(server/core)가 함께 쓰는 순수 모듈이다.
 *          화면·네트워크를 모르고, 경기 스냅샷 뷰(match.applySnapshot 결과)와 matchEnd 이벤트만 읽는다.
 */
import { normalizeRuleset } from '../modes.js';

/** 결과표의 내 줄. matchEnd 뷰가 있으면 그것, 아니면 matchEnd 이벤트의 표(늦게 온 이벤트라 스냅샷이 없을 때) */
export function myStats(view, event, me) {
  const vp = view && Array.isArray(view.players) ? view.players.find((p) => p.id === me) : null;
  if (vp && view.phase === 'matchEnd') return vp;
  const ev = event && typeof event === 'object' ? event : {};
  const ranked = Array.isArray(ev.ranking) ? ev.ranking.find((r) => r && String(r.id) === me) : null;
  if (ranked) return ranked;
  const row = Array.isArray(ev.stats) ? ev.stats.find((r) => Array.isArray(r) && String(r[0]) === me) : null;
  if (row) return { kills: row[1], deaths: row[2], headshots: row[3], halfShots: row[5] };
  return vp;
}

/** FFA 목표 킬 수(view.rules.killTarget → view.killTarget → 20) */
export function ffaTarget(v) {
  const t = Number((v && v.rules && v.rules.killTarget) || (v && v.killTarget));
  return Number.isFinite(t) && t > 0 ? t : 20;
}

/**
 * 경기 결과 → account.recordMatch의 summary. 결과표에 내가 없으면 null.
 * 킬·데스·헤드샷·반샷은 방장(또는 서버)이 확정한 값이다(방장이 바뀌었으면 합산된 값). knifeKills만 내가 본 킬 이벤트로 세므로 킬 수를 넘지 못하게 자른다.
 * 개인전이면 그 경기의 목표 킬(killTarget)도 싣는다. 짧은 판의 승리 보상을 줄이는 데 쓴다(account/economy.js).
 * o: { view, event, me, mode, ruleset, mapId, team, knifeKills, seconds }
 */
export function matchSummary(o) {
  const me = String(o.me);
  const row = myStats(o.view, o.event, me);
  if (!row) return null;
  const ffa = o.mode === 'ffa';
  const res = (o.view && o.view.result) || o.event || {};
  const winner = res.winner == null || res.winner === 'draw' ? null : String(res.winner);
  const kills = row.kills | 0;
  return {
    online: true, ruleset: normalizeRuleset(o.ruleset), mode: ffa ? 'ffa' : o.mode === 'bomb' ? 'bomb' : 'team', mapId: o.mapId,
    kills, deaths: row.deaths | 0, headshots: row.headshots | 0, halfShots: row.halfShots | 0,
    knifeKills: Math.min(kills, o.knifeKills | 0),
    win: !!winner && winner === (ffa ? me : o.team), draw: !winner,
    seconds: Math.max(0, Math.round(Number(o.seconds) || 0)),
    ...(ffa ? { killTarget: ffaTarget(o.view) } : {})
  };
}
